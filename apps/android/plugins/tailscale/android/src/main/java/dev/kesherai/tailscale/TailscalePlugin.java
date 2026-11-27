package dev.kesherai.tailscale;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Turns Tailscale on from KesherAI, so the phone reaches the PC directly when it is away from home.
 *
 * The Tailscale Android app has an exported receiver (com.tailscale.ipn/.IPNReceiver) that connects or
 * disconnects its VPN when it gets the CONNECT_VPN / DISCONNECT_VPN broadcast (the same one Tasker uses). It
 * works once Tailscale was set up and allowed as the phone's VPN. When the broadcast cannot be sent (Tailscale
 * not installed, an older version), open() starts the Tailscale app so the person taps Connect there.
 * Nothing else is sent: no data, no addresses.
 */
@CapacitorPlugin(name = "KesherTailscale")
public class TailscalePlugin extends Plugin {

    private static final String PACKAGE = "com.tailscale.ipn";
    private static final String RECEIVER = "com.tailscale.ipn.IPNReceiver";
    private static final String CONNECT = "com.tailscale.ipn.CONNECT_VPN";

    /** Whether the Tailscale app is installed: { installed: boolean }. */
    @PluginMethod
    public void installed(PluginCall call) {
        JSObject out = new JSObject();
        out.put("installed", isInstalled());
        call.resolve(out);
    }

    /** Sends Tailscale's CONNECT_VPN broadcast to its receiver (explicit: only Tailscale gets it). */
    @PluginMethod
    public void connect(PluginCall call) {
        if (!isInstalled()) {
            call.reject("Tailscale is not installed", "NOT_INSTALLED");
            return;
        }
        try {
            Intent intent = new Intent(CONNECT);
            intent.setComponent(new ComponentName(PACKAGE, RECEIVER));
            getContext().sendBroadcast(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not ask Tailscale to connect: " + e.getMessage(), "SEND_FAILED");
        }
    }

    /** Opens the Tailscale app (the fallback: the person taps Connect there). */
    @PluginMethod
    public void open(PluginCall call) {
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(PACKAGE);
        if (launch == null) {
            call.reject("Tailscale is not installed", "NOT_INSTALLED");
            return;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(launch);
        call.resolve();
    }

    private boolean isInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}
