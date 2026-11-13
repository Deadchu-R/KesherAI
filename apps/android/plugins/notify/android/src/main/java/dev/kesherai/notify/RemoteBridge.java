package dev.kesherai.notify;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebView;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashSet;
import java.util.Set;

/**
 * Gives the computer's pages the app's native parts (notifications, voice, the app's updates).
 *
 * Capacitor 8 adds its bridge script only to the app's own pages, so the KesherAI interface a computer serves
 * had none of the native parts: that is why the phone never set up its notifications from there. Here the script
 * and the message channel are added for the computers the user paired, by exact origin and for the main frame
 * only (never "*": a page a link leads to, or a frame inside the interface, gets nothing).
 *
 * It reaches two private parts of Capacitor by reflection (the script and the message handler); when a later
 * Capacitor changes them, this does nothing and the app works as before.
 */
final class RemoteBridge {
    private RemoteBridge() {}

    private static final String PREF = "bridgeOrigins";
    private static ScriptHandler script;
    private static boolean listening;

    /** scheme://host[:port] of an http(s) address, or null. */
    static String origin(String url) {
        try {
            Uri u = Uri.parse(url);
            String s = u.getScheme();
            if (u.getHost() == null || !("http".equals(s) || "https".equals(s))) return null;
            return s + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return null;
        }
    }

    static Set<String> saved(Context c) {
        return new HashSet<>(Prefs.of(c).getStringSet(PREF, new HashSet<>()));
    }

    /** Keeps the list and applies it. Call on the UI thread. Returns what went wrong, or null. */
    static String allow(Bridge bridge, Set<String> origins) {
        Prefs.of(bridge.getContext()).edit().putStringSet(PREF, new HashSet<>(origins)).apply();
        return apply(bridge);
    }

    /** Applies the kept list (at start, and after it changes). Call on the UI thread. */
    static String apply(Bridge bridge) {
        Set<String> origins = saved(bridge.getContext());
        if (origins.isEmpty()) return null;
        WebView web = bridge.getWebView();
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                return "This phone's WebView is too old for the app's native parts on the computer's pages. Update \"Android System WebView\".";
            }
            Method get = Bridge.class.getDeclaredMethod("getJSInjector");
            get.setAccessible(true);
            Object injector = get.invoke(bridge);
            Method text = injector.getClass().getDeclaredMethod("getScriptString");
            text.setAccessible(true);
            String js = (String) text.invoke(injector);

            Field handlerField = Bridge.class.getDeclaredField("msgHandler");
            handlerField.setAccessible(true);
            Object handler = handlerField.get(bridge);
            Method post = handler.getClass().getDeclaredMethod("postMessage", String.class);
            Field reply = handler.getClass().getDeclaredField("javaScriptReplyProxy");
            reply.setAccessible(true);

            // The message channel: the app's own pages and the paired computers, main frame only.
            Set<String> rules = new HashSet<>(origins);
            rules.add(bridge.getScheme() + "://" + bridge.getHost());
            if (listening) WebViewCompat.removeWebMessageListener(web, "androidBridge");
            else {
                try {
                    WebViewCompat.removeWebMessageListener(web, "androidBridge");
                } catch (Exception e) {
                    // Capacitor fell back to a JavaScript interface
                }
                web.removeJavascriptInterface("androidBridge");
            }
            WebViewCompat.addWebMessageListener(web, "androidBridge", rules, (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame) return;
                try {
                    reply.set(handler, replyProxy);
                    post.invoke(handler, message.getData());
                } catch (Exception e) {
                    // the call gets no answer
                }
            });
            listening = true;

            if (script != null) script.remove();
            script = WebViewCompat.addDocumentStartJavaScript(web, js, origins);
            return null;
        } catch (Throwable t) {
            return String.valueOf(t.getMessage() != null ? t.getMessage() : t);
        }
    }
}
