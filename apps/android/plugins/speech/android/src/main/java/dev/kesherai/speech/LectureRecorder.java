package dev.kesherai.speech;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;

/**
 * Records a lecture with the screen off: a foreground service (microphone), like a voice recorder app, with its own
 * "recording" notification. The sound is kept in the app's own folder as 30-second WAV pieces (16 kHz, mono), which the
 * app turns into text with its own speech engine after the recording; nothing leaves the phone.
 */
public class LectureRecorder extends Service {
    static final int RATE = 16000;
    static final int PIECE_SECONDS = 30;
    private static final String CHANNEL = "kesher-recording";
    private static final int NOTE_ID = 7610;

    /** The pieces of the last recording, in order (file name, seconds from the start). */
    static final List<String[]> pieces = new ArrayList<>();
    static volatile boolean running = false;
    static volatile long startedAt = 0;
    private static volatile Thread worker;

    static File folder(Context c) {
        File f = new File(c.getFilesDir(), "lecture-rec");
        //noinspection ResultOfMethodCallIgnored
        f.mkdirs();
        return f;
    }

    /** Removes the pieces of a recording that was already turned into text. */
    static void clear(Context c) {
        File[] old = folder(c).listFiles();
        if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
            f.delete();
        synchronized (pieces) { pieces.clear(); }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (running) return START_NOT_STICKY;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            boolean he = java.util.Locale.getDefault().getLanguage().matches("iw|he");
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, he ? "הקלטת הרצאה" : "Lecture recording", NotificationManager.IMPORTANCE_LOW));
        }
        boolean he = java.util.Locale.getDefault().getLanguage().matches("iw|he");
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, NOTE_ID, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(he ? "מקליט הרצאה" : "Recording a lecture")
            .setContentText(he ? "ממשיך גם כשהמסך כבוי. לעצירה: חזרי לאפליקציה." : "Goes on with the screen off. To stop: go back to the app.")
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis());
        if (tap != null) b.setContentIntent(tap);
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        clear(this);
        running = true;
        startedAt = System.currentTimeMillis();
        worker = new Thread(this::record, "kesher-lecture-rec");
        worker.start();
        return START_NOT_STICKY;
    }

    private void record() {
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE * 2));
            rec.startRecording();
        } catch (SecurityException | IllegalStateException e) {
            running = false;
            stopSelf();
            return;
        }
        byte[] buf = new byte[RATE / 5 * 2];
        int piece = 0;
        long pieceBytes = 0;
        long perPiece = (long) RATE * 2 * PIECE_SECONDS;
        FileOutputStream out = null;
        File file = null;
        try {
            while (running) {
                if (out == null) {
                    file = new File(folder(this), String.format(java.util.Locale.ROOT, "piece-%04d.wav", piece));
                    out = new FileOutputStream(file);
                    out.write(new byte[44]);
                    pieceBytes = 0;
                }
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                out.write(buf, 0, n);
                pieceBytes += n;
                if (pieceBytes >= perPiece) {
                    out.close();
                    finish(file, pieceBytes, piece);
                    out = null;
                    piece++;
                }
            }
            if (out != null) {
                out.close();
                if (pieceBytes > RATE) finish(file, pieceBytes, piece);
                else //noinspection ResultOfMethodCallIgnored
                    file.delete();
            }
        } catch (IOException ignored) {
            // the pieces written so far stay
        } finally {
            try { rec.stop(); } catch (Exception ignored) {}
            rec.release();
        }
    }

    /** Writes the WAV header now that the piece's length is known, and lists the piece. */
    private static void finish(File f, long dataBytes, int piece) throws IOException {
        try (RandomAccessFile w = new RandomAccessFile(f, "rw")) {
            w.seek(0);
            w.write(header(dataBytes));
        }
        synchronized (pieces) { pieces.add(new String[] { f.getName(), String.valueOf((long) piece * PIECE_SECONDS) }); }
    }

    private static byte[] header(long data) {
        byte[] h = new byte[44];
        java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(h).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt((int) (36 + data)).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1).putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes()).putInt((int) data);
        return h;
    }

    /** Stops the recording and waits for the last piece to be written. */
    static void finishRecording(Context c) {
        running = false;
        Thread t = worker;
        if (t != null) {
            try { t.join(5000); } catch (InterruptedException ignored) {}
        }
        c.stopService(new Intent(c, LectureRecorder.class));
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }
}
