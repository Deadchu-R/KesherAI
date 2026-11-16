package dev.kesherai.notify;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * KesherAI on the home screen (like ChatGPT's and Gemini's widgets), in the app's design: ask (a new chat on the phone),
 * a voice call, Study and the chat list. Each button opens the app at that screen on the phone itself (no computer
 * needed); nothing runs from the widget itself.
 */
public class KesherWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.kesher_widget);
            v.setOnClickPendingIntent(R.id.kw_ask, Notes.open(c, "#/phone/new", 7501));
            v.setOnClickPendingIntent(R.id.kw_voice, Notes.open(c, "#/phone/live", 7502));
            v.setOnClickPendingIntent(R.id.kw_tasks, Notes.open(c, "#/phone/study", 7503));
            v.setOnClickPendingIntent(R.id.kw_health, Notes.open(c, "#/phone/chats", 7504));
            manager.updateAppWidget(id, v);
        }
    }
}
