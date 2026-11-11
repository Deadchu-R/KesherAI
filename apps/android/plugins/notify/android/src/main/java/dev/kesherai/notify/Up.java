package dev.kesherai.notify;

import android.content.Context;

import org.unifiedpush.android.connector.UnifiedPush;

import java.util.List;

/**
 * Every UnifiedPush call in one place, each guarded: if the library cannot load or fails on this phone,
 * the rest of the notifications (the live connection) keeps working and the app still starts.
 */
final class Up {
    private static final String NTFY = "io.heckel.ntfy";

    private Up() {}

    /** Registers with the saved distributor, or ntfy, or the first one installed. @return false when none is installed. */
    static boolean register(Context c) {
        try {
            List<String> all = UnifiedPush.getDistributors(c);
            String saved = UnifiedPush.getAckDistributor(c);
            if (saved == null && all.isEmpty()) return false;
            if (saved == null) UnifiedPush.saveDistributor(c, all.contains(NTFY) ? NTFY : all.get(0));
            UnifiedPush.register(c, "default", "KesherAI", null);
            return true;
        } catch (Throwable t) {
            Prefs.of(c).edit().putString("pushState", "error:" + t.getClass().getSimpleName()).apply();
            return true;
        }
    }

    static void unregister(Context c) {
        try {
            if (UnifiedPush.getAckDistributor(c) != null) UnifiedPush.unregister(c, "default");
        } catch (Throwable t) {
            // nothing registered, or the library is not usable here
        }
    }

    static String distributor(Context c) {
        try {
            return UnifiedPush.getAckDistributor(c);
        } catch (Throwable t) {
            return null;
        }
    }

    static int count(Context c) {
        try {
            return UnifiedPush.getDistributors(c).size();
        } catch (Throwable t) {
            return 0;
        }
    }
}
