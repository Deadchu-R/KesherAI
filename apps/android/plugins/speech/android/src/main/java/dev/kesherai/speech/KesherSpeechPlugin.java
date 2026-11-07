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

import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;

/**
 * The phone's own speech services: recognition (speech to text, works
 * offline when the language pack is on the phone) and its voice (text to
 * speech). Used by the microphone button, reading answers aloud, and the
 * hands-free conversation mode.
 */
@CapacitorPlugin(name = "KesherSpeech", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
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
        String id = UUID.randomUUID().toString();
        ensureTts(() -> {
            if (lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate);
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
}
