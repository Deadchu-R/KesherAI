package dev.kesherai.notify;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * KesherAI on the home screen (like ChatGPT's and Gemini's widgets): ask (a new chat with the box ready), speak
 * (dictation), what runs on the computer (Tasks), and health. Each button opens the app at that page; nothing runs
 * from the widget itself.
 */
public class KesherWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.kesher_widget);
            v.setOnClickPendingIntent(R.id.kw_ask, Notes.open(c, "#/", 7501));
            v.setOnClickPendingIntent(R.id.kw_voice, Notes.open(c, "#/voice", 7502));
            v.setOnClickPendingIntent(R.id.kw_tasks, Notes.open(c, "#/tasks", 7503));
            v.setOnClickPendingIntent(R.id.kw_health, Notes.open(c, "#/health", 7504));
            manager.updateAppWidget(id, v);
        }
    }
}
