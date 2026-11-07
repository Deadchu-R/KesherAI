# Signing

Android only installs an update over an app signed with the **same key**. GitHub's build machines create a new debug key every run, so builds would not update each other. This folder holds one fixed **debug** key that every build uses, so the in-app update button works.

It is a debug key with the well-known password `android`, so anyone could sign an APK with it. That is fine for builds you install yourself from this repository's releases; the app only downloads updates from this repository on github.com.

**Before publishing the app to other people** (or to a store), use a private release key instead: create one with `keytool`, add it as the repository secrets `ANDROID_KEYSTORE_B64` (the file, base64) and `ANDROID_KEYSTORE_PASSWORD`, and switch the workflow to `assembleRelease` with that key.
