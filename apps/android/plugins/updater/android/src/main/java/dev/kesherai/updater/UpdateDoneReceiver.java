package dev.kesherai.updater;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;

/**
 * Android tells this receiver when its download service finishes a file, even when KesherAI is
 * in the background or closed: when it is the app update, the "tap to install" notification
 * appears.
 */
public class UpdateDoneReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
        long ours = ctx.getSharedPreferences(KesherUpdaterPlugin.PREFS, Context.MODE_PRIVATE).getLong("download", -1);
        if (id < 0 || id != ours) return;
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return;
            if (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) != DownloadManager.STATUS_SUCCESSFUL) return;
        }
        KesherUpdaterPlugin.ready(ctx.getApplicationContext(), false);
    }
}
