package dev.kesherai.llm;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs language models on the phone with Google's on-device LLM runtime
 * (LiteRT / MediaPipe), which uses the graphics chip (Adreno on Snapdragon,
 * Mali) or tuned processor code. Much faster than llama.cpp in the web view.
 * Models are .task / .litertlm files (Hugging Face: litert-community).
 */
@CapacitorPlugin(name = "KesherLlm")
public class KesherLlmPlugin extends Plugin {
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private LlmInference llm;
    private String loaded = "";
    private volatile boolean stopRequested = false;
    /** The newer runtime, for .litertlm models (Gemma 4); null until one is loaded. */
    private LiteRtLm lm;
    private boolean lmLoaded = false;

    private File dir() {
        File d = new File(getContext().getFilesDir(), "kesher-models");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static String safe(String name) {
        return name.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    /** Downloads a model file with progress events ("progress": { name, received, total }). Resumes a partial download. */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = safe(call.getString("name", "model.task"));
        String token = call.getString("token", "");
        if (url == null) { call.reject("No URL"); return; }
        new Thread(() -> {
            File dest = new File(dir(), name);
            File part = new File(dir(), name + ".part");
            try {
                long have = part.exists() ? part.length() : 0;
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", "KesherAI");
                if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
                if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
                int code = c.getResponseCode();
                if (code == 401 || code == 403) throw new Exception("This model needs a Hugging Face sign-in (it is gated).");
                if (code >= 400) throw new Exception("Download failed: HTTP " + code);
                boolean append = code == 206;
                if (!append) have = 0;
                long total = c.getContentLengthLong() + have;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part, append)) {
                    byte[] buf = new byte[1 << 16];
                    long got = have, lastSent = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        long now = System.currentTimeMillis();
                        if (now - lastSent > 400) {
                            lastSent = now;
                            JSObject e = new JSObject();
                            e.put("name", name);
                            e.put("received", got);
                            e.put("total", total);
                            notifyListeners("progress", e);
                        }
                    }
                }
                if (!part.renameTo(dest)) throw new Exception("Could not save the model.");
                JSObject r = new JSObject();
                r.put("name", name);
                r.put("size", dest.length());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray arr = new JSArray();
        File[] files = dir().listFiles();
        if (files != null) for (File f : files) {
            if (f.getName().endsWith(".part")) continue;
            JSObject o = new JSObject();
            o.put("name", f.getName());
            o.put("size", f.length());
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("models", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = safe(call.getString("name", ""));
        if (name.equals(loaded)) closeModel();
        boolean ok = new File(dir(), name).delete();
        new File(dir(), name + ".part").delete();
        JSObject r = new JSObject();
        r.put("removed", ok);
        call.resolve(r);
    }

    private void closeModel() {
        if (lm != null) { try { lm.close(); } catch (Exception ignored) {} }
        lmLoaded = false;
        if (llm != null) {
            try { llm.close(); } catch (Exception ignored) {}
        }
        llm = null;
        loaded = "";
    }

    /** Loads a model: backend "gpu" (default) or "cpu". Falls back to the processor if the graphics chip cannot. */
    @PluginMethod
    public void load(PluginCall call) {
        String name = safe(call.getString("name", ""));
        String backend = call.getString("backend", "gpu");
        int maxTokens = call.getInt("maxTokens", 2048);
        work.execute(() -> {
            try {
                if (name.equals(loaded) && (llm != null || lmLoaded)) { done(call, backend); return; }
                closeModel();
                File f = new File(dir(), name);
                if (!f.exists()) throw new Exception("The model is not downloaded.");
                if (name.endsWith(".litertlm")) {
                    if (lm == null) lm = new LiteRtLm(getContext().getCacheDir().getPath());
                    String usedLm = lm.load(f.getAbsolutePath(), !"cpu".equals(backend));
                    lmLoaded = true;
                    loaded = name;
                    JSObject r = new JSObject();
                    r.put("name", loaded);
                    r.put("backend", usedLm);
                    r.put("vision", lm.getSeesImages());
                    call.resolve(r);
                    return;
                }
                String used = backend;
                try {
                    llm = create(f, maxTokens, "cpu".equals(backend) ? LlmInference.Backend.CPU : LlmInference.Backend.GPU);
                } catch (Exception gpuFailed) {
                    if ("cpu".equals(backend)) throw gpuFailed;
                    used = "cpu";
                    llm = create(f, maxTokens, LlmInference.Backend.CPU);
                }
                loaded = name;
                done(call, used);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    private LlmInference create(File f, int maxTokens, LlmInference.Backend backend) {
        LlmInference.LlmInferenceOptions options = LlmInference.LlmInferenceOptions.builder()
            .setModelPath(f.getAbsolutePath())
            .setMaxTokens(maxTokens)
            .setPreferredBackend(backend)
            .build();
        return LlmInference.createFromOptions(getContext(), options);
    }

    private void done(PluginCall call, String backend) {
        JSObject r = new JSObject();
        r.put("name", loaded);
        r.put("backend", backend);
        call.resolve(r);
    }

    /** Generates an answer for a prompt (already in the model's chat format), streaming "token" events. */
    @PluginMethod
    public void generate(PluginCall call) {
        String prompt = call.getString("prompt", "");
        if (lmLoaded) { generateLm(call); return; }
        if (llm == null) { call.reject("No model is loaded."); return; }
        final int topK = call.getInt("topK", 40);
        final float topP = call.getFloat("topP", 0.9f);
        final float temperature = call.getFloat("temperature", 0.6f);
        stopRequested = false;
        final long started = System.currentTimeMillis();
        final StringBuilder all = new StringBuilder();
        final int[] chunks = { 0 };
        work.execute(() -> {
            LlmInferenceSession s = null;
            try {
                // A fresh session per answer, with sampling that keeps small models from rambling.
                s = LlmInferenceSession.createFromOptions(llm, LlmInferenceSession.LlmInferenceSessionOptions.builder()
                    .setTopK(topK)
                    .setTopP(topP)
                    .setTemperature(temperature)
                    .build());
                session = s;
                s.addQueryChunk(prompt);
                s.generateResponseAsync((partial, isDone) -> {
                    if (partial != null && !partial.isEmpty() && !stopRequested) {
                        all.append(partial);
                        chunks[0]++;
                        JSObject e = new JSObject();
                        e.put("text", partial);
                        notifyListeners("token", e);
                    }
                }).get();
                finish(call, all, chunks[0], started, stopRequested);
            } catch (Exception e) {
                if (stopRequested) finish(call, all, chunks[0], started, true);
                else call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                session = null;
                if (s != null) try { s.close(); } catch (Exception ignored) { }
            }
        });
    }

    private volatile LlmInferenceSession session;

    private volatile java.util.concurrent.CountDownLatch lmEnd;

    /** LiteRT-LM: plain messages (the runtime applies the model's own chat format). */
    private void generateLm(PluginCall call) {
        final String system = call.getString("system", "");
        final String text = call.getString("text", "");
        final java.util.List<String> roles = new java.util.ArrayList<>();
        final java.util.List<String> texts = new java.util.ArrayList<>();
        JSArray history = call.getArray("history");
        if (history != null) for (int i = 0; i < history.length(); i++) {
            org.json.JSONObject m = history.optJSONObject(i);
            if (m == null) continue;
            roles.add(m.optString("role", "user"));
            texts.add(m.optString("text", ""));
        }
        // Pictures arrive as data URLs; the runtime reads files.
        final java.util.List<String> images = new java.util.ArrayList<>();
        JSArray imgs = call.getArray("images");
        if (imgs != null) for (int i = 0; i < imgs.length(); i++) {
            String url = imgs.optString(i, "");
            int comma = url.indexOf(',');
            if (!url.startsWith("data:") || comma < 0) continue;
            try {
                byte[] bytes = android.util.Base64.decode(url.substring(comma + 1), android.util.Base64.DEFAULT);
                File f = new File(getContext().getCacheDir(), "kesher-img-" + i + (url.startsWith("data:image/png") ? ".png" : ".jpg"));
                try (FileOutputStream o = new FileOutputStream(f)) { o.write(bytes); }
                images.add(f.getAbsolutePath());
            } catch (Exception ignored) { }
        }
        stopRequested = false;
        final long started = System.currentTimeMillis();
        final StringBuilder all = new StringBuilder();
        final int[] chunks = { 0 };
        work.execute(() -> {
            final java.util.concurrent.CountDownLatch end = new java.util.concurrent.CountDownLatch(1);
            lmEnd = end;
            final Throwable[] failed = { null };
            try {
                lm.generate(system, roles, texts, text, images, call.getInt("topK", 40), call.getDouble("topP", 0.9), call.getDouble("temperature", 0.6), new LiteRtLm.Sink() {
                    @Override public void token(String t) {
                        if (stopRequested || t == null || t.isEmpty()) return;
                        all.append(t);
                        chunks[0]++;
                        JSObject e = new JSObject();
                        e.put("text", t);
                        notifyListeners("token", e);
                    }
                    @Override public void done(Throwable error) {
                        failed[0] = error;
                        end.countDown();
                    }
                });
                end.await(10, java.util.concurrent.TimeUnit.MINUTES);
                lmEnd = null;
                if (failed[0] != null && !stopRequested) call.reject(failed[0].getMessage() == null ? failed[0].toString() : failed[0].getMessage());
                else finish(call, all, chunks[0], started, stopRequested);
            } catch (Exception e) {
                if (stopRequested) finish(call, all, chunks[0], started, true);
                else call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    private void finish(PluginCall call, StringBuilder all, int tokens, long started, boolean stopped) {
        JSObject r = new JSObject();
        r.put("text", all.toString());
        r.put("tokens", tokens);
        r.put("ms", System.currentTimeMillis() - started);
        r.put("stopped", stopped);
        call.resolve(r);
    }

    /** Stops showing the answer (the runtime finishes the current one in the background). */
    /**
     * Phone Health (asked for: the same as PC Health, in the phone app): storage, memory, battery and the models'
     * size, from Android's own APIs (nothing is changed). The app's page and model turn it into what to do.
     */
    @PluginMethod
    public void health(PluginCall call) {
        JSObject out = new JSObject();
        try {
            android.os.StatFs fs = new android.os.StatFs(android.os.Environment.getDataDirectory().getPath());
            out.put("storageFree", fs.getAvailableBytes());
            out.put("storageTotal", fs.getTotalBytes());
        } catch (Exception ignored) {}
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
            android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            out.put("ramFree", mi.availMem);
            out.put("ramTotal", mi.totalMem);
            out.put("lowMemory", mi.lowMemory);
        } catch (Exception ignored) {}
        try {
            android.content.Intent b = getContext().registerReceiver(null, new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            if (b != null) {
                int level = b.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
                int scale = b.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100);
                out.put("batteryPercent", level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : -1);
                out.put("batteryTempC", b.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
                int health = b.getIntExtra(android.os.BatteryManager.EXTRA_HEALTH, 0);
                out.put("batteryHealth", health == android.os.BatteryManager.BATTERY_HEALTH_GOOD ? "good" : health == android.os.BatteryManager.BATTERY_HEALTH_OVERHEAT ? "overheat" : health == android.os.BatteryManager.BATTERY_HEALTH_DEAD ? "dead" : health == android.os.BatteryManager.BATTERY_HEALTH_COLD ? "cold" : "unknown");
                int plugged = b.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0);
                out.put("charging", plugged != 0);
                out.put("batteryVoltageMv", b.getIntExtra(android.os.BatteryManager.EXTRA_VOLTAGE, 0));
                // Charge cycles (Android 14+, when the phone reports them), as Pixel's and Samsung's battery pages show.
                if (android.os.Build.VERSION.SDK_INT >= 34) {
                    int cycles = b.getIntExtra("android.os.extra.CYCLE_COUNT", -1);
                    if (cycles >= 0) out.put("batteryCycles", cycles);
                }
                // The battery's wear, as AccuBattery estimates it: the charge it holds now (charge counter at this
                // percent) against its designed capacity (the phone's power profile).
                android.os.BatteryManager bm = (android.os.BatteryManager) getContext().getSystemService(android.content.Context.BATTERY_SERVICE);
                int counterUah = bm != null ? bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER) : 0;
                if (counterUah > 0 && level > 10 && scale > 0) out.put("batteryNowFullMah", Math.round(counterUah / 1000f / (level / (float) scale)));
                double design = designCapacityMah();
                if (design > 0) out.put("batteryDesignMah", Math.round(design));
            }
        } catch (Exception ignored) {}
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            if (pm != null) {
                out.put("powerSave", pm.isPowerSaveMode());
                // 0 none … 6 shutdown (Android 10+): how hot the whole phone is.
                if (android.os.Build.VERSION.SDK_INT >= 29) out.put("thermal", pm.getCurrentThermalStatus());
            }
        } catch (Exception ignored) {}
        out.put("uptimeHours", Math.round(android.os.SystemClock.elapsedRealtime() / 3_600_000.0));
        if (android.os.Build.VERSION.SDK_INT >= 23) out.put("securityPatch", android.os.Build.VERSION.SECURITY_PATCH);
        long models = 0;
        File[] files = dir().listFiles();
        if (files != null) for (File f : files) models += f.length();
        out.put("modelsBytes", models);
        out.put("model", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        out.put("android", android.os.Build.VERSION.RELEASE);
        call.resolve(out);
    }

    /** The battery's designed capacity in mAh, from the phone's power profile (0 when the phone does not say). */
    private double designCapacityMah() {
        try {
            Class<?> c = Class.forName("com.android.internal.os.PowerProfile");
            Object profile = c.getConstructor(android.content.Context.class).newInstance(getContext());
            Object v = c.getMethod("getBatteryCapacity").invoke(profile);
            return v instanceof Double ? (Double) v : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRequested = true;
        if (lm != null && lmLoaded) {
            lm.stop();
            java.util.concurrent.CountDownLatch e = lmEnd;
            if (e != null) e.countDown();
        }
        // Really stop the runtime when this version can (cancelGenerateResponseAsync), so the next answer starts at once.
        LlmInferenceSession s = session;
        if (s != null) try { s.getClass().getMethod("cancelGenerateResponseAsync").invoke(s); } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void unload(PluginCall call) {
        work.execute(() -> {
            closeModel();
            call.resolve();
        });
    }

    // ---------- Phone Health: apps and games, cleaning, memory (as on the computer, within what Android allows) ----------

    /** Whether the person gave "Usage access" (needed for apps' sizes and last use). */
    private boolean usageAccess() {
        try {
            android.app.AppOpsManager ops = (android.app.AppOpsManager) getContext().getSystemService(android.content.Context.APP_OPS_SERVICE);
            int mode = android.os.Build.VERSION.SDK_INT >= 29
                ? ops.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getContext().getPackageName())
                : ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getContext().getPackageName());
            return mode == android.app.AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * The apps the person installed (and updated system apps), with games marked, their sizes (app, data, cache) and
     * last use when "Usage access" is on. Read only.
     */
    @PluginMethod
    public void apps(PluginCall call) {
        work.execute(() -> {
            JSObject out = new JSObject();
            boolean usage = usageAccess();
            out.put("usageAccess", usage);
            JSArray list = new JSArray();
            try {
                android.content.pm.PackageManager pm = getContext().getPackageManager();
                java.util.Map<String, Long> lastUsed = new java.util.HashMap<>();
                if (usage) {
                    android.app.usage.UsageStatsManager um = (android.app.usage.UsageStatsManager) getContext().getSystemService(android.content.Context.USAGE_STATS_SERVICE);
                    long now = System.currentTimeMillis();
                    java.util.Map<String, android.app.usage.UsageStats> stats = um.queryAndAggregateUsageStats(now - 90L * 24 * 3600 * 1000, now);
                    for (java.util.Map.Entry<String, android.app.usage.UsageStats> e : stats.entrySet()) lastUsed.put(e.getKey(), e.getValue().getLastTimeUsed());
                }
                for (android.content.pm.ApplicationInfo ai : pm.getInstalledApplications(0)) {
                    boolean system = (ai.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
                    boolean updated = (ai.flags & android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
                    if (system && !updated) continue;
                    if (pm.getLaunchIntentForPackage(ai.packageName) == null) continue;
                    JSObject a = new JSObject();
                    a.put("package", ai.packageName);
                    a.put("name", String.valueOf(pm.getApplicationLabel(ai)));
                    boolean game = android.os.Build.VERSION.SDK_INT >= 26 ? ai.category == android.content.pm.ApplicationInfo.CATEGORY_GAME : (ai.flags & android.content.pm.ApplicationInfo.FLAG_IS_GAME) != 0;
                    a.put("game", game);
                    a.put("system", system);
                    if (usage && android.os.Build.VERSION.SDK_INT >= 26) {
                        try {
                            android.app.usage.StorageStatsManager ssm = (android.app.usage.StorageStatsManager) getContext().getSystemService(android.content.Context.STORAGE_STATS_SERVICE);
                            android.app.usage.StorageStats st = ssm.queryStatsForPackage(ai.storageUuid, ai.packageName, android.os.Process.myUserHandle());
                            a.put("appBytes", st.getAppBytes());
                            a.put("dataBytes", st.getDataBytes());
                            a.put("cacheBytes", st.getCacheBytes());
                        } catch (Exception ignored) {}
                    }
                    Long used = lastUsed.get(ai.packageName);
                    if (used != null && used > 0) a.put("lastUsed", used);
                    list.put(a);
                }
            } catch (Exception e) {
                out.put("error", e.getMessage());
            }
            out.put("apps", list);
            call.resolve(out);
        });
    }

    /** Opens a settings page the person uses themselves: usage access, all-files access, or one app's info page. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String what = call.getString("what", "");
        String pkg = call.getString("package", getContext().getPackageName());
        android.content.Intent i;
        if ("usage".equals(what)) i = new android.content.Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS);
        else if ("files".equals(what) && android.os.Build.VERSION.SDK_INT >= 30) i = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, android.net.Uri.parse("package:" + getContext().getPackageName()));
        else if ("app".equals(what)) i = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + pkg));
        else if ("storage".equals(what)) i = new android.content.Intent(android.provider.Settings.ACTION_INTERNAL_STORAGE_SETTINGS);
        else {
            call.reject("Unknown page.");
            return;
        }
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Android's own uninstall window for one app (the person confirms there). */
    @PluginMethod
    public void uninstall(PluginCall call) {
        String pkg = call.getString("package", "");
        if (pkg == null || !pkg.matches("[A-Za-z0-9_.]{1,200}") || pkg.equals(getContext().getPackageName())) {
            call.reject("Not an app.");
            return;
        }
        android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_DELETE, android.net.Uri.parse("package:" + pkg));
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * Android's own "clear all apps' cache" window (Android 11+). It needs "All files access" once: without it, the
     * answer says so and the page opens that setting.
     */
    @PluginMethod
    public void clearAllCaches(PluginCall call) {
        JSObject out = new JSObject();
        if (android.os.Build.VERSION.SDK_INT < 30) {
            out.put("result", "old-android");
            call.resolve(out);
            return;
        }
        if (!android.os.Environment.isExternalStorageManager()) {
            out.put("result", "needs-files-access");
            call.resolve(out);
            return;
        }
        try {
            android.content.Intent i = new android.content.Intent(android.os.storage.StorageManager.ACTION_CLEAR_APP_CACHE);
            getActivity().startActivityForResult(i, 4711);
            out.put("result", "asked");
        } catch (Exception e) {
            out.put("result", "failed");
            out.put("error", e.getMessage());
        }
        call.resolve(out);
    }

    /** KesherAI's own cache on the phone (pictures and pages it kept), emptied; the models stay. */
    @PluginMethod
    public void clearOwnCache(PluginCall call) {
        long freed = 0;
        freed += emptyDir(getContext().getCacheDir());
        File ext = getContext().getExternalCacheDir();
        if (ext != null) freed += emptyDir(ext);
        JSObject out = new JSObject();
        out.put("freed", freed);
        call.resolve(out);
    }

    /** Deletes a folder's contents (not following links), and returns the bytes freed. */
    private long emptyDir(File d) {
        long freed = 0;
        File[] kids = d == null ? null : d.listFiles();
        if (kids == null) return 0;
        for (File f : kids) {
            // A link is not followed (its target may be anywhere).
            try {
                if (!f.getCanonicalPath().equals(new File(d.getCanonicalFile(), f.getName()).getPath())) continue;
            } catch (Exception e) {
                continue;
            }
            if (f.isDirectory()) {
                freed += emptyDir(f);
                f.delete();
            } else {
                long n = f.length();
                if (f.delete()) freed += n;
            }
        }
        return freed;
    }

    /**
     * Frees memory: the phone model out of memory, and apps waiting in the background closed (Android lets an app
     * end only background ones; the app on screen and its own services stay).
     */
    @PluginMethod
    public void freeMemory(PluginCall call) {
        work.execute(() -> {
            JSObject out = new JSObject();
            android.app.ActivityManager am = (android.app.ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
            android.app.ActivityManager.MemoryInfo before = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(before);
            closeModel();
            int closed = 0;
            try {
                for (android.content.pm.ApplicationInfo ai : getContext().getPackageManager().getInstalledApplications(0)) {
                    if ((ai.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0 && (ai.flags & android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0) continue;
                    if (ai.packageName.equals(getContext().getPackageName())) continue;
                    am.killBackgroundProcesses(ai.packageName);
                    closed++;
                }
            } catch (Exception ignored) {}
            try { Thread.sleep(1200); } catch (InterruptedException ignored) {}
            android.app.ActivityManager.MemoryInfo after = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(after);
            out.put("freed", Math.max(0, after.availMem - before.availMem));
            out.put("ramFree", after.availMem);
            out.put("checked", closed);
            call.resolve(out);
        });
    }

    /** The phone's trash (Android 11+: deleted photos, videos and files kept for 30 days): count and size. */
    @PluginMethod
    public void trash(PluginCall call) {
        JSObject out = new JSObject();
        if (android.os.Build.VERSION.SDK_INT < 30) {
            out.put("supported", false);
            call.resolve(out);
            return;
        }
        out.put("supported", true);
        out.put("filesAccess", android.os.Environment.isExternalStorageManager());
        long bytes = 0;
        int count = 0;
        android.os.Bundle q = new android.os.Bundle();
        q.putInt(android.provider.MediaStore.QUERY_ARG_MATCH_TRASHED, android.provider.MediaStore.MATCH_ONLY);
        try (android.database.Cursor c = getContext().getContentResolver().query(android.provider.MediaStore.Files.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL), new String[] { android.provider.MediaStore.MediaColumns._ID, android.provider.MediaStore.MediaColumns.SIZE }, q, null)) {
            if (c != null) while (c.moveToNext()) {
                count++;
                bytes += c.getLong(1);
            }
        } catch (Exception e) {
            out.put("error", e.getMessage());
        }
        out.put("items", count);
        out.put("bytes", bytes);
        call.resolve(out);
    }

    /** Empties the phone's trash: Android shows its own confirmation for the items (Android 11+). */
    @PluginMethod
    public void emptyTrash(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 30) {
            call.reject("Android 11 or newer.");
            return;
        }
        java.util.ArrayList<android.net.Uri> uris = new java.util.ArrayList<>();
        android.os.Bundle q = new android.os.Bundle();
        q.putInt(android.provider.MediaStore.QUERY_ARG_MATCH_TRASHED, android.provider.MediaStore.MATCH_ONLY);
        android.net.Uri base = android.provider.MediaStore.Files.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL);
        try (android.database.Cursor c = getContext().getContentResolver().query(base, new String[] { android.provider.MediaStore.MediaColumns._ID }, q, null)) {
            if (c != null) while (c.moveToNext()) uris.add(android.content.ContentUris.withAppendedId(base, c.getLong(0)));
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        JSObject out = new JSObject();
        out.put("items", uris.size());
        if (uris.isEmpty()) {
            call.resolve(out);
            return;
        }
        try {
            android.app.PendingIntent pi = android.provider.MediaStore.createDeleteRequest(getContext().getContentResolver(), uris);
            getActivity().startIntentSenderForResult(pi.getIntentSender(), 4712, null, 0, 0, 0);
            out.put("asked", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        closeModel();
    }
}
