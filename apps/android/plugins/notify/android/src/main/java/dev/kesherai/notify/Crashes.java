package dev.kesherai.notify;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * The app's crashes, written down so the next start can show them and send them to the computer (found on the
 * user's phone: the app closed when connecting, with nothing to read). Only the error and its stack: no messages,
 * keys or addresses.
 */
final class Crashes {
    private Crashes() {}

    private static final String PREFS = "kesher-crash";
    private static boolean installed;

    /** Keeps Android's own handler (it closes the app and shows its dialog) after writing the crash down. */
    static synchronized void install(Context context) {
        if (installed) return;
        installed = true;
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                note(app, "thread " + thread.getName(), error);
            } catch (Throwable ignored) {
                // never in the way of the crash itself
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    /** Writes one crash (or a refusal the app survived) down; commit() because the process may end right after. */
    static void note(Context c, String where, Throwable t) {
        StringWriter s = new StringWriter();
        t.printStackTrace(new PrintWriter(s));
        String stack = s.toString();
        if (stack.length() > 6000) stack = stack.substring(0, 6000);
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("at", System.currentTimeMillis())
            .putString("where", where)
            .putString("error", String.valueOf(t))
            .putString("stack", stack)
            .putString("device", Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")")
            .commit();
    }

    /** The last one, once (then it is cleared). */
    static JSObject take(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject o = new JSObject();
        if (!p.contains("error")) {
            // Nothing written down: the app may have been ended from outside Java (a crash in native code or in the
            // page's renderer, Android ending it for memory, an ANR). Android 11+ keeps the reason: the newest one
            // not seen yet is told once, with the start of its trace.
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.app.ActivityManager am = (android.app.ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
                    // The newest few (an update or a normal close may be newer than the crash).
                    java.util.List<android.app.ApplicationExitInfo> exits = am.getHistoricalProcessExitReasons(c.getPackageName(), 0, 10);
                    long seen = p.getLong("exitSeen", 0);
                    android.app.ApplicationExitInfo e = null;
                    for (android.app.ApplicationExitInfo x : exits) {
                        int rr = x.getReason();
                        boolean badOne = rr == android.app.ApplicationExitInfo.REASON_CRASH || rr == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE || rr == android.app.ApplicationExitInfo.REASON_ANR || rr == android.app.ApplicationExitInfo.REASON_LOW_MEMORY || rr == android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE || rr == android.app.ApplicationExitInfo.REASON_INITIALIZATION_FAILURE || rr == android.app.ApplicationExitInfo.REASON_SIGNALED;
                        if (badOne && x.getTimestamp() > seen) {
                            e = x;
                            break;
                        }
                    }
                    if (e != null) {
                        int r = e.getReason();
                        {
                            p.edit().putLong("exitSeen", e.getTimestamp()).apply();
                            String trace = "";
                            try (java.io.InputStream in = e.getTraceInputStream()) {
                                if (in != null) {
                                    byte[] buf = new byte[6000];
                                    int n = in.read(buf);
                                    if (n > 0) trace = new String(buf, 0, n, "UTF-8");
                                }
                            } catch (Throwable ignored) {}
                            String[] names = { "unknown", "exit", "signaled", "low memory", "crash", "native crash", "ANR", "initialization failure", "permission change", "excessive resource use", "user requested", "user stopped", "dependency died", "other", "freezer", "package state change", "package updated" };
                            o.put("at", e.getTimestamp());
                            o.put("where", "process ended: " + (r >= 0 && r < names.length ? names[r] : String.valueOf(r)) + (e.getStatus() != 0 ? " (status " + e.getStatus() + ")" : ""));
                            o.put("error", String.valueOf(e.getDescription()));
                            o.put("stack", trace);
                            o.put("device", Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + "), memory " + (e.getPss() / 1024) + " MB");
                        }
                    }
                }
            } catch (Throwable ignored) {}
            return o;
        }
        o.put("at", p.getLong("at", 0));
        o.put("where", p.getString("where", ""));
        o.put("error", p.getString("error", ""));
        o.put("stack", p.getString("stack", ""));
        o.put("device", p.getString("device", ""));
        p.edit().clear().apply();
        return o;
    }

    /** Starts the live connection's service; when Android refuses, the app goes on (UnifiedPush still delivers). */
    static void startLive(Context c, Intent service) {
        try {
            ContextCompat.startForegroundService(c, service);
        } catch (Throwable t) {
            note(c, "startForegroundService", t);
        }
    }
}
