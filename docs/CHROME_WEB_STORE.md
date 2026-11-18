# Publishing the extension in the Chrome Web Store

Fee: $5, once, when the developer account is registered (Roee pays it himself). After that:

1. In KesherAI: Settings → Browser → download the **Chrome zip** (or `GET /api/browser/package?for=chrome`).
2. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **New item** → upload the zip.
3. Fill in the pages below (copy as is), add the screenshots (below), and **Submit for review**.

## Store listing

- **Name:** KesherAI
- **Summary (132 characters max):** Your local AI beside every page: chat with it, ask about the page, and let it do browser tasks you approve.
- **Category:** Productivity (Tools)
- **Language:** English, with Hebrew below
- **Description:**

  KesherAI is a free, open-source AI app that runs on your own computer. This extension connects your browser to it.

  • A side panel (Alt+K) with KesherAI's chat beside any page.
  • "Ask about this page": the page's text goes to a new chat on your computer.
  • Browser tasks you ask KesherAI to do (open a page, read it, click, type, take a screenshot) in your own browser,
    where you are already signed in. KesherAI asks you before each action unless you choose otherwise.

  Everything stays on your computer: the extension talks only to the KesherAI app at 127.0.0.1, with a key you paste
  from its settings. It never types into password or card fields.

  Needs the KesherAI app: https://github.com/Deadchu-R/KesherAI

  ---
  KesherAI היא אפליקציית בינה מלאכותית חינמית וקוד פתוח שרצה על המחשב שלך. התוסף מחבר אליה את הדפדפן: חלונית צד
  (Alt+K) עם הצ'אט ליד כל דף, "שאל על הדף הזה", ומשימות בדפדפן שאתה מאשר. הכל נשאר על המחשב שלך.

## Privacy practices

- **Single purpose:** Connect the browser to the KesherAI app on the same computer, to chat beside a page and do the
  browser tasks the user asks for.
- **Permission justifications:**
  - `tabs`: list the open tabs and open new ones when the user asks KesherAI to.
  - `scripting`: read a page's text and click or type in it, only for a task the user asked for.
  - `activeTab`: read the current page when the user clicks "Ask about this page".
  - `storage`: keep the connection key and port.
  - `alarms`: keep the connection to the local app alive.
  - `sidePanel`: show KesherAI's chat beside the page.
  - Optional host permission `<all_urls>` (from 0.2.6; nothing at install): the extension asks for one site the first
    time a task needs it (a small window with "Allow on this site", "Allow on all sites", "Not now"), or for all sites
    when the user presses "Allow on all sites" in its popup. Nothing runs on a page until a task does.
- **Remote code:** No. All code is in the package.
- **Data usage:** Website content is read only for the user's own requests and sent only to the KesherAI app on the
  same computer (127.0.0.1). Not sold, not shared, not used for anything unrelated, ads or creditworthiness. Tick:
  "Website content" only, and the three certifications.
- **Privacy policy URL:** https://github.com/Deadchu-R/KesherAI/blob/main/PRIVACY.md

## Screenshots

1280×800: two made 2026-11-18 with the real extension loaded in Chromium (the side panel beside a page; the connect popup), in Roee's Google Drive with the zip. More can be taken on the PC (asking about a page, a browser task waiting for approval).

## Automatic updates (set once)

After the first version is in the store, every change of the extension's version on `main` is uploaded and published
by the workflow `.github/workflows/extension-store.yml` (the Chrome Web Store API V2), and Chrome updates the
extension for everyone by itself. Chrome still reviews each version. A store extension cannot update itself from
anywhere else (Manifest V3 forbids code from outside the package), so this is the way.

1. Google Cloud Console → a project (new or existing) → APIs & Services → enable **Chrome Web Store API**.
2. IAM & Admin → Service accounts → **Create service account** (no roles needed) → its Keys → **Add key → JSON**
   (a file downloads; keep it private).
3. Chrome Web Store Developer Dashboard → **Account** → add the service account's email (one per publisher).
4. GitHub → KesherAI → Settings → Secrets and variables → Actions → New repository secret, three times:
   - `CWS_SERVICE_ACCOUNT`: the whole JSON file's text.
   - `CWS_PUBLISHER_ID`: the publisher id (in the dashboard's address: `.../devconsole/<publisher id>/...`).
   - `CWS_ITEM_ID`: the extension's id (32 letters, on its page in the dashboard).
5. Then delete the JSON file from the computer.

To publish now without a version change: Actions → "Extension to the Chrome Web Store" → Run workflow.
