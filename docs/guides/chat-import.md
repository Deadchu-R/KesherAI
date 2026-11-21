# Chat import

**עברית בקצרה:** מייבאים שיחות מ-ChatGPT, Claude, Gemini, Open WebUI ו-LM Studio מקובץ הייצוא שלהם, כדי להמשיך אותן ב-KesherAI. גם הגדרות, סוכנים ופרסונות מאפליקציות אחרות. ענפים (עריכות ותשובות חלופיות) נשמרים כענפי שיחה. הייצוא נקרא בזרם, כך שאפילו קובץ ענק לא נטען בבת אחת.

## What it does
Reads exports from other assistants and keeps the chats, with branches. Claude projects become personas.

## Prerequisites
The export file of the other app.

## Steps
1. Export from the source:
   - **ChatGPT:** Settings > Data controls > Export data (zip with `conversations.json`).
   - **Claude:** Settings > Privacy > Export data (zip with `conversations.json`, `projects.json`).
   - **Gemini:** Google Takeout > My Activity > Gemini Apps (`MyActivity.json` or the HTML).
   - **Open WebUI:** Settings > Data Controls > Export Chats. **LM Studio:** a chat's `.conversation.json` from its `conversations` folder.
2. In KesherAI open the import page (Settings, or the first-run welcome), choose the file.
3. Review the list and import. Pictures in a ChatGPT zip come with the chats; Claude attachments keep their text.

## Verify
The chats appear in the history with their titles; open one and check an edited message shows version arrows.

## Troubleshooting
- Gemini chats merged oddly: when the export does not link chats, they are grouped by time, a guess.
- Nothing found: pick the zip itself or the JSON inside, not a folder of something else.

## Safety
Exports hold your private history; delete the file after import and do not upload it elsewhere. Import limits protect against oversized or hostile files.
