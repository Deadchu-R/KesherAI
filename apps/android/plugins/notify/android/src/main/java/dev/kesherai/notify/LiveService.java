package dev.kesherai.notify;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The live connection (like Home Assistant's "persistent connection"): an event stream from the
 * computer, held by a foreground service, so notifications arrive without any other app. Android
 * requires its fixed notification; its channel is the quietest one and can be hidden. When the
 * computer cannot be reached, it tries again (5 s, growing to 60 s) and UnifiedPush delivers meanwhile.
 */
public class LiveService extends Service {
    static final int ID = 7422;
    /** Whether the stream is open now (for the app's settings). */
    static volatile boolean connected;
    private volatile boolean running;
    private volatile HttpURLConnection current;
    private Thread thread;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notes.channels(this);
        Notification n = note(false);
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(ID, n);
        if (thread == null) {
            running = true;
            thread = new Thread(this::loop, "kesher-live");
            thread.start();
        }
        return START_STICKY;
    }

    private Notification note(boolean on) {
        boolean he = "iw".equals(java.util.Locale.getDefault().getLanguage()) || "he".equals(java.util.Locale.getDefault().getLanguage());
        return new NotificationCompat.Builder(this, Notes.CONNECTION)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(on ? (he ? "מחובר למחשב" : "Connected to your computer") : (he ? "מחפש את המחשב" : "Looking for your computer"))
            .setContentText(on ? (he ? "התראות מגיעות ישירות" : "Notifications arrive directly") : (he ? "בינתיים התראות מגיעות דרך ntfy, אם הוא מותקן" : "Meanwhile notifications come through ntfy, if installed"))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(Notes.open(this, "#/settings/notifications", ID))
            .build();
    }

    private void show(boolean on) {
        if (connected == on) return;
        connected = on;
        try {
            NotificationManagerCompat.from(this).notify(ID, note(on));
        } catch (SecurityException e) {
            // no permission: the service still runs
        }
    }

    private void loop() {
        long wait = 5000;
        while (running) {
            String base = Prefs.base(this);
            String key = Prefs.key(this);
            if (base.isEmpty() || key.isEmpty()) break;
            try {
                HttpURLConnection h = (HttpURLConnection) new URL(base.replaceAll("/+$", "") + "/api/phone-push/stream").openConnection();
                current = h;
                h.setConnectTimeout(10000);
                // The computer pings every 20 s; silence for 70 s means the connection is gone.
                h.setReadTimeout(70000);
                h.setInstanceFollowRedirects(false);
                h.setRequestProperty("Authorization", "Bearer " + key);
                h.setRequestProperty("Accept", "text/event-stream");
                if (h.getResponseCode() != 200) throw new java.io.IOException("status " + h.getResponseCode());
                show(true);
                wait = 5000;
                try (BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while (running && (line = r.readLine()) != null) {
                        if (!line.startsWith("data: ")) continue;
                        try {
                            JSONObject m = new JSONObject(line.substring(6));
                            if (m.has("seq")) Http.later(this, "POST", "api/phone-push/ack", "{\"seq\":" + m.optLong("seq") + "}");
                            Notes.handle(this, m);
                        } catch (Exception e) {
                            // a message it cannot read: skip it
                        }
                    }
                }
            } catch (Exception e) {
                // the computer is off, asleep, or not reachable from here
            } finally {
                HttpURLConnection h = current;
                if (h != null) h.disconnect();
                current = null;
            }
            show(false);
            if (!running) break;
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                break;
            }
            wait = Math.min(60000, wait * 2);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        connected = false;
        HttpURLConnection h = current;
        if (h != null) new Thread(h::disconnect).start();
        if (thread != null) thread.interrupt();
        thread = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
