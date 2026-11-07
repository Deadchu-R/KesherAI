package dev.kesherai.screen;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Screen sharing for live mode: the system asks the user first ("Start
 * recording or casting?"), then a notification shows while it shares.
 */
@CapacitorPlugin(name = "KesherScreen")
public class KesherScreenPlugin extends Plugin {

    /** Asks the system for permission and starts sharing. Resolves { sharing: true } or rejects if refused. */
    @PluginMethod
    public void start(PluginCall call) {
        if (ScreenService.running) {
            JSObject r = new JSObject();
            r.put("sharing", true);
            call.resolve(r);
            return;
        }
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Screen sharing was not allowed.");
            return;
        }
        Intent svc = new Intent(getContext(), ScreenService.class);
        svc.putExtra("resultCode", result.getResultCode());
        svc.putExtra("data", result.getData());
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        JSObject r = new JSObject();
        r.put("sharing", true);
        call.resolve(r);
    }

    /** The newest picture of the screen: { data: base64 JPEG, width, height }, or { data: null } before the first one. */
    @PluginMethod
    public void frame(PluginCall call) {
        byte[] jpg = ScreenService.latest;
        JSObject r = new JSObject();
        r.put("sharing", ScreenService.running);
        if (jpg != null) {
            r.put("data", Base64.encodeToString(jpg, Base64.NO_WRAP));
            r.put("width", ScreenService.latestW);
            r.put("height", ScreenService.latestH);
        } else r.put("data", null);
        call.resolve(r);
    }

    /** Stops sharing. */
    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ScreenService.class));
        call.resolve();
    }
}
