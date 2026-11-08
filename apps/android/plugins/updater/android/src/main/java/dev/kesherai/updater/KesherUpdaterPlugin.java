package dev.kesherai.updater;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updates for the KesherAI Android app.
 *
 * <p>{@code check({ url })} reads {@code android-version.json} from the GitHub
 * release (published by .github/workflows/android.yml) and compares its
 * {@code versionCode} with this app's. {@code install({ url })} downloads the
 * APK into the app's cache and opens the Android installer, where the user
 * confirms the update. Only https URLs on github.com are accepted.</p>
 */
@CapacitorPlugin(name = "KesherUpdater")
public class KesherUpdaterPlugin extends Plugin {

    private static boolean allowed(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return "https".equals(u.getScheme()) && "github.com".equals(u.getHost());
    }

    /** Follows GitHub's redirect to its download host. */
    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "KesherAI-Android");
        return c;
    }

    private long installedVersionCode() throws Exception {
        PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private String installedVersionName() throws Exception {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
    }

    @PluginMethod
    public void check(PluginCall call) {
        final String url = call.getString("url");
        if (!allowed(url)) {
            call.reject("Only GitHub links are allowed");
            return;
        }
        new Thread(() -> {
            try {
                HttpURLConnection c = open(url);
                if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode());
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                JSONObject latest = new JSONObject(out.toString("UTF-8"));
                long current = installedVersionCode();
                JSObject ret = new JSObject();
                ret.put("currentCode", current);
                ret.put("currentName", installedVersionName());
                ret.put("latestCode", latest.optLong("versionCode"));
                ret.put("latestName", latest.optString("versionName"));
                ret.put("apkUrl", latest.optString("apkUrl"));
                ret.put("available", latest.optLong("versionCode") > current);
                JSONArray changes = latest.optJSONArray("changes");
                if (changes != null) ret.put("changes", changes);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url");
        if (!allowed(url)) {
            call.reject("Only GitHub links are allowed");
            return;
        }
        if (call.getBoolean("open", true) && Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Android asks once whether KesherAI may install updates.
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("needs-permission");
            return;
        }
        // open: false downloads in the background and only offers "tap to install" in a notification.
        final boolean openWhenDone = call.getBoolean("open", true);
        final Context ctx = getContext().getApplicationContext();
        new Thread(() -> {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_LOW));
            NotificationCompat.Builder n = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(ctx.getApplicationInfo().icon)
                .setContentTitle("KesherAI")
                .setContentText("Downloading the update…")
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setProgress(100, 0, true);
            try {
                nm.notify(NOTE, n.build());
            } catch (SecurityException ignored) {
                // no permission to show notifications: the page still shows the progress
            }
            try {
                File dir = new File(ctx.getCacheDir(), "updates");
                dir.mkdirs();
                File apk = new File(dir, "KesherAI-update.apk");
                File part = new File(dir, "KesherAI-update.apk.part");
                // While a new build is being published, GitHub briefly has no file there (404): wait and try again.
                HttpURLConnection c = open(url);
                for (int attempt = 0; c.getResponseCode() == 404 && attempt < 6; attempt++) {
                    c.disconnect();
                    Thread.sleep(10000);
                    c = open(url);
                }
                if (c.getResponseCode() == 404) throw new Exception("GitHub is publishing a new build right now. Try again in a minute.");
                if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode());
                long total = c.getContentLengthLong();
                long done = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[65536];
                    int read;
                    int lastPercent = -1;
                    while ((read = in.read(buf)) > 0) {
                        out.write(buf, 0, read);
                        done += read;
                        int percent = total > 0 ? (int) (100 * done / total) : -1;
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject p = new JSObject();
                            p.put("percent", percent);
                            notifyListeners("progress", p);
                            n.setProgress(100, Math.max(0, percent), percent < 0).setContentText("Downloading the update… " + Math.max(0, percent) + "%");
                            try { nm.notify(NOTE, n.build()); } catch (SecurityException ignored) { /* see above */ }
                        }
                    }
                }
                if (apk.exists()) apk.delete();
                if (!part.renameTo(apk)) throw new Exception("Could not save the update.");
                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".kesher.updates", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                // Ready: a notification to install it (works while the app is in the background too).
                PendingIntent tap = PendingIntent.getActivity(ctx, 7, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification ready = new NotificationCompat.Builder(ctx, CHANNEL)
                    .setSmallIcon(ctx.getApplicationInfo().icon)
                    .setContentTitle("KesherAI")
                    .setContentText("The update is ready. Tap to install.")
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build();
                try { nm.notify(NOTE, ready); } catch (SecurityException ignored) { /* see above */ }
                if (openWhenDone && inFront) {
                    ctx.startActivity(intent);
                    nm.cancel(NOTE);
                }
                JSObject r = new JSObject();
                r.put("ready", true);
                call.resolve(r);
            } catch (Exception e) {
                nm.cancel(NOTE);
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Whether the app is on screen (the installer opens by itself only then). */
    private volatile boolean inFront = true;

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        inFront = true;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        inFront = false;
    }

    private static final String CHANNEL = "kesher-updates";
    private static final int NOTE = 7420;
}
