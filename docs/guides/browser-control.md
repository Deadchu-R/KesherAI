# Browser control

**עברית בקצרה:** הסוכן יכול לעבוד בדפדפן המובנה של KesherAI או בכרום שלך דרך התוסף. בתוסף 0.3.0 הכלים המלאים (קונסולה, רשת, צילום) דורשים הרשאה אופציונלית `debugger`; היא לא מופעלת בהתקנה ומבקשים אותה בפעם הראשונה. **שחרור הגרסה 0.3.0 לחנות מוחזק עד אישור של רועי.** מצבי אישור: ידני (ברירת מחדל), אוטומטי (מודל מקומי בודק), דילוג.

## What it does
Opens pages, reads them (accessibility snapshot), clicks and types, in the built-in browser or in your own browser through the extension (where you are signed in).

## Prerequisites
The built-in browser needs nothing. The extension needs Chrome, Edge or Brave (Firefox: page reader only) and a pairing key from Settings > Your browser.

## Steps
1. **Built-in browser:** ask the chat to open a site; it works in KesherAI's own pane with its own storage.
2. **Extension:** Settings > Your browser > download the zip, unzip, `chrome://extensions` > Developer mode > Load unpacked. Click the icon, paste the key, Connect. Details: [../BROWSER_EXTENSION.md](../BROWSER_EXTENSION.md).
3. **Chrome extension 0.3.0 and the `debugger` permission (held until the maintainer approves):** the build exists, but the store version stays 0.2.6 until the maintainer says yes, because pushing `main` uploads a changed version to the Chrome Web Store. The permission is optional: Chrome asks the first time a task needs it, or press "Allow debugging now". While active Chrome shows "KesherAI started debugging this browser"; **Cancel** there stops KesherAI at once. Tabs go in a KesherAI group and are released after 5 idle minutes.
4. **Safety mode:** Settings > Browser and computer safety. Manual asks each action (default); Auto lets a local reviewer model see only the action's metadata; Skip runs without asking (chat only, after a warning).

## Verify
Ask "open example.com and tell me the heading". An approval card appears in Manual mode.

## Troubleshooting
- Extension cannot connect: KesherAI must run on the same computer; check the key.
- No debugging tools: the permission was not granted; Firefox has none.
- Site refused: it is on a blocked or sensitive list.

## Safety
Page text is treated as data, never instructions. Sensitive sites (banking, payments, email, account settings) ask before every action. Uploads, downloads, clipboard and JavaScript always ask. Leaving the task's sites asks first.
