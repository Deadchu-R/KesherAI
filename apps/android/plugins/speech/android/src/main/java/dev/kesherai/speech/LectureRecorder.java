package dev.kesherai.speech;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Records with the screen off or while another app is in front: a foreground service (microphone), like a voice
 * recorder app, with an ongoing notification that has Pause/Resume and Stop. Used for lectures (Study) and Open mind.
 *
 * The sound is kept in the app's own folder as 30-second WAV pieces (16 kHz, mono), written as it goes, so a crash or
 * the system stopping the app keeps everything up to that moment. A stopped recording can be resumed into the same
 * session ({@code resume}): the pieces on disk are read back (a piece cut off mid-write gets its header fixed) and new
 * pieces follow them. Nothing leaves the phone here; the page reads the pieces and sends them on.
 *
 * Pauses: the person's own (the notification or the page), and the system's: when another app takes the microphone
 * (a call, a video being recorded) Android silences this one; the recorder notices, stops writing, and goes on by
 * itself when the microphone is free again. Each pause is kept as a gap (where in the recording, how long).
 * The microphone stays open during a pause: Android 14 does not let a background app open it again.
 */
public class LectureRecorder extends Service {
    static final int RATE = 16000;
    static final int PIECE_SECONDS = 30;
    private static final String CHANNEL = "kesher-recording";
    private static final int NOTE_ID = 7610;
    static final String ACTION_PAUSE = "dev.kesherai.speech.REC_PAUSE";
    static final String ACTION_RESUME = "dev.kesherai.speech.REC_RESUME";
    static final String ACTION_STOP = "dev.kesherai.speech.REC_STOP";
    /** Intent extras: continue the recording on disk instead of starting a new one; which page it belongs to. */
    static final String EXTRA_RESUME = "resume";
    static final String EXTRA_TAG = "tag";

    /** The pieces of the recording, in order (file name, seconds into the recording). */
    static final List<String[]> pieces = new ArrayList<>();
    /** The pauses: { seconds into the recording, how long in ms, 1 when the system took the microphone }. */
    static final List<long[]> gaps = new ArrayList<>();
    static volatile boolean running = false;
    /** Paused by the person (the page or the notification). */
    static volatile boolean paused = false;
    /** Paused by the system: another app is using the microphone. */
    static volatile boolean silenced = false;
    /** When the session first started (ms), and which page started it ("ideas", "study"…). */
    static volatile long startedAt = 0;
    static volatile String tag = "";
    /** Sound kept so far, in bytes of 16-bit PCM (all pieces, the open one included). */
    static volatile long recordedBytes = 0;
    /** The last loudness, 0..100, for the page's level meter. */
    static volatile int level = 0;
    private static volatile Thread worker;
    private AudioManager.AudioRecordingCallback watch;

    static File folder(Context c) {
        File f = new File(c.getFilesDir(), "lecture-rec");
        //noinspection ResultOfMethodCallIgnored
        f.mkdirs();
        return f;
    }

    /** Removes the recording on disk (after it was sent, or when the person discards it). */
    static void clear(Context c) {
        File[] old = folder(c).listFiles();
        if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
            f.delete();
        synchronized (pieces) { pieces.clear(); gaps.clear(); }
        recordedBytes = 0;
        startedAt = 0;
        tag = "";
        paused = false;
        silenced = false;
    }

    /** Seconds of sound kept so far. */
    static long recordedMs() {
        return recordedBytes * 1000 / (RATE * 2);
    }

