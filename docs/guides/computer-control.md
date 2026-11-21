# Computer control (Windows UI Automation)

**עברית בקצרה:** הסוכן יכול לפעול באפליקציות ב-Windows דרך UI Automation (עץ הרכיבים של החלון), ובצילום מסך עם מודל ראייה כשאין עץ. כבוי כברירת מחדל; מדליקים בהגדרות. כל אפליקציה דורשת אישור בכל שיחה. כללי בטיחות בקוד: אסור UAC, כניסה, הגדרות מערכת, סיסמאות ודפדפנים; תמיד נשאל על מחיקה, תשלום וגזירה/הדבקה. בלי מצב "דילוג" לשליטה במחשב.

## What it does
Reads windows through UI Automation, clicks and types, takes screenshots, scrolls, drags and opens apps. A vision model finds things the tree does not show (games, canvases).

## Prerequisites
Windows. The feature switched on in Settings. For screenshot-based finding, a local vision model ([local-models.md](local-models.md)).

## Steps
1. Settings > Browser and computer safety: turn computer control on and choose a mode (Manual is the default; Auto uses a local reviewer for metadata only).
2. In a chat, ask for a task. KesherAI asks once per app per chat ("use this app").
3. Watch the card: for clicks at a point it shows a crop of the area around it. Approve or stop.

## Verify
Ask it to open Notepad and type a line; check the text appears.

## Troubleshooting
- Nothing happens: the switch is off, or the app was not approved in this chat.
- Wrong click: use `computer_find` (tree first, then vision) rather than guessing coordinates.
- Window hidden: move it to a visible monitor.

## Safety
Decided by code, not by the model. Never: UAC and sign-in windows, Windows Settings/Control Panel/registry, password fields, browsers (use the browser tools), typing in a terminal or file manager. Always ask: payment and banking apps, deleting files, clipboard. Skip mode does not exist for computer control.
