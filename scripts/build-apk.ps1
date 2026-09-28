<#
.SYNOPSIS
    Packages the static web build into a signed Android APK, without Gradle.

.DESCRIPTION
    aapt2 compile/link (manifest + resources) -> javac -> d8 -> zip in classes.dex and
    assets/www/** -> zipalign -> apksigner sign -> apksigner verify.

    Needs JDK 17+ (JAVA_HOME or %LOCALAPPDATA%\Programs\jdk-17) and an Android SDK
    (ANDROID_HOME / ANDROID_SDK_ROOT or %LOCALAPPDATA%\Android\Sdk) with build-tools and
    platforms;android-35. Environment changes are confined to this script run.

    The first run creates android\keystore\release.jks plus keystore.properties (random
    password). Keep both safe: every future update must be signed with that same key.

.PARAMETER WebDir
    Static site to package (must contain index.html). Default: <repo>\dist\www

.PARAMETER Out
    Output APK path. Default: <repo>\dist\NeonBastion.apk

.PARAMETER Debug
    Mark the APK debuggable (aapt2 --debug-mode); enables chrome://inspect for the WebView.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-apk.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -WebDir C:\tmp\www -Out C:\tmp\test.apk -Debug
#>
param(
    [string]$WebDir,
    [string]$Out,
    [switch]$Debug
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$PackageName = 'com.neonbastion.game'
$MinSdk = 26
$TargetSdk = 35
$KeyAlias = 'neonbastion'

# Assets that are already compressed are stored as-is (same idea as aapt2's no-compress list).
$StoredExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp3', '.ogg', '.oga', '.opus',
    '.m4a', '.aac', '.mp4', '.webm', '.woff', '.woff2', '.ktx2', '.basis', '.zip', '.gz', '.br')

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AndroidSrc = Join-Path $RepoRoot 'android\app\src\main'
$KeystoreDir = Join-Path $RepoRoot 'android\keystore'
$BuildDir = Join-Path $RepoRoot 'build\apk'

# ------------------------------------------------------------------ helpers

function Write-Step([string]$Text) {
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Resolve-UserPath([string]$Path) {
    # Relative to the PowerShell location (not the process cwd); the target may not exist yet.
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

# Runs a native tool; its output is echoed indented, a non-zero exit code aborts the build.
function Invoke-Tool([string]$Name, [string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue' # stderr lines must not become terminating errors (PS 5.1)
    try {
        $output = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    foreach ($line in $output) { if ($line.Trim()) { Write-Host "    $line" } }
    if ($code -ne 0) { throw "$Name failed (exit code $code)" }
}

function Get-JavaMajor([string]$JdkHome) {
    $release = Join-Path $JdkHome 'release'
    if (-not (Test-Path -LiteralPath $release)) { return 0 }
    $m = Select-String -LiteralPath $release -Pattern '^JAVA_VERSION="(\d+)(?:\.(\d+))?' | Select-Object -First 1
    if (-not $m) { return 0 }
    $major = [int]$m.Matches[0].Groups[1].Value
    if ($major -eq 1) { $major = [int]$m.Matches[0].Groups[2].Value } # 1.8 -> 8
    return $major
}

function Find-Jdk {
    $candidates = @($env:JAVA_HOME, (Join-Path $env:LOCALAPPDATA 'Programs\jdk-17'))
    foreach ($dir in $candidates) {
        if (-not $dir -or -not (Test-Path -LiteralPath (Join-Path $dir 'bin\javac.exe'))) { continue }
        if ((Get-JavaMajor $dir) -ge 17) { return (Resolve-Path -LiteralPath $dir).Path }
        Write-Host "    skipping $dir (JDK 17+ required)" -ForegroundColor DarkYellow
    }
    throw 'JDK 17+ not found. Set JAVA_HOME or unpack a JDK to %LOCALAPPDATA%\Programs\jdk-17.'
}

function Find-Sdk {
    $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'build-tools'))) { return (Resolve-Path -LiteralPath $dir).Path }
    }
    throw 'Android SDK not found. Set ANDROID_HOME or install it to %LOCALAPPDATA%\Android\Sdk.'
}

function Find-BuildTools([string]$Sdk) {
    $required = @('aapt2.exe', 'zipalign.exe', 'lib\d8.jar', 'lib\apksigner.jar')
    $best = Get-ChildItem -LiteralPath (Join-Path $Sdk 'build-tools') -Directory |
        Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' } |
        Where-Object { $dir = $_.FullName; @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dir $_)) }).Count -eq 0 } |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $best) { throw "No usable build-tools in $Sdk\build-tools (install e.g. build-tools;35.0.0)." }
    return $best
}

function Find-Platform([string]$Sdk) {
    $preferred = Join-Path $Sdk "platforms\android-$TargetSdk"
    if (Test-Path -LiteralPath (Join-Path $preferred 'android.jar')) { return Get-Item -LiteralPath $preferred }
    $best = Get-ChildItem -LiteralPath (Join-Path $Sdk 'platforms') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^android-(\d+)(\.\d+)?$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'android.jar')) } |
        Sort-Object { $n = $_.Name.Substring(8); if ($n -notmatch '\.') { $n += '.0' }; [version]$n } -Descending |
        Select-Object -First 1
    if (-not $best) { throw "No Android platform in $Sdk\platforms (install platforms;android-$TargetSdk)." }
    Write-Host "    android-$TargetSdk not installed, compiling against $($best.Name)" -ForegroundColor DarkYellow
    return $best
}

function Get-AppVersion {
    $json = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
    $prop = $json.PSObject.Properties['version']
    $name = if ($prop) { [string]$prop.Value } else { '' }
    if ($name -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "package.json version '$name' is not major.minor.patch." }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]
    if ($minor -gt 99 -or $patch -gt 99) { throw "Version ${name}: minor and patch must be <= 99 (versionCode = major*10000 + minor*100 + patch)." }
    $code = $major * 10000 + $minor * 100 + $patch
    if ($code -lt 1) { throw 'versionCode must be >= 1 (version 0.0.0 is not allowed).' }
    return @{ Name = $name; Code = $code }
}

function New-RandomPassword([int]$Length) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $limit = 256 - (256 % $chars.Length) # rejection sampling: no modulo bias
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buffer = New-Object byte[] 64
    $sb = New-Object System.Text.StringBuilder
    try {
        while ($sb.Length -lt $Length) {
            $rng.GetBytes($buffer)
            foreach ($b in $buffer) {
                if ($b -lt $limit -and $sb.Length -lt $Length) { [void]$sb.Append($chars[$b % $chars.Length]) }
            }
        }
    } finally {
        $rng.Dispose()
    }
    return $sb.ToString()
}

function Read-Properties([string]$Path) {
    $map = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#') -or $t.StartsWith('!')) { continue }
        $i = $t.IndexOf('=')
        if ($i -gt 0) { $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim() }
    }
    return $map
}

# Creates the release key on first run; returns @{ File; Alias } and puts the passwords in
# NB_KS_PASS / NB_KEY_PASS so they never appear on a command line.
function Initialize-Keystore([string]$Keytool) {
    $propsFile = Join-Path $KeystoreDir 'keystore.properties'
    $defaultStore = Join-Path $KeystoreDir 'release.jks'

    if (-not (Test-Path -LiteralPath $propsFile)) {
        if (Test-Path -LiteralPath $defaultStore) {
            throw "$defaultStore exists but keystore.properties is missing; restore it from your backup."
        }
        Write-Host '    creating a new release key (android\keystore\release.jks)' -ForegroundColor Yellow
        New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null
        $password = New-RandomPassword 32
        $text = "# Neon Bastion signing key. Back up this folder and keep it private:`n" +
            "# every update must be signed with the same key or it will not install over the old version.`n" +
            "storeFile=release.jks`nstorePassword=$password`nkeyPassword=$password`nkeyAlias=$KeyAlias`n"
        [System.IO.File]::WriteAllText($propsFile, $text, (New-Object System.Text.UTF8Encoding($false)))
        $env:NB_KS_PASS = $password
        try {
            Invoke-Tool 'keytool' $Keytool @('-J-Duser.language=en', '-J-Duser.country=US', # no localized mojibake
                '-genkeypair', '-keystore', $defaultStore, '-storetype', 'PKCS12',
                '-alias', $KeyAlias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
                '-dname', 'CN=Neon Bastion', '-storepass:env', 'NB_KS_PASS', '-keypass:env', 'NB_KS_PASS')
        } catch {
            Remove-Item -LiteralPath $propsFile -Force -ErrorAction SilentlyContinue
            throw
        }
    }

    $props = Read-Properties $propsFile
    foreach ($key in @('storePassword', 'keyPassword', 'keyAlias')) {
        if (-not $props.ContainsKey($key) -or -not $props[$key]) { throw "keystore.properties has no $key." }
    }
    $store = if ($props.ContainsKey('storeFile') -and $props['storeFile']) { $props['storeFile'] } else { 'release.jks' }
    if (-not [System.IO.Path]::IsPathRooted($store)) { $store = Join-Path $KeystoreDir $store }
    if (-not (Test-Path -LiteralPath $store)) {
        throw "Keystore $store is missing but keystore.properties exists. Restore it from your backup; a new key cannot update installed copies."
    }
    $env:NB_KS_PASS = $props['storePassword']
    $env:NB_KEY_PASS = $props['keyPassword']
    return @{ File = $store; Alias = $props['keyAlias'] }
}

# Adds classes.dex and assets/www/** to the APK written by aapt2. Update mode copies aapt2's
# entries verbatim, so resources.arsc stays stored (uncompressed) as Android 11+ requires.
# (aapt2 -A is not used: on Windows it writes asset names with backslashes and rejects
# non-ASCII file names.)
function Add-ApkEntries([string]$Apk, [string]$DexFile, [string]$WebRoot) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $optimal = [System.IO.Compression.CompressionLevel]::Optimal
    $store = [System.IO.Compression.CompressionLevel]::NoCompression
    $count = 0
    $skipped = 0
    $zip = [System.IO.Compression.ZipFile]::Open($Apk, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $DexFile, 'classes.dex', $optimal)
        $rootLength = $WebRoot.TrimEnd('\').Length + 1
        foreach ($file in Get-ChildItem -LiteralPath $WebRoot -Recurse -File -Force) {
            $relative = $file.FullName.Substring($rootLength).Replace('\', '/')
            if (@($relative.Split('/') | Where-Object { $_.StartsWith('.') }).Count -gt 0) { $skipped++; continue } # .DS_Store, .git...
            $level = if ($StoredExtensions -contains $file.Extension.ToLowerInvariant()) { $store } else { $optimal }
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "assets/www/$relative", $level)
            $count++
        }
    } finally {
        $zip.Dispose()
    }
    return @{ Assets = $count; Skipped = $skipped }
}

# ------------------------------------------------------------------ build

function Invoke-Build {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $webRoot = if ($WebDir) { Resolve-UserPath $WebDir } else { Join-Path $RepoRoot 'dist\www' }
    $outFile = if ($Out) { Resolve-UserPath $Out } else { Join-Path $RepoRoot 'dist\NeonBastion.apk' }
    $indexHtml = Join-Path $webRoot 'index.html'
    if (-not (Test-Path -LiteralPath $indexHtml -PathType Leaf)) {
        throw "No index.html in $webRoot. Build the web app first (npm run build:web) or pass -WebDir <folder>."
    }
    # Root-absolute URLs would resolve to https://appassets.androidplatform.net/x instead of /www/x.
    $absolute = Select-String -LiteralPath $indexHtml -Pattern '(src|href)\s*=\s*["'']/(?!/)' -AllMatches
    if ($absolute) {
        Write-Host "WARNING: index.html uses root-absolute URLs (e.g. src=""/..."") that will 404 inside the APK; use relative paths:" -ForegroundColor Yellow
        $absolute | ForEach-Object { Write-Host "    line $($_.LineNumber): $($_.Line.Trim())" -ForegroundColor Yellow }
    }

    $version = Get-AppVersion
    $jdk = Find-Jdk
    $sdk = Find-Sdk
    $buildTools = Find-BuildTools $sdk
    $platform = Find-Platform $sdk
    $bt = $buildTools.FullName
    $androidJar = Join-Path $platform.FullName 'android.jar'
    $java = Join-Path $jdk 'bin\java.exe'

    $env:JAVA_HOME = $jdk
    $env:PATH = "$jdk\bin;$bt;$env:PATH"

    Write-Host ''
    Write-Host 'NEON BASTION  APK build' -ForegroundColor Magenta
    Write-Host "  web dir     : $webRoot"
    Write-Host "  version     : $($version.Name) (versionCode $($version.Code))$(if ($Debug) { ', DEBUGGABLE' })"
    Write-Host "  JDK         : $jdk"
    Write-Host "  SDK         : $sdk  ($($platform.Name), build-tools $($buildTools.Name))"
    Write-Host ''

    Write-Step 'Preparing build\apk'
    if (Test-Path -LiteralPath $BuildDir) { Remove-Item -LiteralPath $BuildDir -Recurse -Force }
    $classesDir = Join-Path $BuildDir 'classes'
    $genDir = Join-Path $BuildDir 'gen'
    $dexDir = Join-Path $BuildDir 'dex'
    foreach ($dir in @($classesDir, $genDir, $dexDir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # The source manifest has no package attribute (AGP style); inject it for aapt2.
    $manifest = New-Object System.Xml.XmlDocument
    $manifest.PreserveWhitespace = $true
    $manifest.Load((Join-Path $AndroidSrc 'AndroidManifest.xml'))
    if (-not $manifest.DocumentElement.HasAttribute('package')) {
        $manifest.DocumentElement.SetAttribute('package', $PackageName)
    }
    $stagedManifest = Join-Path $BuildDir 'AndroidManifest.xml'
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $writer = [System.Xml.XmlWriter]::Create($stagedManifest, $settings)
    try { $manifest.Save($writer) } finally { $writer.Dispose() }

    Write-Step 'aapt2: compiling resources'
    $resZip = Join-Path $BuildDir 'resources.zip'
    Invoke-Tool 'aapt2 compile' (Join-Path $bt 'aapt2.exe') @('compile', '--dir', (Join-Path $AndroidSrc 'res'), '-o', $resZip)

    Write-Step 'aapt2: linking manifest + resources'
    $baseApk = Join-Path $BuildDir 'base.apk'
    $linkArgs = @('link', '-o', $baseApk, '-I', $androidJar, '--manifest', $stagedManifest,
        '--min-sdk-version', "$MinSdk", '--target-sdk-version', "$TargetSdk",
        '--version-code', "$($version.Code)", '--version-name', $version.Name, '--java', $genDir)
    if ($Debug) { $linkArgs += '--debug-mode' }
    Invoke-Tool 'aapt2 link' (Join-Path $bt 'aapt2.exe') ($linkArgs + @($resZip))

    Write-Step 'javac'
    $sources = @(Get-ChildItem -LiteralPath (Join-Path $AndroidSrc 'java'), $genDir -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
    Invoke-Tool 'javac' (Join-Path $jdk 'bin\javac.exe') (@('-encoding', 'UTF-8', '--release', '8',
        '-Xlint:deprecation', '-Xlint:unchecked', '-classpath', $androidJar, '-d', $classesDir) + $sources)

    Write-Step 'd8: dexing'
    $classFiles = @(Get-ChildItem -LiteralPath $classesDir -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
    Invoke-Tool 'd8' $java (@('-Xmx1g', '-cp', (Join-Path $bt 'lib\d8.jar'), 'com.android.tools.r8.D8',
        '--release', '--min-api', "$MinSdk", '--lib', $androidJar, '--output', $dexDir) + $classFiles)

    Write-Step 'Packaging classes.dex + web assets'
    $unalignedApk = Join-Path $BuildDir 'unaligned.apk'
    Copy-Item -LiteralPath $baseApk -Destination $unalignedApk
    $added = Add-ApkEntries $unalignedApk (Join-Path $dexDir 'classes.dex') $webRoot
    $note = if ($added.Skipped) { " (skipped $($added.Skipped) dotfiles)" } else { '' }
    Write-Host "    $($added.Assets) files -> assets/www/$note"

    Write-Step 'zipalign'
    $alignedApk = Join-Path $BuildDir 'aligned.apk'
    Invoke-Tool 'zipalign' (Join-Path $bt 'zipalign.exe') @('-p', '-f', '4', $unalignedApk, $alignedApk)

    Write-Step 'apksigner: signing'
    $key = Initialize-Keystore (Join-Path $jdk 'bin\keytool.exe')
    $signedApk = Join-Path $BuildDir 'signed.apk'
    $apksigner = Join-Path $bt 'lib\apksigner.jar'
    Invoke-Tool 'apksigner sign' $java @('-jar', $apksigner, 'sign', '--ks', $key.File, '--ks-key-alias', $key.Alias,
        '--ks-pass', 'env:NB_KS_PASS', '--key-pass', 'env:NB_KEY_PASS', '--v4-signing-enabled', 'false',
        '--out', $signedApk, $alignedApk)

    Write-Step 'Verifying'
    Invoke-Tool 'apksigner verify' $java @('-jar', $apksigner, 'verify', $signedApk)
    Invoke-Tool 'zipalign check' (Join-Path $bt 'zipalign.exe') @('-c', '-p', '4', $signedApk)

    $outDir = Split-Path -Parent $outFile
    if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    Copy-Item -LiteralPath $signedApk -Destination $outFile -Force
    $size = (Get-Item -LiteralPath $outFile).Length
    $sizeText = if ($size -ge 1MB) { '{0:N2} MB' -f ($size / 1MB) } else { '{0:N0} KB' -f ($size / 1KB) }

    Write-Host ''
    Write-Host "APK ready: $outFile  ($sizeText, $([int]$clock.Elapsed.TotalSeconds)s)" -ForegroundColor Green
}

$savedEnv = @{}
foreach ($name in @('JAVA_HOME', 'PATH', 'NB_KS_PASS', 'NB_KEY_PASS')) {
    $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$exitCode = 0
try {
    Invoke-Build
} catch {
    Write-Host ''
    Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    # Leave the caller's session exactly as it was (and drop the signing passwords).
    foreach ($name in $savedEnv.Keys) {
        if ($null -eq $savedEnv[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item -LiteralPath "Env:$name" -Value $savedEnv[$name] }
    }
}
exit $exitCode
