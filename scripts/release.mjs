#!/usr/bin/env node
// Publishes dist/NeonBastion.apk as the GitHub Release v<package.json version>.
//
// The APK is signed on this PC with android/keystore/ (never committed), so releases are made locally:
//   npm run build                      (web build + signed APK)
//   npm run release -- --notes "..."   (creates the release, or replaces the APK of an existing one)
// The public download page always links to /releases/latest/download/NeonBastion.apk, so the QR code
// never changes. Requires the GitHub CLI (gh) logged in to an account that can push to the repository.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const APK = path.join(ROOT, 'dist', 'NeonBastion.apk');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { values: args } = parseArgs({ options: { notes: { type: 'string' }, draft: { type: 'boolean' } } });

function findGh() {
  const candidates = ['gh'];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) candidates.push(path.join(base, 'GitHub CLI', 'gh.exe'));
    }
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch { /* try the next one */ }
  }
  console.error('GitHub CLI (gh) not found: install it from https://cli.github.com/ and run `gh auth login`.');
  process.exit(1);
}

if (!fs.existsSync(APK)) {
  console.error('dist/NeonBastion.apk is missing: run `npm run build` first.');
  process.exit(1);
}
const gh = findGh();
const run = (argv) => execFileSync(gh, argv, { cwd: ROOT, stdio: 'inherit' });
const tag = `v${pkg.version}`;
let exists = true;
try {
  execFileSync(gh, ['release', 'view', tag], { cwd: ROOT, stdio: 'ignore' });
} catch {
  exists = false;
}
if (exists) {
  console.log(`Release ${tag} exists: replacing its APK.`);
  run(['release', 'upload', tag, APK, '--clobber']);
} else {
  const notes = args.notes || `霓虹防線 NEON BASTION ${tag}\n\n下載下方的 NeonBastion.apk 安裝（Android 8.0 以上），或在瀏覽器直接玩：${pkg.homepage}play/`;
  run(['release', 'create', tag, APK, '--title', `霓虹防線 ${tag}`, '--notes', notes, ...(args.draft ? ['--draft'] : ['--latest'])]);
}
console.log(`Done: ${pkg.homepage}`);
