package dev.kesherai.google;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Signs in with Google the way installed apps do: the phone's browser opens
 * Google's consent page, Google sends the browser back to a one-time
 * address on this phone (127.0.0.1, a random port), and the code is
 * exchanged with PKCE. The app then reads the user's own KesherAI folder in
 * Drive to find their computers. Nothing passes through any other server.
 */
@CapacitorPlugin(name = "KesherGoogle")
public class KesherGooglePlugin extends Plugin {

    private static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8");
    }

    private static JSONObject post(String url, String form) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setRequestProperty("content-type", "application/x-www-form-urlencoded");
        try (OutputStream o = c.getOutputStream()) {
            o.write(form.getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        JSONObject json = new JSONObject(sb.toString());
        if (code >= 400) throw new Exception(json.optString("error_description", json.optString("error", "Google answered " + code)));
        return json;
    }

    private static JSObject result(JSONObject t) {
        JSObject r = new JSObject();
        r.put("accessToken", t.optString("access_token"));
        if (t.has("refresh_token")) r.put("refreshToken", t.optString("refresh_token"));
        r.put("expiresIn", t.optInt("expires_in", 3600));
        r.put("idToken", t.optString("id_token", ""));
        return r;
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        final String clientId = call.getString("clientId");
        final String clientSecret = call.getString("clientSecret", "");
        final String scope = call.getString("scope", "openid email https://www.googleapis.com/auth/drive.file");
        if (clientId == null || clientId.isEmpty()) {
            call.reject("This build has no Google sign-in set up.");
            return;
        }
        new Thread(() -> {
            try (ServerSocket server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))) {
                server.setSoTimeout(5 * 60 * 1000);
                String redirect = "http://127.0.0.1:" + server.getLocalPort();
                SecureRandom rnd = new SecureRandom();
                byte[] v = new byte[32];
                rnd.nextBytes(v);
                String verifier = b64(v);
                String challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
                byte[] s = new byte[16];
                rnd.nextBytes(s);
                String state = b64(s);
                String url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + enc(clientId)
                        + "&redirect_uri=" + enc(redirect) + "&response_type=code&scope=" + enc(scope)
                        + "&access_type=offline&prompt=consent&state=" + state
                        + "&code_challenge=" + challenge + "&code_challenge_method=S256";
                Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(open);

                String code = null;
                String error = null;
                while (code == null && error == null) {
                    try (Socket sock = server.accept()) {
                        // Browsers open spare connections that never send a request: do not wait on those.
                        sock.setSoTimeout(4000);
                        BufferedReader r = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
                        String first;
                        try {
                            first = r.readLine();
                        } catch (java.net.SocketTimeoutException idle) {
                            continue;
                        }
                        if (first == null || !first.startsWith("GET ")) continue;
                        String path = first.split(" ")[1];
                        int q = path.indexOf('?');
                        String gotState = null;
                        String gotCode = null;
                        String gotError = null;
                        if (q >= 0) {
                            for (String kv : path.substring(q + 1).split("&")) {
                                int e = kv.indexOf('=');
                                if (e < 0) continue;
                                String k = kv.substring(0, e);
                                String val = URLDecoder.decode(kv.substring(e + 1), "UTF-8");
                                if (k.equals("code")) gotCode = val;
                                else if (k.equals("state")) gotState = val;
                                else if (k.equals("error")) gotError = val;
                            }
                        }
                        if (gotCode == null && gotError == null) {
                            // e.g. the browser asking for /favicon.ico
                            sock.getOutputStream().write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                            continue;
                        }
                        boolean ok = gotCode != null && state.equals(gotState);
                        String html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                                + "<body style='font-family:sans-serif;background:#111;color:#eee;text-align:center;padding:48px 16px'>"
                                + (ok ? "<h2>KesherAI ✓</h2><p>Signed in. Going back to the app… / התחברת. חוזרים לאפליקציה…</p>"
                                      : "<h2>KesherAI</h2><p>Sign-in did not finish. / ההתחברות לא הושלמה.</p>")
                                + "<p><a style='color:#9ab' href='kesherai://google-done'>KesherAI</a></p>"
                                + "<script>setTimeout(function(){location.href='kesherai://google-done'},300)</script></body>";
                        byte[] body = html.getBytes(StandardCharsets.UTF_8);
                        OutputStream out = sock.getOutputStream();
                        out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                        out.write(body);
                        out.flush();
                        if (ok) code = gotCode;
                        else error = gotError != null ? gotError : "The sign-in answer did not match.";
                    }
                }
                if (error != null) {
                    call.reject(error.equals("access_denied") ? "Sign-in was cancelled." : error);
                    return;
                }
                JSONObject t = post("https://oauth2.googleapis.com/token", "grant_type=authorization_code&code=" + enc(code)
                        + "&client_id=" + enc(clientId) + (clientSecret.isEmpty() ? "" : "&client_secret=" + enc(clientSecret))
                        + "&redirect_uri=" + enc(redirect) + "&code_verifier=" + enc(verifier));
                call.resolve(result(t));
            } catch (java.net.SocketTimeoutException e) {
                call.reject("Sign-in took too long. Try again.");
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }).start();
    }

    @PluginMethod
    public void refresh(PluginCall call) {
        final String clientId = call.getString("clientId");
        final String clientSecret = call.getString("clientSecret", "");
        final String refreshToken = call.getString("refreshToken");
        if (clientId == null || refreshToken == null) {
            call.reject("clientId and refreshToken are required");
            return;
        }
        new Thread(() -> {
            try {
                call.resolve(result(post("https://oauth2.googleapis.com/token", "grant_type=refresh_token&refresh_token=" + enc(refreshToken)
                        + "&client_id=" + enc(clientId) + (clientSecret.isEmpty() ? "" : "&client_secret=" + enc(clientSecret)))));
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }).start();
    }
}
