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
                    done(call, usedLm);
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
        stopRequested = false;
        final long started = System.currentTimeMillis();
        final StringBuilder all = new StringBuilder();
        final int[] chunks = { 0 };
        work.execute(() -> {
            final java.util.concurrent.CountDownLatch end = new java.util.concurrent.CountDownLatch(1);
            lmEnd = end;
            final Throwable[] failed = { null };
            try {
                lm.generate(system, roles, texts, text, call.getInt("topK", 40), call.getDouble("topP", 0.9), call.getDouble("temperature", 0.6), new LiteRtLm.Sink() {
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

    @Override
    protected void handleOnDestroy() {
        closeModel();
    }
}
