package dev.kesherai.image;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Images on the phone: runs stable-diffusion.cpp's command-line program
 * (shipped in the app as libsdcli.so) with a model file the user
 * downloaded, and reports its progress.
 */
@CapacitorPlugin(name = "KesherImage")
public class KesherImagePlugin extends Plugin {
    private volatile Process running;
    private static final Pattern STEP = Pattern.compile("(\\d+)/(\\d+)");

    private File engine() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libsdcli.so");
    }

    private File models() {
        return new File(getContext().getFilesDir(), "kesher-models");
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", engine().canExecute() || engine().exists());
        call.resolve(r);
    }

    @PluginMethod
    public void generate(PluginCall call) {
        String name = call.getString("model", "").replaceAll("[\\\\/]", "");
        File model = new File(models(), name);
        if (!model.exists()) { call.reject("The image model is not downloaded."); return; }
        if (!engine().exists()) { call.reject("This build of the app has no image engine."); return; }
        if (running != null) { call.reject("An image is already being made."); return; }
        new Thread(() -> {
            File out = new File(getContext().getCacheDir(), "img-" + UUID.randomUUID() + ".png");
            try {
                int threads = Math.max(2, Math.min(8, Runtime.getRuntime().availableProcessors() - 1));
                List<String> cmd = new ArrayList<>();
                cmd.add(engine().getAbsolutePath());
                cmd.add("-m"); cmd.add(model.getAbsolutePath());
                cmd.add("-p"); cmd.add(call.getString("prompt", ""));
                String negative = call.getString("negative", "");
                if (!negative.isEmpty()) { cmd.add("-n"); cmd.add(negative); }
                cmd.add("-W"); cmd.add(String.valueOf(call.getInt("width", 512)));
                cmd.add("-H"); cmd.add(String.valueOf(call.getInt("height", 512)));
                cmd.add("--steps"); cmd.add(String.valueOf(call.getInt("steps", 16)));
                cmd.add("--cfg-scale"); cmd.add(String.valueOf(call.getFloat("cfg", 7f)));
                cmd.add("--sampling-method"); cmd.add("euler_a");
                cmd.add("-s"); cmd.add(String.valueOf(call.getInt("seed", -1)));
                cmd.add("-t"); cmd.add(String.valueOf(threads));
                cmd.add("--vae-tiling");
                cmd.add("-o"); cmd.add(out.getAbsolutePath());
                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true);
                pb.directory(getContext().getCacheDir());
                Process p = pb.start();
                running = p;
                StringBuilder tail = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                    String line;
                    int last = -1;
                    while ((line = r.readLine()) != null) {
                        tail.append(line).append('\n');
                        if (tail.length() > 4000) tail.delete(0, tail.length() - 4000);
                        // The progress bar prints "| 3/16 |" and similar.
                        for (String part : line.split("\r")) {
                            Matcher m = STEP.matcher(part);
                            if (part.contains("|") && m.find()) {
                                int step = Integer.parseInt(m.group(1));
                                if (step != last) {
                                    last = step;
                                    JSObject e = new JSObject();
                                    e.put("step", step);
                                    e.put("steps", Integer.parseInt(m.group(2)));
                                    notifyListeners("progress", e);
                                }
                            }
                        }
                    }
                }
                int code = p.waitFor();
                running = null;
                if (code != 0 || !out.exists()) {
                    String[] lines = tail.toString().trim().split("\n");
                    StringBuilder last3 = new StringBuilder();
                    for (int i = Math.max(0, lines.length - 3); i < lines.length; i++) last3.append(lines[i]).append(' ');
                    throw new Exception("The image engine stopped (" + code + "): " + last3.toString().trim());
                }
                byte[] data = new byte[(int) out.length()];
                try (FileInputStream in = new FileInputStream(out)) {
                    int off = 0, n;
                    while (off < data.length && (n = in.read(data, off, data.length - off)) > 0) off += n;
                }
                JSObject res = new JSObject();
                res.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                call.resolve(res);
            } catch (Exception e) {
                running = null;
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                out.delete();
            }
        }).start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Process p = running;
        if (p != null) p.destroy();
        call.resolve();
    }

    /** Saves a PNG to the phone's pictures (Pictures/KesherAI). */
    @PluginMethod
    public void save(PluginCall call) {
        try {
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            String name = call.getString("name", "kesherai-" + System.currentTimeMillis() + ".png").replaceAll("[\\\\/]", "");
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            if (Build.VERSION.SDK_INT >= 29) v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/KesherAI");
            Uri uri = getContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("Could not save the picture.");
            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new Exception("Could not save the picture.");
                os.write(data);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
