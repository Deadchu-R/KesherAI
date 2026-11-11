package dev.kesherai.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

import androidx.core.app.NotificationManagerCompat;

/** Approve / Deny on a notification: posts to the computer, then removes the notification. */
public class ActionReceiver extends BroadcastReceiver {
    static final String EXTRA_POST = "post";
    static final String EXTRA_TAG = "tag";

    @Override
    public void onReceive(Context context, Intent intent) {
        String path = intent.getStringExtra(EXTRA_POST);
        String tag = intent.getStringExtra(EXTRA_TAG);
        // Only the computer's one-time approve/deny addresses.
        if (path == null || !path.matches("^/?api/quick-approve/[\\w-]{32}\\?d=(allow|deny)$")) return;
        PendingResult done = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            int status = Http.send(app, "POST", path, null);
            if (tag != null) NotificationManagerCompat.from(app).cancel(tag, 0);
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                boolean he = "iw".equals(java.util.Locale.getDefault().getLanguage()) || "he".equals(java.util.Locale.getDefault().getLanguage());
                String text = status >= 200 && status < 300 ? (he ? "נשלח למחשב" : "Sent to the computer")
                    : status == 410 ? (he ? "הבקשה כבר נענתה או שפג תוקפה" : "Already answered or too old")
                    : (he ? "לא הצלחתי להגיע למחשב" : "Could not reach the computer");
                Toast.makeText(app, text, Toast.LENGTH_SHORT).show();
                done.finish();
            });
        }, "kesher-action").start();
    }
}
