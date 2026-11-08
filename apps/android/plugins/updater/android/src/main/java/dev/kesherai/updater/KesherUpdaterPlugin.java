package dev.kesherai.updater;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.os.Environment;
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

    /**
     * Like {@link #open}, but tries again when GitHub's download servers are
     * briefly unwell (502/503/504, a dropped connection), waiting 2, 4, 8
     * and 16 seconds between tries.
     */
    private static HttpURLConnection openRetrying(String url) throws Exception {
        return openRetrying(url, 0);
    }

    /** {@link #openRetrying(String)} that asks for the file from byte {@code from} on (to resume a download). */
    private static HttpURLConnection openRetrying(String url, long from) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) Thread.sleep(2000L << (attempt - 1));
            try {
                HttpURLConnection c = open(url);
                if (from > 0) c.setRequestProperty("Range", "bytes=" + from + "-");
                int code = c.getResponseCode();
                if (code < 500 || attempt == 4) return c;
                c.disconnect();
                last = new Exception("GitHub answered " + code);
            } catch (java.io.IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new Exception("GitHub did not answer");
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
                HttpURLConnection c = openRetrying(url);
                if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode() + ". Try again in a few minutes.");
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
        // Android's own download service fetches the file: it keeps going while KesherAI is in the
        // background (Android freezes apps that are not on screen), resumes after a dropped
        // connection, and shows its progress in a notification. open: false only offers
        // "tap to install" when it is done.
        final boolean openWhenDone = call.getBoolean("open", true);
        final Context ctx = getContext().getApplicationContext();
        final DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        final SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long previous = prefs.getLong("download", -1);
        if (previous >= 0) dm.remove(previous);
        File apk = apkFile(ctx);
        if (apk.exists()) apk.delete();
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
            .setTitle("KesherAI")
            .setDescription("Downloading the update")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, APK_NAME)
            .addRequestHeader("User-Agent", "KesherAI-Android");
        final long id = dm.enqueue(req);
        prefs.edit().putLong("download", id).putBoolean("open", openWhenDone).apply();
        // While the app is on screen: report the percent to the page, and open the installer when done.
        new Thread(() -> {
            int lastPercent = -2;
            try {
                while (true) {
                    Thread.sleep(500);
                    try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                        if (c == null || !c.moveToFirst()) throw new Exception("The download was cancelled.");
                        int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        long got = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        int percent = total > 0 ? (int) (100 * got / total) : -1;
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject p = new JSObject();
                            p.put("percent", percent);
                            notifyListeners("progress", p);
                        }
                        if (status == DownloadManager.STATUS_SUCCESSFUL) break;
                        if (status == DownloadManager.STATUS_FAILED) {
                            int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                            throw new Exception(reason >= 500 && reason < 600 ? "GitHub answered " + reason + ". Try again in a few minutes." : "The download failed (" + reason + "). Try again.");
                        }
                    }
                }
                ready(ctx, openWhenDone && inFront);
                JSObject r = new JSObject();
                r.put("ready", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    static final String PREFS = "kesher-updater";
    static final String APK_NAME = "KesherAI-update.apk";

    static File apkFile(Context ctx) {
        return new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME);
    }

    /**
     * The download is done: a "tap to install" notification (it works while the app is in the
     * background or closed), and the installer at once when the app is on screen.
     */
    static synchronized void ready(Context ctx, boolean openNow) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getLong("download", -1) < 0) return;
        File apk = apkFile(ctx);
        if (!apk.exists()) return;
        prefs.edit().putLong("download", -1).apply();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".kesher.updates", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent tap = PendingIntent.getActivity(ctx, 7, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification note = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(ctx.getApplicationInfo().icon)
            .setContentTitle("KesherAI")
            .setContentText("The update is ready. Tap to install.")
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build();
        try {
            nm.notify(NOTE, note);
        } catch (SecurityException ignored) {
            // no permission to show notifications
        }
        if (openNow) {
            ctx.startActivity(intent);
            nm.cancel(NOTE);
        }
    }

    /** Whether the app is on screen (the installer opens by itself only then). */
    private volatile boolean inFront = true;

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        inFront = true;
        // Back on screen with an update that finished while the app was away: offer it now.
        Context ctx = getContext().getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long id = prefs.getLong("download", -1);
        if (id < 0) return;
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            if (c != null && c.moveToFirst() && c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL) ready(ctx, prefs.getBoolean("open", true));
        } catch (Exception ignored) {
            // the download service is busy; the notification comes when it finishes
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        inFront = false;
    }

    static final String CHANNEL = "kesher-updates";
    static final int NOTE = 7420;
}
