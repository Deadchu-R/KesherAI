package dev.kesherai.share;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import org.json.JSONObject;

/** A widget button: keeps what it asked for (new chat, talk, photo) for the page, and opens the app. */
public class WidgetActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        try {
            String action = getIntent().getStringExtra("do");
            if (action != null && action.matches("new|talk|photo")) {
                JSONObject j = new JSONObject();
                j.put("action", action);
                KesherSharePlugin.keep(this, j);
            }
        } catch (Exception ignored) {
            // just open the app
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            open.putExtra("kesher_shared", true);
            startActivity(open);
        }
        finish();
    }
}
