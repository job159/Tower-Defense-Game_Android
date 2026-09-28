package com.neonbastion.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.view.DisplayCutout;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Thin fullscreen WebView shell for Neon Bastion.
 *
 * <p>The web build ships inside the APK as assets/www/ and is served from a fixed virtual HTTPS
 * origin (https://appassets.androidplatform.net/), the same scheme androidx WebViewAssetLoader
 * uses: a real secure origin makes ES modules, fetch() and WebAssembly work (file:// does not),
 * and a constant origin keeps localStorage saves across app updates.
 *
 * <p>Page-side contract (every hook is optional):
 * <ul>
 *   <li>window.NativeBridge: isAndroid(), vibrate(ms), exitApp(), getVersion(), getVersionCode()
 *   <li>window.__nativeBack(): return true if the game consumed Back, otherwise the app closes
 *   <li>window.__nativePause() / window.__nativeResume(): activity lifecycle
 *   <li>window.__setSafeInsets(l, t, r, b), CSS vars --safe-left/top/right/bottom and a
 *       window.__safeInsets snapshot: display-cutout safe area in CSS px
 * </ul>
 */
public final class MainActivity extends Activity {

    private static final String TAG = "NeonBastion";

    /** Virtual origin. Never change it: localStorage (save data) is keyed by origin. */
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/www/index.html";

    private static final String BACK_JS = "(function(){try{return !!(window.__nativeBack && "
            + "window.__nativeBack());}catch(e){return false;}})()";

    private static final Map<String, String> MIME_TYPES = new HashMap<>();

    static {
        String[] pairs = {
            "html", "text/html", "htm", "text/html",
            "js", "text/javascript", "mjs", "text/javascript",
            "css", "text/css", "json", "application/json", "map", "application/json",
            "txt", "text/plain", "xml", "application/xml",
            "svg", "image/svg+xml", "png", "image/png", "jpg", "image/jpeg", "jpeg", "image/jpeg",
            "webp", "image/webp", "gif", "image/gif", "ico", "image/x-icon", "ktx2", "image/ktx2",
            "wasm", "application/wasm",
            "mp3", "audio/mpeg", "ogg", "audio/ogg", "wav", "audio/wav", "m4a", "audio/mp4",
            "mp4", "video/mp4", "webm", "video/webm",
            "woff", "font/woff", "woff2", "font/woff2", "ttf", "font/ttf", "otf", "font/otf",
            "glb", "model/gltf-binary", "gltf", "model/gltf+json", "bin", "application/octet-stream",
        };
        for (int i = 0; i < pairs.length; i += 2) MIME_TYPES.put(pairs[i], pairs[i + 1]);
    }

    /** Uptime of the last renderer crash; a second crash within 10 s stops the recreate loop. */
    private static long lastRendererCrash;

    private WebView webView;

    /** Display-cutout safe insets in CSS px: left, top, right, bottom. */
    private final int[] safeInsets = new int[4];

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        setVolumeControlStream(AudioManager.STREAM_MUSIC); // volume keys always drive game audio

        try {
            if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect on -Debug builds
            }
            webView = new WebView(this);
        } catch (RuntimeException e) { // WebView provider missing, disabled or mid-update
            Log.e(TAG, "Cannot create WebView", e);
            Toast.makeText(this, R.string.webview_unavailable, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        configureWebView(webView);
        setContentView(webView);
        enterImmersive();
        registerBackHandler();
        webView.loadUrl(START_URL);
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("window.__nativePause && window.__nativePause()", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersive();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.__nativeResume && window.__nativeResume()", null);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive(); // bars come back after dialogs / swipes
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- WebView setup

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view) {
        view.setBackgroundColor(Color.BLACK);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Consuming long-press keeps it from reaching the page: no text selection, no context menu.
        view.setOnLongClickListener(v -> true);
        view.setLongClickable(false);
        view.setHapticFeedbackEnabled(false);

        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100); // ignore the system font-size setting
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true); // honor <meta name="viewport">
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSafeBrowsingEnabled(false); // everything is bundled; foreign URLs go to the browser

        view.addJavascriptInterface(new NativeBridge(), "NativeBridge");
        view.setWebViewClient(new AssetWebViewClient());
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.messageLevel() + " " + m.message()
                        + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        view.setOnApplyWindowInsetsListener((v, insets) -> {
            if (readSafeInsets(insets)) pushSafeInsets();
            return v.onApplyWindowInsets(insets);
        });
    }

    private void destroyWebView() {
        WebView view = webView;
        if (view == null) return;
        webView = null;
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.destroy();
    }

    /** Serves https://appassets.androidplatform.net/{path} from assets/{path}; keeps navigation in-app. */
    private final class AssetWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            // Anything else is left to WebView (the game never requests foreign URLs).
            return isAppUrl(url) ? openAsset(url) : null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isAppUrl(url) || "about".equals(url.getScheme())) return false;
            // Foreign URLs never load in the game view. Links the player taps open in the browser;
            // automatic sub-frame navigations are simply dropped.
            if (request.isForMainFrame() || request.hasGesture()) openExternally(url);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            readSafeInsets(view.getRootWindowInsets());
            pushSafeInsets(); // the new document has no CSS vars yet, so always push
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(TAG, "WebView renderer gone (crashed=" + detail.didCrash() + ")");
            destroyWebView(); // a WebView whose renderer died must never be touched again
            long now = SystemClock.elapsedRealtime();
            boolean crashLoop = lastRendererCrash != 0 && now - lastRendererCrash < 10_000;
            lastRendererCrash = now;
            if (crashLoop) finish(); else recreate();
            return true; // handled: keep the app process alive
        }
    }

    private static boolean isAppUrl(Uri url) {
        return "https".equals(url.getScheme()) && APP_HOST.equals(url.getAuthority());
    }

    /** Opens assets/{path}; getPath() is already decoded and free of query string and fragment. */
    private WebResourceResponse openAsset(Uri url) {
        String path = url.getPath();
        if (path == null || path.isEmpty()) path = "/";
        if (path.endsWith("/")) path += "index.html";
        path = path.substring(1);
        if (("/" + path + "/").contains("/../")) return notFound();
        try {
            InputStream in = getAssets().open(path);
            String mime = mimeTypeOf(path);
            return new WebResourceResponse(mime, isText(mime) ? "utf-8" : null, in);
        } catch (IOException e) {
            Log.w(TAG, "404 " + path);
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeTypeOf(String path) {
        String name = path.substring(path.lastIndexOf('/') + 1);
        int dot = name.lastIndexOf('.');
        String mime = dot < 0 ? null : MIME_TYPES.get(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return mime != null ? mime : "application/octet-stream";
    }

    private static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("xml");
    }

    private void openExternally(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (RuntimeException e) { // no handler, or a URI Android refuses to share (file:)
            Log.w(TAG, "Cannot open " + url, e);
        }
    }

    // ---------------------------------------------------------------- fullscreen + safe area

    @SuppressWarnings("deprecation") // systemUiVisibility flags are the only option below API 30
    private void enterImmersive() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    /** Stores the display-cutout safe insets in CSS px; returns true if they changed. */
    private boolean readSafeInsets(WindowInsets insets) {
        int[] px = new int[4];
        if (Build.VERSION.SDK_INT >= 28 && insets != null) {
            DisplayCutout cutout = insets.getDisplayCutout();
            if (cutout != null) {
                px[0] = cutout.getSafeInsetLeft();
                px[1] = cutout.getSafeInsetTop();
                px[2] = cutout.getSafeInsetRight();
                px[3] = cutout.getSafeInsetBottom();
            }
        }
        float density = getResources().getDisplayMetrics().density; // 1 CSS px == 1 dp
        for (int i = 0; i < 4; i++) px[i] = Math.round(px[i] / density);
        if (Arrays.equals(px, safeInsets)) return false;
        System.arraycopy(px, 0, safeInsets, 0, 4);
        return true;
    }

    /** Publishes the insets as CSS custom properties, window.__safeInsets and __setSafeInsets(). */
    private void pushSafeInsets() {
        if (webView == null) return;
        webView.evaluateJavascript(String.format(Locale.ROOT,
                "(function(l,t,r,b){var e=document.documentElement;if(!e)return;var s=e.style;"
                        + "s.setProperty('--safe-left',l+'px');s.setProperty('--safe-top',t+'px');"
                        + "s.setProperty('--safe-right',r+'px');s.setProperty('--safe-bottom',b+'px');"
                        + "window.__safeInsets={left:l,top:t,right:r,bottom:b};"
                        + "if(window.__setSafeInsets)window.__setSafeInsets(l,t,r,b);})(%d,%d,%d,%d)",
                safeInsets[0], safeInsets[1], safeInsets[2], safeInsets[3]), null);
    }

    // ---------------------------------------------------------------- back button

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= 33) { // needs android:enableOnBackInvokedCallback="true"
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    /** API 26-32 path; on 33+ Back is delivered to the OnBackInvokedCallback instead. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    /** Offers Back to the game first; anything but a literal true closes the app. */
    private void handleBack() {
        if (webView == null) {
            finish();
            return;
        }
        webView.evaluateJavascript(BACK_JS, result -> {
            if (!"true".equals(result)) finish();
        });
    }

    // ---------------------------------------------------------------- JS bridge

    /** Exposed as window.NativeBridge. WebView calls these on a background thread. */
    public final class NativeBridge {
        private final Vibrator vibrator = getSystemService(Vibrator.class);
        private final String versionName;
        private final int versionCode;

        @SuppressWarnings("deprecation") // getPackageInfo(String, int) and versionCode (API < 28)
        NativeBridge() {
            String name = "";
            int code = 0;
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                if (info.versionName != null) name = info.versionName;
                code = Build.VERSION.SDK_INT >= 28 ? (int) info.getLongVersionCode() : info.versionCode;
            } catch (PackageManager.NameNotFoundException e) {
                Log.w(TAG, "Cannot read own package info", e);
            }
            versionName = name;
            versionCode = code;
        }

        @JavascriptInterface
        public boolean isAndroid() {
            return true;
        }

        /** One-shot vibration clamped to 1..400 ms; silently ignored without a vibrator. */
        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                if (vibrator == null || !vibrator.hasVibrator()) return;
                int duration = Math.max(1, Math.min(400, ms));
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (RuntimeException ignored) {
                // vibration refused by the system: not worth surfacing to the game
            }
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finish);
        }

        @JavascriptInterface
        public String getVersion() {
            return versionName;
        }

        @JavascriptInterface
        public int getVersionCode() {
            return versionCode;
        }
    }
}
