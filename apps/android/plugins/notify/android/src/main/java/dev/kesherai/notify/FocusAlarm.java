package dev.kesherai.notify;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONObject;

/**
 * The focus timer's "time's up" notification on the phone, also when the app is closed or the screen is off.
 * An inexact alarm that may run while the phone idles (no special alarm permission): Android may deliver it a few
 * minutes late in deep sleep. The app shows its own message when it is open.
 */
public class FocusAlarm extends BroadcastReceiver {
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_BODY = "body";
    private static final int CODE = 0x6f63;

    private static PendingIntent intent(Context c, String title, String body) {
        Intent i = new Intent(c, FocusAlarm.class).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_BODY, body);
        return PendingIntent.getBroadcast(c, CODE, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Sets the one focus alarm (a new one replaces it). */
    static void set(Context c, long at, String title, String body) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = intent(c, title, body);
        if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.set(AlarmManager.RTC_WAKEUP, at, pi);
    }

    /** Cancels it (she stopped the timer). */
    static void cancel(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am != null) am.cancel(intent(c, "", ""));
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            JSONObject m = new JSONObject()
                .put("id", "focus")
                .put("ch", "done")
                .put("title", intent.getStringExtra(EXTRA_TITLE))
                .put("body", intent.getStringExtra(EXTRA_BODY));
            Notes.handle(context.getApplicationContext(), m);
        } catch (Exception e) {
            // nothing to show
        }
    }
}
