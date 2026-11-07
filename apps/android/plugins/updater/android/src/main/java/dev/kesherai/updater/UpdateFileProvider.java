package dev.kesherai.updater;

import androidx.core.content.FileProvider;

/** Shares the downloaded update with the Android installer. Its own class so it never clashes with another FileProvider. */
public class UpdateFileProvider extends FileProvider {}
