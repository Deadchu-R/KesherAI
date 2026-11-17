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
  - Host permission `<all_urls>`: browser tasks can be on any site the user asks for; nothing runs on a page until a
    task does.
- **Remote code:** No. All code is in the package.
- **Data usage:** Website content is read only for the user's own requests and sent only to the KesherAI app on the
  same computer (127.0.0.1). Not sold, not shared, not used for anything unrelated, ads or creditworthiness. Tick:
  "Website content" only, and the three certifications.
- **Privacy policy URL:** https://github.com/Deadchu-R/KesherAI/blob/main/PRIVACY.md

## Screenshots

1280×800: to take on the PC in Chrome with the extension installed (the side panel beside a page, asking about a page, a browser task waiting for approval); the store needs at least one.
