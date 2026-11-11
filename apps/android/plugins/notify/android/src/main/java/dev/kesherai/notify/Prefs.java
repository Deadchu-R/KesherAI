package dev.kesherai.notify;

import android.content.Context;
import android.content.SharedPreferences;

/** Where the computer is, this phone's key for it, and which ways of notifying are on. */
final class Prefs {
    private Prefs() {}

    static SharedPreferences of(Context c) {
        return c.getSharedPreferences("kesher-notify", Context.MODE_PRIVATE);
    }

    static String base(Context c) {
        return of(c).getString("base", "");
    }

    static String key(Context c) {
        return of(c).getString("key", "");
    }

    static boolean live(Context c) {
        return of(c).getBoolean("live", false);
    }

    static boolean push(Context c) {
        return of(c).getBoolean("push", false);
    }
}
