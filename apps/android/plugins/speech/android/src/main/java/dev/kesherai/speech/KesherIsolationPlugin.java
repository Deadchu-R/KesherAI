package dev.kesherai.speech;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;

/**
 * Makes the app's own pages "cross-origin isolated" (COOP/COEP headers), so
 * the web view allows SharedArrayBuffer and the model engine on the phone
 * (llama.cpp in WebAssembly) can use all processor cores instead of one.
 * Only pages served from the app itself (localhost) get the headers; the
 * computer's interface and websites are not touched.
 */
@CapacitorPlugin(name = "KesherIsolation")
public class KesherIsolationPlugin extends Plugin {
    @Override
    public void load() {
        Bridge bridge = getBridge();
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = super.shouldInterceptRequest(view, request);
                if (r != null && "localhost".equals(request.getUrl().getHost())) {
                    Map<String, String> h = r.getResponseHeaders() == null ? new HashMap<>() : new HashMap<>(r.getResponseHeaders());
                    h.put("Cross-Origin-Opener-Policy", "same-origin");
                    h.put("Cross-Origin-Embedder-Policy", "require-corp");
                    h.put("Cross-Origin-Resource-Policy", "same-origin");
                    r.setResponseHeaders(h);
                }
                return r;
            }
        });
    }
}
