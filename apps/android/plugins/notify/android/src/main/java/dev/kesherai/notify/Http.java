package dev.kesherai.notify;

import android.content.Context;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Small requests from the phone to the computer, with this phone's own key. */
final class Http {
    private Http() {}

    /**
     * Sends one request (on the calling thread; never the main thread).
     *
     * @return The status, or -1 when the computer could not be reached.
     */
    static int send(Context c, String method, String path, String json) {
        String base = Prefs.base(c);
        if (base.isEmpty()) return -1;
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(base.replaceAll("/+$", "") + "/" + path.replaceAll("^/+", "")).openConnection();
            h.setRequestMethod(method);
            h.setConnectTimeout(10000);
            h.setReadTimeout(15000);
            h.setInstanceFollowRedirects(false);
            String key = Prefs.key(c);
            if (!key.isEmpty()) h.setRequestProperty("Authorization", "Bearer " + key);
            if (json != null) {
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = h.getOutputStream()) {
                    o.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
            return h.getResponseCode();
        } catch (Exception e) {
            return -1;
        } finally {
            if (h != null) h.disconnect();
        }
    }

    /** The same, on a background thread. */
    static void later(Context c, String method, String path, String json) {
        Context app = c.getApplicationContext();
        new Thread(() -> send(app, method, path, json), "kesher-http").start();
    }
}
