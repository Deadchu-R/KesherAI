package dev.kesherai.share;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Receives "Share → KesherAI": copies the shared files into the app's cache,
 * keeps the text and the files for the page to take, and opens the app.
 */
public class ShareActivity extends Activity {
    /** Files larger than this are left out (the computer gets each file over the network). */
    private static final long MAX_BYTES = 50L * 1024 * 1024;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        try {
            Intent in = getIntent();
            JSONObject shared = new JSONObject();
            String text = in.getStringExtra(Intent.EXTRA_TEXT);
            String subject = in.getStringExtra(Intent.EXTRA_SUBJECT);
            if (text != null) shared.put("text", text);
            if (subject != null) shared.put("subject", subject);
            ArrayList<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) {
                ArrayList<Uri> list = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            } else {
                Uri one = in.getParcelableExtra(Intent.EXTRA_STREAM);
                if (one != null) uris.add(one);
            }
            JSONArray files = new JSONArray();
            File dir = new File(getCacheDir(), "shared");
            dir.mkdirs();
            for (Uri uri : uris) {
                JSONObject f = copy(uri, dir);
                if (f != null) files.put(f);
                if (files.length() >= 10) break;
            }
            shared.put("files", files);
            KesherSharePlugin.keep(this, shared);
        } catch (Exception ignored) {
            // nothing usable was shared
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            open.putExtra("kesher_shared", true);
            startActivity(open);
        }
        finish();
    }

    private JSONObject copy(Uri uri, File dir) {
        String name = "shared";
        long size = -1;
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && c.getString(n) != null) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
            }
        } catch (Exception ignored) {
            // keep the defaults
        }
        if (size > MAX_BYTES) return null;
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        File out = new File(dir, UUID.randomUUID().toString().substring(0, 8) + "-" + safe);
        long total = 0;
        try (InputStream is = getContentResolver().openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (is == null) return null;
            byte[] buf = new byte[64 * 1024];
            int r;
            while ((r = is.read(buf)) > 0) {
                total += r;
                if (total > MAX_BYTES) { os.close(); out.delete(); return null; }
                os.write(buf, 0, r);
            }
            JSONObject f = new JSONObject();
            f.put("path", out.getAbsolutePath());
            f.put("name", safe);
            String mime = getContentResolver().getType(uri);
            f.put("mime", mime != null ? mime : "application/octet-stream");
            f.put("size", total);
            return f;
        } catch (Exception e) {
            out.delete();
            return null;
        }
    }
}