    /**
     * Reads a recording that is not running back from disk (after the app was closed, or to resume it): the pieces in
     * order with their place in the recording, the gaps and the session's start. A piece cut off mid-write gets the
     * header for the sound it has.
     */
    static void restore(Context c) {
        if (running) return;
        File dir = folder(c);
        String[] names = dir.list((d, n) -> n.matches("piece-\\d{4}\\.wav"));
        long cum = 0;
        synchronized (pieces) {
            pieces.clear();
            gaps.clear();
            if (names != null) {
                Arrays.sort(names);
                for (String n : names) {
                    File f = new File(dir, n);
                    long data = f.length() - 44;
                    if (data < RATE) { // under half a second (or only a header): nothing worth keeping
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                        continue;
                    }
                    data -= data % 2;
                    try { writeHeader(f, data); } catch (IOException ignored) { continue; }
                    pieces.add(new String[] { n, String.valueOf(cum / (RATE * 2)) });
                    cum += data;
                }
            }
            for (String line : readLines(new File(dir, "gaps.txt"))) {
                String[] p = line.split(",");
                if (p.length >= 2) try { gaps.add(new long[] { Long.parseLong(p[0]), Long.parseLong(p[1]), p.length > 2 ? Long.parseLong(p[2]) : 0 }); } catch (NumberFormatException ignored) {}
            }
        }
        recordedBytes = cum;
        List<String> s = readLines(new File(dir, "session.txt"));
        startedAt = s.size() > 0 ? parseLong(s.get(0)) : 0;
        tag = s.size() > 1 ? s.get(1) : "";
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s.trim()); } catch (NumberFormatException e) { return 0; }
    }

    private static List<String> readLines(File f) {
        List<String> out = new ArrayList<>();
        if (!f.exists()) return out;
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(f), StandardCharsets.UTF_8))) {
            for (String l = r.readLine(); l != null; l = r.readLine()) out.add(l);
        } catch (IOException ignored) {}
        return out;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_PAUSE.equals(action) || ACTION_RESUME.equals(action)) {
            if (running) setPaused(ACTION_PAUSE.equals(action));
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            running = false; // the worker writes the last piece and stops the service
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;
        boolean resume = intent != null && intent.getBooleanExtra(EXTRA_RESUME, false);
        if (resume) restore(this);
        else clear(this);
        if (startedAt == 0) startedAt = System.currentTimeMillis();
        String asked = intent == null ? null : intent.getStringExtra(EXTRA_TAG);
        if (!resume || tag.isEmpty()) tag = asked == null ? "" : asked.replaceAll("[^a-z]", "");
        try (FileOutputStream o = new FileOutputStream(new File(folder(this), "session.txt"))) {
            o.write((startedAt + "\n" + tag + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {}
        paused = false;
        silenced = false;
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, note(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTE_ID, note());
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        worker = new Thread(this::record, "kesher-lecture-rec");
        worker.start();
        return START_NOT_STICKY;
    }

    /** Pauses or resumes (the person's choice) and shows it in the notification. */
    void setPaused(boolean on) {
        paused = on;
        refresh();
    }

    private void refresh() {
        if (!running) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTE_ID, note());
    }

    /** The ongoing notification: the clock while recording, why it is paused when it is, Pause/Resume and Stop. */
    private Notification note() {
        boolean he = java.util.Locale.getDefault().getLanguage().matches("iw|he");
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, he ? "הקלטה" : "Recording", NotificationManager.IMPORTANCE_LOW));
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, NOTE_ID, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        boolean idea = "ideas".equals(tag);
        String title = paused || silenced
            ? (he ? "ההקלטה מושהית" : "Recording paused")
            : idea ? (he ? "מקליט: מוח פתוח" : "Recording: Open mind") : (he ? "מקליט הרצאה" : "Recording a lecture");
        String text = silenced
            ? (he ? "אפליקציה אחרת משתמשת במיקרופון. ממשיך לבד כשהוא מתפנה." : "Another app is using the microphone. Goes on by itself when it is free.")
            : paused ? (he ? "הקש/י \"המשך\" כדי להמשיך." : "Tap Resume to go on.")
            : (he ? "ממשיך גם כשהמסך כבוי או באפליקציה אחרת." : "Goes on with the screen off or in another app.");
        b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(!(paused || silenced))
            .setUsesChronometer(!(paused || silenced))
            .setWhen(System.currentTimeMillis() - recordedMs());
        if (tap != null) b.setContentIntent(tap);
        if (Build.VERSION.SDK_INT >= 23) {
            boolean hold = paused;
            b.addAction(new Notification.Action.Builder(Icon.createWithResource(this, hold ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause),
                hold ? (he ? "המשך" : "Resume") : (he ? "השהה" : "Pause"), action(hold ? ACTION_RESUME : ACTION_PAUSE, 1)).build());
            b.addAction(new Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                he ? "עצור" : "Stop", action(ACTION_STOP, 2)).build());
        }
        return b.build();
    }

    private PendingIntent action(String what, int code) {
        Intent i = new Intent(this, LectureRecorder.class).setAction(what);
        return PendingIntent.getService(this, NOTE_ID + code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Follows whether Android silenced this recording because another app took the microphone (Android 10+). */
    private void watchSilencing(AudioRecord rec) {
        if (Build.VERSION.SDK_INT < 29) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int session = rec.getAudioSessionId();
        watch = new AudioManager.AudioRecordingCallback() {
            @Override
            public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                boolean now = false;
                for (AudioRecordingConfiguration c : configs)
                    if (c.getClientAudioSessionId() == session) now = c.isClientSilenced();
                if (now != silenced) {
                    silenced = now;
                    refresh();
                }
            }
        };
        am.registerAudioRecordingCallback(watch, new Handler(Looper.getMainLooper()));
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
        watchSilencing(rec);
        byte[] buf = new byte[RATE / 5 * 2];
        int piece;
        synchronized (pieces) {
            piece = pieces.isEmpty() ? 0 : Integer.parseInt(pieces.get(pieces.size() - 1)[0].replaceAll("\\D", "")) + 1;
        }
        long pieceBytes = 0;
        long perPiece = (long) RATE * 2 * PIECE_SECONDS;
        long gapFrom = 0;
        boolean gapBySystem = false;
        FileOutputStream out = null;
        File file = null;
        try {
            while (running) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                if (paused || silenced) {
                    // Nothing is written during a pause (a silenced microphone only gives zeros); the gap is kept.
                    if (gapFrom == 0) gapFrom = System.currentTimeMillis();
                    gapBySystem |= silenced;
                    level = 0;
                    continue;
                }
                if (gapFrom != 0) {
                    addGap(recordedMs() / 1000, System.currentTimeMillis() - gapFrom, gapBySystem);
                    gapFrom = 0;
                    gapBySystem = false;
                }
                int peak = 0;
                for (int i = 0; i + 1 < n; i += 32) peak = Math.max(peak, Math.abs((short) ((buf[i] & 0xff) | (buf[i + 1] << 8))));
                level = peak * 100 / 32768;
                if (out == null) {
                    file = new File(folder(this), String.format(java.util.Locale.ROOT, "piece-%04d.wav", piece));
                    out = new FileOutputStream(file);
                    out.write(new byte[44]);
                    pieceBytes = 0;
                    synchronized (pieces) { pieces.add(new String[] { file.getName(), String.valueOf(recordedMs() / 1000), "open" }); }
                }
                out.write(buf, 0, n);
                pieceBytes += n;
                recordedBytes += n;
                if (pieceBytes >= perPiece) {
                    out.close();
                    finish(file, pieceBytes);
                    out = null;
                    piece++;
                }
            }
            if (out != null) {
                out.close();
                if (pieceBytes > RATE) finish(file, pieceBytes);
                else {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                    recordedBytes -= pieceBytes;
                    synchronized (pieces) { if (!pieces.isEmpty()) pieces.remove(pieces.size() - 1); }
                }
            }
        } catch (IOException ignored) {
            // the pieces written so far stay
        } finally {
            try { rec.stop(); } catch (Exception ignored) {}
            rec.release();
            if (watch != null && Build.VERSION.SDK_INT >= 29) ((AudioManager) getSystemService(Context.AUDIO_SERVICE)).unregisterAudioRecordingCallback(watch);
            running = false;
            level = 0;
            stopSelf();
        }
    }

    /** Keeps a pause: in memory and in gaps.txt (so a resumed session still knows it). */
    private void addGap(long atSec, long ms, boolean bySystem) {
        synchronized (pieces) { gaps.add(new long[] { atSec, ms, bySystem ? 1 : 0 }); }
        try (FileOutputStream o = new FileOutputStream(new File(folder(this), "gaps.txt"), true)) {
            o.write((atSec + "," + ms + "," + (bySystem ? 1 : 0) + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {}
    }

    /** Writes the WAV header now that the piece's length is known, and marks the piece finished. */
    private static void finish(File f, long dataBytes) throws IOException {
        writeHeader(f, dataBytes);
        synchronized (pieces) {
            String[] last = pieces.isEmpty() ? null : pieces.get(pieces.size() - 1);
            if (last != null && last[0].equals(f.getName())) pieces.set(pieces.size() - 1, new String[] { last[0], last[1] });
        }
    }

    private static void writeHeader(File f, long data) throws IOException {
        try (RandomAccessFile w = new RandomAccessFile(f, "rw")) {
            w.seek(0);
            w.write(header(data));
        }
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
