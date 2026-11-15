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
        if (!p.contains("error")) return o;
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
