package dev.kesherai.share;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** The home-screen widget: buttons that open KesherAI on a new chat, talking, or taking a photo. */
public class KesherWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        int layout = R.layout.kesher_widget;
        RemoteViews views = new RemoteViews(ctx.getPackageName(), layout);
        bind(ctx, views, "widget_new", "new", 1);
        bind(ctx, views, "widget_talk", "talk", 2);
        bind(ctx, views, "widget_photo", "photo", 3);
        for (int id : ids) manager.updateAppWidget(id, views);
    }

    private void bind(Context ctx, RemoteViews views, String viewName, String action, int code) {
        int id = ctx.getResources().getIdentifier(viewName, "id", ctx.getPackageName());
        if (id == 0) return;
        // WidgetActivity keeps the action for the page and opens the app.
        Intent open = new Intent(ctx, WidgetActivity.class);
        open.putExtra("do", action);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        views.setOnClickPendingIntent(id, PendingIntent.getActivity(ctx, code, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }
}
