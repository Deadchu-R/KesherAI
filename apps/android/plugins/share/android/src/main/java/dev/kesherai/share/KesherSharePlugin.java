package dev.kesherai.share;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import org.json.JSONObject;

/** What was shared to KesherAI (or which widget button was tapped), for the page to take once. */
@CapacitorPlugin(name = "KesherShare")
public class KesherSharePlugin extends Plugin {
    private static final String PREFS = "kesher-share";
    private static KesherSharePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Keeps a share (or a widget action) until the page takes it, and tells an open page. */
    static void keep(Context ctx, JSONObject shared) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("pending", shared.toString()).apply();
        KesherSharePlugin p = instance;
        if (p != null && p.getBridge() != null) p.getBridge().executeOnMainThread(() -> p.notifyListeners("shared", new JSObject(), true));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent.getBooleanExtra("kesher_shared", false)) notifyListeners("shared", new JSObject(), true);
    }

    @PluginMethod
    public void take(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString("pending", null);
        prefs.edit().remove("pending").apply();
        try {
            call.resolve(raw == null ? new JSObject() : JSObject.fromJSONObject(new JSONObject(raw)));
        } catch (Exception e) {
            call.resolve(new JSObject());
        }
    }

    /** Reads a shared file (only files in the app's shared folder). */
    @PluginMethod
    public void read(PluginCall call) {
        File f = inShared(call.getString("path", ""));
        if (f == null || !f.isFile()) { call.reject("No such shared file"); return; }
        try (InputStream is = new FileInputStream(f)) {
            byte[] data = new byte[(int) f.length()];
            int off = 0, r;
            while (off < data.length && (r = is.read(data, off, data.length - off)) > 0) off += r;
            JSObject out = new JSObject();
            out.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        File f = inShared(call.getString("path", ""));
        if (f != null) f.delete();
        call.resolve();
    }

    private File inShared(String path) {
        try {
            File dir = new File(getContext().getCacheDir(), "shared").getCanonicalFile();
            File f = new File(path).getCanonicalFile();
            return f.getPath().startsWith(dir.getPath() + File.separator) ? f : null;
        } catch (Exception e) {
            return null;
        }
    }
}
