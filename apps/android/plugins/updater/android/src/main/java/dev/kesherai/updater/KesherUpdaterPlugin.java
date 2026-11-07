package dev.kesherai.updater;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Android asks once whether KesherAI may install updates.
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("needs-permission");
            return;
        }
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                dir.mkdirs();
                File apk = new File(dir, "KesherAI-update.apk");
                HttpURLConnection c = open(url);
                if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode());
                long total = c.getContentLengthLong();
                long done = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[65536];
                    int n;
                    int lastPercent = -1;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        int percent = total > 0 ? (int) (100 * done / total) : -1;
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject p = new JSObject();
                            p.put("percent", percent);
                            notifyListeners("progress", p);
                        }
                    }
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".kesher.updates", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }
}
