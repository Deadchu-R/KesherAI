package dev.kesherai.notify;

import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

import java.nio.charset.StandardCharsets;

/**
 * UnifiedPush: a distributor app (ntfy) delivers while the computer cannot be reached directly.
 * Messages are encrypted for this phone (Web Push); the library decrypts them.
 */
public class UpService extends PushService {
    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) return;
        try {
            String json = new JSONObject().put("endpoint", endpoint.getUrl()).put("p256dh", keys.getPubKey()).put("auth", keys.getAuth()).toString();
            new Thread(() -> {
                int status = Http.send(getApplicationContext(), "PUT", "api/phone-push/endpoint", json);
                Prefs.of(getApplicationContext()).edit().putString("pushState", status >= 200 && status < 300 ? "ok" : "server:" + status).apply();
            }, "kesher-up").start();
        } catch (Exception e) {
            Prefs.of(this).edit().putString("pushState", "error").apply();
        }
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted()) return;
        try {
            Notes.handle(this, new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8)));
        } catch (Exception e) {
            // not a KesherAI message
        }
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        Prefs.of(this).edit().putString("pushState", "failed:" + reason.name()).apply();
    }

    @Override
    public void onUnregistered(String instance) {
        Prefs.of(this).edit().putString("pushState", "off").apply();
        Http.later(this, "DELETE", "api/phone-push/endpoint", null);
    }
}
