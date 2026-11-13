package dev.kesherai.notify;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;


/**
 * KesherAI's own notifications on the phone (window.Capacitor.Plugins.KesherNotify): the web app tells
 * it where the computer is and this phone's key, and which ways are on (live connection, UnifiedPush).
 */
@CapacitorPlugin(name = "KesherNotify", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class NotifyPlugin extends Plugin {

    @Override
    public void load() {
        // Nothing here may stop the plugin from loading (then the app would have no notifications at all).
        Notes.foreground = true;
        try {
            Notes.channels(getContext());
            remember(getActivity() != null ? getActivity().getIntent() : null);
        } catch (Throwable t) {
            // channels are made again before each notification
        }
    }

    /** The computers' pages get the native parts again after the app restarts (after every plugin is loaded). */
    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (bridgeApplied) return;
        bridgeApplied = true;
        try {
            getBridge().getWebView().post(() -> RemoteBridge.apply(getBridge()));
        } catch (Throwable t) {
            // the home screen asks again before it opens a computer
        }
    }

    private boolean bridgeApplied;

    /**
     * { origins: ["http://192.168.1.5:7420", …] }: the paired computers whose pages may use the app's native
     * parts. Only the app's own home screen may set this (a computer's page cannot add another origin).
     */
    @PluginMethod
    public void allowBridge(PluginCall call) {
        java.util.Set<String> origins = new java.util.HashSet<>();
        try {
            org.json.JSONArray list = call.getArray("origins");
            for (int i = 0; list != null && i < list.length() && origins.size() < 40; i++) {
                String o = RemoteBridge.origin(list.optString(i));
                if (o != null) origins.add(o);
            }
        } catch (Exception e) {
            // an empty list
        }
        getActivity().runOnUiThread(() -> {
            String page = getBridge().getWebView().getUrl();
            String own = getBridge().getScheme() + "://" + getBridge().getHost();
            if (page == null || !own.equals(RemoteBridge.origin(page))) {
                call.reject("Only the app's own screen can choose the computers.");
                return;
            }
            String error = RemoteBridge.allow(getBridge(), origins);
            if (error != null) call.reject(error);
            else call.resolve();
        });
    }

    /** A tapped notification opened the app: keep its page until the web app asks (takeOpen). */
    private void remember(Intent i) {
        if (i == null) return;
        String path = i.getStringExtra(Notes.EXTRA_PATH);
        if (path == null || !path.startsWith("#/")) return;
        i.removeExtra(Notes.EXTRA_PATH);
        Prefs.of(getContext()).edit().putString("open", path).apply();
        JSObject o = new JSObject();
        o.put("path", path);
        notifyListeners("open", o);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        remember(intent);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Notes.foreground = true;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        Notes.foreground = false;
    }

    /** { base, key, live, push }: saves them, asks for the notification permission once, and applies them. */
    @PluginMethod
    public void configure(PluginCall call) {
        // Only the computer the app has open may point notifications at itself (not another page).
        getActivity().runOnUiThread(() -> {
            String page = getBridge().getWebView().getUrl();
            new Thread(() -> configureFrom(call, page)).start();
        });
    }

    /** The internet link, only https (it travels over the internet). */
    private static String altOf(String alt) {
        return alt != null && alt.matches("^https://[^\\s/]+.*") ? alt : "";
    }

    private static String originOf(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            return u.getProtocol() + "://" + u.getAuthority();
        } catch (Exception e) {
            return "";
        }
    }

    private void configureFrom(PluginCall call, String page) {
        String base = call.getString("base", "");
        String key = call.getString("key", "");
        if (base == null || !base.matches("^https?://[^\\s/]+.*") || key == null || !key.startsWith("kd_")) {
            call.reject("This phone needs its own key from the computer (pair it again in Settings → Phone).");
            return;
        }
        if (page == null || !originOf(page).equals(originOf(base))) {
            call.reject("Notifications can be set only from the computer the app has open.");
            return;
        }
        Prefs.of(getContext()).edit()
            .putString("base", base)
            .putString("key", key)
            .putString("alt", altOf(call.getString("alt", "")))
            .putBoolean("live", Boolean.TRUE.equals(call.getBoolean("live", false)))
            .putBoolean("push", Boolean.TRUE.equals(call.getBoolean("push", false)))
            .apply();
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            getActivity().runOnUiThread(() -> requestPermissionForAlias("notifications", call, "afterPermission"));
            return;
        }
        apply(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        apply(call);
    }

    private void apply(PluginCall call) {
        Context c = getContext();
        Intent live = new Intent(c, LiveService.class);
        if (Prefs.live(c)) {
            try {
                // Already running: starting it again would post the fixed notification again.
                if (!LiveService.alive) ContextCompat.startForegroundService(c, live);
            } catch (Exception e) {
                call.reject("Android did not let the live connection start: " + e.getMessage());
                return;
            }
        } else {
            c.stopService(live);
        }
        if (Prefs.push(c)) {
            if (!Up.register(c)) Prefs.of(c).edit().putString("pushState", "no-distributor").apply();
        } else {
            Up.unregister(c);
        }
        call.resolve(state());
    }

    private JSObject state() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("permission", NotificationManagerCompat.from(c).areNotificationsEnabled());
        o.put("live", Prefs.live(c));
        o.put("connected", LiveService.connected);
        o.put("chosen", Prefs.of(c).getBoolean("chosen", false));
        o.put("paired", !Prefs.base(c).isEmpty() && !Prefs.key(c).isEmpty());
        o.put("push", Prefs.push(c));
        o.put("pushState", Prefs.of(c).getString("pushState", ""));
        o.put("distributor", Up.distributor(c));
        o.put("distributors", Up.count(c));
        return o;
    }

    /**
     * Asks Android for the notification permission (the app's home screen does this the first time it opens, and
     * from its settings). Android shows its question at most twice; after that the state comes back unchanged
     * and the app offers Android's own settings instead.
     */
    @PluginMethod
    public void askPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            getActivity().runOnUiThread(() -> requestPermissionForAlias("notifications", call, "afterAsk"));
            return;
        }
        call.resolve(state());
    }

    @PermissionCallback
    private void afterAsk(PluginCall call) {
        call.resolve(state());
    }

    /**
     * { live }: the app's own switch for notifications, from its home screen. It takes effect at once when the
     * phone already knows a computer; otherwise at the next connection.
     */
    @PluginMethod
    public void setLive(PluginCall call) {
        Context c = getContext();
        boolean live = Boolean.TRUE.equals(call.getBoolean("live", false));
        Prefs.of(c).edit().putBoolean("live", live).putBoolean("chosen", true).apply();
        Intent service = new Intent(c, LiveService.class);
        try {
            if (live && !Prefs.base(c).isEmpty() && !Prefs.key(c).isEmpty()) { if (!LiveService.alive) ContextCompat.startForegroundService(c, service); }
            else if (!live) c.stopService(service);
        } catch (Exception e) {
            call.reject("Android did not let the live connection start: " + e.getMessage());
            return;
        }
        call.resolve(state());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    /** { id }: the app opened this chat, so its notifications go (as in messaging apps). */
    @PluginMethod
    public void clear(PluginCall call) {
        String id = call.getString("id");
        if (id != null) Notes.cancel(getContext(), id);
        call.resolve();
    }

    /** The page a tapped notification asked for, once. */
    @PluginMethod
    public void takeOpen(PluginCall call) {
        String path = Prefs.of(getContext()).getString("open", null);
        Prefs.of(getContext()).edit().remove("open").apply();
        JSObject o = new JSObject();
        if (path != null) o.put("path", path);
        call.resolve(o);
    }

    /** Opens Android's settings for the fixed "connection" notification, where it can be turned off (the connection stays). */
    @PluginMethod
    public void hideFixed(PluginCall call) {
        Intent i = new Intent("android.settings.CHANNEL_NOTIFICATION_SETTINGS")
            .putExtra("android.provider.extra.APP_PACKAGE", getContext().getPackageName())
            .putExtra("android.provider.extra.CHANNEL_ID", Notes.CONNECTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** Opens Android's notification settings for KesherAI (each kind can be muted there). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("android.provider.extra.APP_PACKAGE", getContext().getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }
}
