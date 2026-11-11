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

    /** The computer's internet link (Access from anywhere), for when the home address cannot be reached. */
    static String alt(Context c) {
        return of(c).getString("alt", "");
    }

    /** The addresses to try, the one that worked last first. */
    static java.util.List<String> bases(Context c) {
        java.util.List<String> l = new java.util.ArrayList<>();
        for (String b : new String[] { LiveService.working, base(c), alt(c) }) {
            if (b != null && !b.isEmpty() && !l.contains(b)) l.add(b);
        }
        return l;
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
