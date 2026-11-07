package dev.kesherai.screen;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Shares the screen while the user allows it: keeps the newest picture of
 * the screen (scaled to at most 960 px, JPEG) for the model to look at.
 * A notification shows for as long as it runs, with a Stop action.
 */
public class ScreenService extends Service {
    static final String CHANNEL = "kesher-screen";
    static final int ID = 7421;
    static final String STOP = "dev.kesherai.screen.STOP";

    /** The newest picture, or null. */
    static volatile byte[] latest;
    static volatile int latestW, latestH;
    static volatile boolean running;

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private long lastFrame = 0;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = notification(this);
        // The microphone too, so the user can keep talking while they look at another app.
        if (Build.VERSION.SDK_INT >= 30) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(ID, n);
        if (projection != null || intent == null) return START_NOT_STICKY;
        int resultCode = intent.getIntExtra("resultCode", Activity.RESULT_CANCELED);
        Intent data = intent.getParcelableExtra("data");
        if (resultCode != Activity.RESULT_OK || data == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(resultCode, data);
        if (projection == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        thread = new HandlerThread("kesher-screen");
        thread.start();
        Handler handler = new Handler(thread.getLooper());
        // Required before creating the display (Android 14): stop when the user stops sharing from the system.
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopSelf();
            }
        }, handler);

        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        float k = Math.min(1f, 960f / Math.max(m.widthPixels, m.heightPixels));
        int w = Math.max(2, Math.round(m.widthPixels * k) / 2 * 2);
        int h = Math.max(2, Math.round(m.heightPixels * k) / 2 * 2);
        reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(r -> {
            Image img = null;
            try {
                img = r.acquireLatestImage();
                if (img == null) return;
                long now = System.currentTimeMillis();
                if (now - lastFrame < 700) return; // a fresh picture about every second is plenty
                lastFrame = now;
                Image.Plane plane = img.getPlanes()[0];
                ByteBuffer buf = plane.getBuffer();
                int pixelStride = plane.getPixelStride();
                int rowStride = plane.getRowStride();
                int padded = w + (rowStride - pixelStride * w) / pixelStride;
                Bitmap full = Bitmap.createBitmap(padded, h, Bitmap.Config.ARGB_8888);
                full.copyPixelsFromBuffer(buf);
                Bitmap cut = padded == w ? full : Bitmap.createBitmap(full, 0, 0, w, h);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                cut.compress(Bitmap.CompressFormat.JPEG, 70, out);
                latest = out.toByteArray();
                latestW = w;
                latestH = h;
                if (cut != full) cut.recycle();
                full.recycle();
            } catch (Exception ignored) {
            } finally {
                if (img != null) img.close();
            }
        }, handler);
        display = projection.createVirtualDisplay("KesherAI screen", w, h, m.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
        running = true;
        return START_NOT_STICKY;
    }

    static Notification notification(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (open == null) open = new Intent();
        PendingIntent openPi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stopPi = PendingIntent.getService(c, 1, new Intent(c, ScreenService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("KesherAI is looking at your screen")
            .setContentText("The model sees your screen while you talk. Tap Stop to end.")
            .setOngoing(true)
            .setContentIntent(openPi)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi)
            .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        latest = null;
        try { if (display != null) display.release(); } catch (Exception ignored) {}
        try { if (reader != null) reader.close(); } catch (Exception ignored) {}
        try { if (projection != null) projection.stop(); } catch (Exception ignored) {}
        if (thread != null) thread.quitSafely();
        display = null;
        reader = null;
        projection = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
