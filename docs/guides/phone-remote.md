# Phone app and remote access

**עברית בקצרה:** אפליקציית הטלפון היא קליפה סביב אותו ממשק; כל העבודה רצה במחשב. מזווגים עם קישור או QR מ"הגדרות ← טלפון". בבית ה-Wi-Fi מספיק; מחוץ לבית משתמשים ב-Tailscale (מומלץ) או ב"גישה מכל מקום" (מנהרת Cloudflare), או ב-Kesher Cloud להתראות ומשימות. לעולם לא פותחים פורט בנתב.

## What it does
The Android app (or the installable web app) opens the KesherAI that runs on your computer. Chat, approvals, editors and settings work the same on a 390 px screen. Nothing runs on the phone itself.

## Prerequisites
- KesherAI running on the computer. A phone on the same Wi-Fi, or Tailscale / a tunnel for outside the home.
- Android: allow "Install unknown apps" once for the browser or file manager you use to open the APK.

## Steps
1. Get the app: download `KesherAI-android.apk` from the latest release (or the workflow run's artifacts) and install it. Or open the link from step 2 in the phone's browser and use "Add to Home screen".
2. On the computer: **Settings > Phone**, turn remote access on. Scan the QR code, or copy the link, in the app's first screen.
3. Outside the home, pick one:
   - **Tailscale (recommended):** install it on the computer and the phone, sign in to the same account, and use the `100.x.x.x` link Settings > Phone shows. The connection is encrypted.
   - **Access from anywhere:** Settings > Phone starts a Cloudflare quick tunnel (downloads `cloudflared` the first time). The address changes each time; pair again.
   - **Kesher Cloud:** relays sealed tasks, approvals and notifications, not live chat. See [cloud-hub.md](cloud-hub.md).
4. Sleep: turn on "Keep this computer awake while remote access is on", or set up Wake-on-LAN ([../WAKE_ON_LAN.md](../WAKE_ON_LAN.md)); the app then offers "Wake the computer".
5. Notifications: Settings > Notifications in the app (live connection, or UnifiedPush/ntfy when the computer is unreachable).

## Verify
Open the app away from the computer: the chat list loads and a message gets an answer. Start a coding task that needs approval; the approval card appears on the phone.

## Troubleshooting
- "Cannot reach": the computer is asleep, KesherAI is closed, or the link is old. Pair again from Settings > Phone.
- QR link stopped working after a quick tunnel restart: the address changed; scan again.
- Tailscale link times out: both devices must show as connected in Tailscale.

## Safety
The pairing link carries a key; share it with nobody (revoke the phone's key in Settings > Phone). Never forward KesherAI's port on the router. Local plain-HTTP links are fine at home only.
