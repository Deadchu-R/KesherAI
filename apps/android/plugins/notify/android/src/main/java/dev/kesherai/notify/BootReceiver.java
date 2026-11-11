package dev.kesherai.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

/** After the phone restarts (or the app updates), the live connection comes back if it was on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (!Prefs.live(context) || Prefs.base(context).isEmpty()) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, LiveService.class));
        } catch (Exception e) {
            // Android refused to start it now; it starts the next time the app opens.
        }
    }
}
