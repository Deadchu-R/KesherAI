package dev.kesherai.background;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Runs while the app has work in progress (a download, an answer from a
 * model on the phone), so Android keeps the app alive in the background.
 * It shows a notification with the progress; tapping it opens the app.
 */
public class WorkService extends Service {
    static final String CHANNEL = "kesher-work";
    static final String DONE_CHANNEL = "kesher-done";
    static final int ID = 7420;
    private PowerManager.WakeLock wake;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "KesherAI";
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "";
        int progress = intent != null ? intent.getIntExtra("progress", -1) : -1;
        Notification n = build(this, title, text, progress);
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(ID, n);
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KesherAI:work");
            wake.acquire(2 * 60 * 60 * 1000L); // at most 2 hours
        }
        return START_NOT_STICKY;
    }

    static void channels(android.content.Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Work in progress", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(DONE_CHANNEL, "Finished", NotificationManager.IMPORTANCE_DEFAULT));
    }

    static PendingIntent openApp(android.content.Context c) {
        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (open == null) open = new Intent();
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static Notification build(android.content.Context c, String title, String text, int progress) {
        channels(c);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(c));
        if (progress >= 0) b.setProgress(100, progress, false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
