package dev.kesherai.background;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Keeps work going while the app is in the background:
 * start/update show a progress notification (a foreground service keeps the
 * app alive), stop ends it, notify tells the user something finished.
 */
@CapacitorPlugin(name = "KesherBackground", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class KesherBackgroundPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        run(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // Without the permission the service still runs; Android just hides the notification.
        run(call);
    }

    private void run(PluginCall call) {
        Intent i = new Intent(getContext(), WorkService.class);
        i.putExtra("title", call.getString("title", "KesherAI"));
        i.putExtra("text", call.getString("text", ""));
        i.putExtra("progress", call.getInt("progress", -1));
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Same as start: updates the text and progress of the running notification. */
    @PluginMethod
    public void update(PluginCall call) {
        run(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), WorkService.class));
        call.resolve();
    }

    /** A one-off notification, e.g. "Download finished" or "The answer is ready". */
    @PluginMethod
    public void notify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            call.resolve();
            return;
        }
        WorkService.channels(getContext());
        NotificationManager nm = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        nm.notify((int) (System.currentTimeMillis() % 100000) + 1, new NotificationCompat.Builder(getContext(), WorkService.DONE_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(call.getString("title", "KesherAI"))
            .setContentText(call.getString("text", ""))
            .setAutoCancel(true)
            .setContentIntent(WorkService.openApp(getContext()))
            .build());
        call.resolve();
    }

}
