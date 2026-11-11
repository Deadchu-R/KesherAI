package dev.kesherai.notify;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * Shows KesherAI's notifications the way phone apps do (docs/RESEARCH_LOG.md, 2026-11-11):
 * one channel per kind (each can be muted in Android's settings), one notification per chat that is
 * updated rather than stacked, grouped under KesherAI, removed when the chat was answered elsewhere,
 * Approve/Deny that work only on an unlocked phone, and a tap that opens the chat itself.
 */
public final class Notes {
    static final String WAITING = "kesher-waiting";
    static final String DONE = "kesher-finished";
    static final String DOWNLOADS = "kesher-downloads";
    static final String CONNECTION = "kesher-connection";
    static final String GROUP = "dev.kesherai.NOTES";
    static final String EXTRA_PATH = "kesherPath";
    private static final int SUMMARY_ID = 7421;

    /** Whether the app is open in front (then only "waiting" pops up; the open app shows the rest itself). */
    static volatile boolean foreground;

    private Notes() {}

    private static boolean hebrew() {
        String l = Locale.getDefault().getLanguage();
        return "iw".equals(l) || "he".equals(l);
    }

    private static String t(String he, String en) {
        return hebrew() ? he : en;
    }

    /** Creates the four channels once (Android keeps the user's choices for each). */
    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel w = new NotificationChannel(WAITING, t("מחכה לך", "Waiting for you"), NotificationManager.IMPORTANCE_HIGH);
        w.setDescription(t("סוכן מחכה לאישור או לתשובה שלך", "An agent waits for your approval or answer"));
        nm.createNotificationChannel(w);
        NotificationChannel d = new NotificationChannel(DONE, t("עבודה הסתיימה", "Work finished"), NotificationManager.IMPORTANCE_DEFAULT);
        d.setDescription(t("שיחה או משימה ארוכה הסתיימה", "A long chat or task finished"));
        nm.createNotificationChannel(d);
        NotificationChannel dl = new NotificationChannel(DOWNLOADS, t("הורדות", "Downloads"), NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(dl);
        NotificationChannel con = new NotificationChannel(CONNECTION, t("חיבור למחשב", "Connection to the computer"), NotificationManager.IMPORTANCE_MIN);
        con.setDescription(t("ההודעה הקבועה שמחזיקה את החיבור הישיר; אפשר להסתיר אותה", "The fixed notification that keeps the direct connection; you can hide it"));
        con.setShowBadge(false);
        nm.createNotificationChannel(con);
    }

    /** A tap that opens KesherAI on a page (#/c/… for a chat). */
    static PendingIntent open(Context c, String path, int code) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i == null) i = new Intent();
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (path != null) i.putExtra(EXTRA_PATH, path);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * Handles one message from the computer: {t: show|clear, id, ch, title, body, path, actions}.
     */
    static void handle(Context c, JSONObject m) {
        String id = m.optString("id", "kesher");
        if ("clear".equals(m.optString("t"))) {
            // Only the "waiting" one: a "finished" note for the same chat may already have replaced it.
            NotificationManagerCompat.from(c).cancel("w:" + id, 0);
            summary(c);
            return;
        }
        String ch = m.optString("ch", "done");
        if (foreground && !"waiting".equals(ch)) return;
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        channels(c);
        String channel = "waiting".equals(ch) ? WAITING : "downloads".equals(ch) ? DOWNLOADS : DONE;
        String path = m.has("path") ? m.optString("path") : null;
        int code = id.hashCode();
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
            .setSmallIcon("downloads".equals(ch) ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_chat)
            .setContentTitle(m.optString("title", "KesherAI"))
            .setContentText(m.optString("body", ""))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(m.optString("body", "")))
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setGroup(GROUP)
            .setCategory("waiting".equals(ch) ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_STATUS)
            .setPriority("waiting".equals(ch) ? NotificationCompat.PRIORITY_HIGH : "downloads".equals(ch) ? NotificationCompat.PRIORITY_LOW : NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(open(c, path, code));
        JSONArray actions = m.optJSONArray("actions");
        if (actions != null) {
            for (int k = 0; k < actions.length() && k < 3; k++) {
                JSONObject a = actions.optJSONObject(k);
                if (a == null) continue;
                Intent i = new Intent(c, ActionReceiver.class)
                    .putExtra(ActionReceiver.EXTRA_POST, a.optString("path"))
                    .putExtra(ActionReceiver.EXTRA_TAG, "w:" + id);
                PendingIntent pi = PendingIntent.getBroadcast(c, code * 4 + k + 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                String label = a.optString("label");
                String shown = "Approve".equals(label) ? t("אשר", "Approve") : "Deny".equals(label) ? t("דחה", "Deny") : label;
                // Approving from a locked phone in someone else's hand must not be possible (Android 12+).
                b.addAction(new NotificationCompat.Action.Builder(0, shown, pi).setAuthenticationRequired(true).build());
            }
        }
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        try {
            if ("waiting".equals(ch)) {
                nm.notify("w:" + id, 0, b.build());
            } else {
                // Finished replaces the chat's "waiting" note: one notification per chat.
                nm.cancel("w:" + id, 0);
                nm.notify("n:" + id, 0, b.build());
            }
        } catch (SecurityException e) {
            return;
        }
        summary(c);
    }

    /** Removes everything shown for one chat (the app opened it). */
    static void cancel(Context c, String id) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        nm.cancel("w:" + id, 0);
        nm.cancel("n:" + id, 0);
        summary(c);
    }

    /** With two or more notes, one KesherAI summary groups them; with fewer, none. */
    static void summary(Context c) {
        if (Build.VERSION.SDK_INT < 24) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        int count = 0;
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() == 0 && s.getTag() != null && (s.getTag().startsWith("w:") || s.getTag().startsWith("n:"))) count++;
        }
        if (count < 2) {
            nm.cancel(SUMMARY_ID);
            return;
        }
        try {
            NotificationManagerCompat.from(c).notify(SUMMARY_ID, new NotificationCompat.Builder(c, DONE)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("KesherAI")
                .setContentText(t(count + " עדכונים", count + " updates"))
                .setGroup(GROUP)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(open(c, "#/inbox", SUMMARY_ID))
                .build());
        } catch (SecurityException e) {
            // no permission: nothing to group
        }
    }
}
