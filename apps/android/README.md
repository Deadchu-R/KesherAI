# @kesher/android

The Android app. It is a thin shell (Capacitor) around the same interface the desktop shows: on first launch you paste the connection link from **Settings → Phone** on your computer, and from then on it opens KesherAI on your computer directly. Nothing runs on the phone itself.

## Get the APK

GitHub Actions builds it on every push to `main` (`.github/workflows/android.yml`). Download `KesherAI-android.apk` from the latest workflow run's artifacts, or from a release, and open it on your phone (allow "Install unknown apps" for your browser or file manager once).

## Build it yourself

Needs JDK 21 and the Android SDK (Android Studio installs both).

```bash
pnpm install
cd apps/android
pnpm add        # once: generates the android/ project
pnpm apk        # → android/app/build/outputs/apk/debug/app-debug.apk
```

## Connecting from outside your home

The phone talks to the computer over plain HTTP with the pairing token. Inside your home network that is fine. Outside it, install [Tailscale](https://tailscale.com) on both the computer and the phone and use the `100.x.x.x` link Settings → Phone shows; Tailscale encrypts the connection. Never forward KesherAI's port on your router.

## Notifications

The app shows KesherAI's notifications itself (the `notify` plugin, `plugins/notify`): over a live connection to the computer, or through UnifiedPush (ntfy) when it cannot reach the computer. Settings → Notifications in the app turns each way on. When you build the APK yourself, add the same `configurations.configureEach { exclude group: "com.google.protobuf", module: "protobuf-javalite" }` that `.github/workflows/android.yml` adds to `app/build.gradle`. UnifiedPush's encryption library and the phone's model engines would otherwise each bring a copy of protobuf.
