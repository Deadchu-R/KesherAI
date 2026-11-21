package dev.kesherai.speech;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.util.Base64;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * The phone's own speech services: recognition (speech to text, works
 * offline when the language pack is on the phone) and its voice (text to
 * speech). Used by the microphone button, reading answers aloud, and the
 * hands-free conversation mode.
 */
@CapacitorPlugin(name = "KesherSpeech", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }), @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) })
public class KesherSpeechPlugin extends Plugin {
    private SpeechRecognizer recognizer;
    private PluginCall listening;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMic");
            return;
        }
        listen(call);
    }

    @PermissionCallback
    private void afterMic(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) listen(call);
        else call.reject("The microphone permission was refused.");
    }

    private void listen(PluginCall call) {
        call.setKeepAlive(true);
        main.post(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("This phone has no speech recognition.");
                return;
            }
            if (recognizer != null) recognizer.destroy();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            listening = call;
            recognizer.setRecognitionListener(new RecognitionListener() {
                public void onReadyForSpeech(Bundle b) {}
                public void onBeginningOfSpeech() {}
                public void onRmsChanged(float db) {
                    JSObject e = new JSObject();
                    e.put("level", Math.max(0, Math.min(1, (db + 2) / 12)));
                    notifyListeners("level", e);
                }
                public void onBufferReceived(byte[] buffer) {}
                public void onEndOfSpeech() {}
                public void onError(int error) {
                    PluginCall c = listening;
                    listening = null;
                    if (c == null) return;
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        JSObject r = new JSObject();
                        r.put("text", "");
                        c.resolve(r);
                    } else c.reject("Speech recognition error " + error);
                    c.setKeepAlive(false);
                }
                public void onResults(Bundle results) {
                    PluginCall c = listening;
                    listening = null;
                    if (c == null) return;
                    ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    JSObject r = new JSObject();
                    r.put("text", list != null && !list.isEmpty() ? list.get(0) : "");
                    c.resolve(r);
                    c.setKeepAlive(false);
                }
                public void onPartialResults(Bundle partial) {
                    ArrayList<String> list = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list == null || list.isEmpty()) return;
                    JSObject e = new JSObject();
                    e.put("text", list.get(0));
                    notifyListeners("partial", e);
                }
                public void onEvent(int type, Bundle params) {}
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            String lang = call.getString("language", "");
            if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            // Let a pause end the sentence, but not too quickly.
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
            recognizer.startListening(i);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    private void ensureTts(Runnable then) {
        if (tts != null && ttsReady) { then.run(); return; }
        if (tts == null) {
            tts = new TextToSpeech(getContext(), status -> {
                ttsReady = status == TextToSpeech.SUCCESS;
                if (ttsReady) {
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        public void onStart(String id) {}
                        public void onDone(String id) { JSObject e = new JSObject(); e.put("id", id); notifyListeners("spoken", e); }
                        public void onError(String id) { JSObject e = new JSObject(); e.put("id", id); notifyListeners("spoken", e); }
                    });
                    main.post(then);
                }
            });
        }
    }

    /** Says text aloud with the phone's voice; resolves with an id, and a "spoken" event fires when it is done. */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("language", "");
        float rate = call.getFloat("rate", 1.0f);
        // A second voice for a two-host podcast (design Podcast): the same voice, higher or lower.
        float pitch = Math.max(0.5f, Math.min(2.0f, call.getFloat("pitch", 1.0f)));
        String id = UUID.randomUUID().toString();
        ensureTts(() -> {
            if (lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            boolean queue = Boolean.TRUE.equals(call.getBoolean("queue", false));
            tts.speak(text, queue ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH, null, id);
            JSObject r = new JSObject();
            r.put("id", id);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) recognizer.destroy();
        if (tts != null) tts.shutdown();
    }

    // ---- Speech to text on the phone itself (whisper.cpp, shipped as libwhispercli.so) ----

    private File whisper() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libwhispercli.so");
    }

    /** Whether this build has the speech engine. */
    @PluginMethod
    public void whisperAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", whisper().exists());
        call.resolve(r);
    }

    /**
     * Turns a WAV recording (base64, 16 kHz mono is best) into text with a model in kesher-models
     * (downloaded by the phone page). Runs off the main thread.
     */
    @PluginMethod
    public void transcribeWav(PluginCall call) {
        String b64 = call.getString("wav", "");
        String name = call.getString("model", "").replaceAll("[\\\\/]", "");
        String lang = call.getString("language", "auto").replaceAll("[^a-z]", "");
        File model = new File(new File(getContext().getFilesDir(), "kesher-models"), name);
        if (!whisper().exists()) { call.reject("This build of the app has no speech engine."); return; }
        if (!model.exists()) { call.reject("The speech model is not downloaded."); return; }
        new Thread(() -> {
            File wav = new File(getContext().getCacheDir(), "piece-" + UUID.randomUUID() + ".wav");
            try {
                try (FileOutputStream o = new FileOutputStream(wav)) { o.write(Base64.decode(b64, Base64.DEFAULT)); }
                int threads = Math.max(2, Math.min(6, Runtime.getRuntime().availableProcessors() - 2));
                List<String> cmd = new ArrayList<>();
                cmd.add(whisper().getAbsolutePath());
                cmd.add("-m"); cmd.add(model.getAbsolutePath());
                cmd.add("-f"); cmd.add(wav.getAbsolutePath());
                cmd.add("-l"); cmd.add(lang.isEmpty() ? "auto" : lang);
                cmd.add("-t"); cmd.add(String.valueOf(threads));
                cmd.add("-nt"); cmd.add("-np");
                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.directory(getContext().getCacheDir());
                pb.redirectErrorStream(false);
                Process p = pb.start();
                StringBuilder text = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        String t = line.trim();
                        if (!t.isEmpty() && !t.startsWith("[BLANK_AUDIO]")) text.append(t).append(' ');
                    }
                }
                int code = p.waitFor();
                if (code != 0) throw new Exception("The speech engine stopped (" + code + ").");
                JSObject r = new JSObject();
                r.put("text", text.toString().trim());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Speech to text failed." : e.getMessage());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                wav.delete();
            }
        }).start();
    }

    // ---------- a lecture recorded with the screen off (LectureRecorder, a foreground service) ----------

    /** Starts recording a lecture that goes on with the screen off. Asks for the microphone first when needed. */
    @PluginMethod
    public void recStart(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "recStartAfterPermission");
            return;
        }
        startRecorder(call);
    }

    @PermissionCallback
    private void recStartAfterPermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("No access to the microphone.");
            return;
        }
        startRecorder(call);
    }

    private void startRecorder(PluginCall call) {
        if (LectureRecorder.running) {
            call.reject("A recording is already running.");
            return;
        }
        Intent i = new Intent(getContext(), LectureRecorder.class);
        if (android.os.Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
        else getContext().startService(i);
        JSObject o = new JSObject();
        o.put("started", System.currentTimeMillis());
        call.resolve(o);
    }

    /** { running, startedAt, pieces }: whether a recording runs (also after the page was reloaded). */
    @PluginMethod
    public void recState(PluginCall call) {
        JSObject o = new JSObject();
        o.put("running", LectureRecorder.running);
        o.put("startedAt", LectureRecorder.startedAt);
        synchronized (LectureRecorder.pieces) { o.put("pieces", LectureRecorder.pieces.size()); }
        call.resolve(o);
    }

    /** Stops the recording; returns its pieces: [{ file, start }] (start in seconds). */
    @PluginMethod
    public void recStop(PluginCall call) {
        new Thread(() -> {
            LectureRecorder.finishRecording(getContext());
            com.getcapacitor.JSArray list = new com.getcapacitor.JSArray();
            synchronized (LectureRecorder.pieces) {
                for (String[] p : LectureRecorder.pieces) {
                    JSObject x = new JSObject();
                    x.put("file", p[0]);
                    x.put("start", Long.parseLong(p[1]));
                    list.put(x);
                }
            }
            JSObject o = new JSObject();
            o.put("pieces", list);
            call.resolve(o);
        }).start();
    }

    /** { file } → { wav } (base64): one piece, read from the recording folder only. */
    @PluginMethod
    public void recRead(PluginCall call) {
        String name = call.getString("file", "");
        if (name == null || !name.matches("piece-\\d{4}\\.wav")) {
            call.reject("No such piece.");
            return;
        }
        File f = new File(LectureRecorder.folder(getContext()), name);
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n < 0) break;
                off += n;
            }
            JSObject o = new JSObject();
            o.put("wav", Base64.encodeToString(b, 0, off, Base64.NO_WRAP));
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Could not read the piece: " + e.getMessage());
        }
    }

    /** Removes the recording's pieces once they were turned into text. */
    @PluginMethod
    public void recClear(PluginCall call) {
        LectureRecorder.clear(getContext());
        call.resolve();
    }
}
