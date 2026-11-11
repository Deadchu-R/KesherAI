# מדריך קריאה לקוד של KesherAI

המדריך הזה הוא לקריאה בסוף שבוע. הוא מסביר איך KesherAI עובד מאחורי הקלעים, באיזה סדר כדאי לקרוא את הקוד, ואיפה בדיוק נמצא כל דבר. שמות הקבצים והפונקציות כתובים כמו בקוד, ואפשר לחפש אותם (Ctrl+Shift+F ב-VS Code).

ההשלמה באנגלית: [ARCHITECTURE.md](ARCHITECTURE.md) מציג את התמונה הגדולה. המדריך הזה נכנס לפרטים.

---

## 1. כמה זה מסובך?

- **בערך 68,000 שורות קוד**, בלי הבדיקות: ‏core כ-36 אלף, ממשק הווב כ-24 אלף, והשאר קטנים. עוד כ-20 אלף שורות הן בדיקות.
- **אין צורך לקרוא הכל.** רוב הקוד הוא מסכים ופיצ'רים נפרדים. כ-25 קבצים (בערך 12 אלף שורות) מסבירים 80% מאיך שהדברים עובדים. זה מסלול הקריאה בסעיף 7.
- **הכל מתועד:**
  - כמעט כל קובץ מתחיל בהסבר של מה הוא עושה ולמה.
  - כל פונקציה או מחלקה שמיוצאת (`export`) מקבלת הערת JSDoc (`/** … */`). ‏lint לא מעביר קוד בלי הערה כזו.
  - בתוך הקוד יש הערות במקומות שההחלטה לא מובנת מאליה, ובמיוחד באגים שתוקנו: "found on the phone", "found on the PC", "found in CI".
  - הבדיקות (`*.test.ts`) הן תיעוד חי: השם של כל בדיקה הוא משפט שאומר מה הקוד אמור לעשות.
- **רמת קושי:** אם אתה מכיר C# ו-Unreal, ‏TypeScript ירגיש מוכר: מחלקות, טיפוסים, async/await (כמו Task ב-C#). מה שחדש הוא בעיקר ה-ecosystem: ‏Node, ‏Fastify, ‏React. ראה סעיף 2.

---

## 2. שפות, כלים וספריות

### שפות
| שפה | איפה |
| --- | --- |
| **TypeScript** (מצב strict) | כמעט הכל: השרת, הסוכן, הממשק והאפליקציה לשולחן העבודה |
| **TSX** (‏TypeScript עם תגיות HTML של React) | כל המסכים ב-`apps/web/src` |
| **CSS** | קובץ אחד גדול: `apps/web/src/styles.css`. משתני עיצוב בראשו (`--accent`, `--panel`…) |
| **Java** | התוספים הקטנים של אפליקציית האנדרואיד (`apps/android/plugins/*/android`): מצלמה, דיבור, עדכון, Wake-on-LAN… |
| **JSON** | הגדרות (`config.json`), שיחות שמורות, הלוח (`board.json`) |

### סביבת ריצה וכלים
| כלי | מה הוא עושה אצלנו |
| --- | --- |
| **Node.js 22** | מריץ את השרת (`packages/core`). זה JavaScript מחוץ לדפדפן |
| **pnpm** | מנהל החבילות. ‏workspace אחד עם חבילות רבות (`packages/*`, `apps/*`) |
| **tsc** (‏TypeScript compiler) | בונה את החבילות ל-`dist/`, ובודק טיפוסים (`pnpm typecheck`) |
| **Vite** | בונה את ממשק הווב ומריץ אותו בפיתוח (`pnpm dev`) |
| **ESLint** | בודק סגנון וחוקים, כולל חובת JSDoc (`pnpm lint`) |
| **node:test + tsx** | הבדיקות (`pnpm test`): ‏test runner מובנה של Node, בלי Jest |
| **Electron 33** | עוטף את הכל לאפליקציה ל-Windows/Mac (`apps/desktop`) |
| **Capacitor 8** | עוטף את ממשק הווב לאפליקציית אנדרואיד (`apps/android`) |
| **GitHub Actions** | בונה, בודק ומשחרר גרסאות (`.github/workflows`) |

### ספריות מרכזיות (ולמה בחרנו בהן)
**שרת (`packages/core`):**
- **fastify**: שרת ה-HTTP, כמו Express אבל מהיר יותר ועם בדיקת קלט מובנית. כל ה-API עובר דרכו (`/api/...`).
- ‏**@fastify/websocket**: הטרמינל בממשק. ‏**@fastify/static**: מגיש את הממשק. ‏**@fastify/cors**, ‏**@fastify/compress**.
- **zod**: בודק שהקלט מהרשת הוא באמת מה שציפינו (schemas ב-`packages/shared`).
- **@lydell/node-pty**: טרמינל אמיתי (PowerShell/bash) שהממשק מתחבר אליו.
- **@agentclientprotocol/sdk**: הפרוטוקול (ACP) שבו מדברים עם Antigravity CLI.
- **ws**: ‏WebSocket בצד הלקוח. ‏**fflate**: פתיחת zip. ‏**tesseract.js**: קריאת טקסט מתמונות (OCR).

**סוכן (`packages/agent`):**
- **diff**: מייצר את ה-diff שמוצג בכרטיס האישור. ‏**mammoth**: קורא Word. ‏**unpdf**: קורא PDF.

**ממשק (`apps/web`):**
- **React 19**: הממשק כולו. כל מסך הוא פונקציה שמחזירה JSX.
- **CodeMirror 6** ו-**Monaco**: עורכי הקוד בעמוד ה-IDE.
- **@xterm/xterm**: חלון הטרמינל.
- **@huggingface/transformers**: מודלים קטנים שרצים בדפדפן עצמו.
- **qrcode**: קוד ה-QR לחיבור הטלפון.
- גופנים מ-**@fontsource** (Rubik, Heebo…) מקומית, בלי Google Fonts, כדי שהכל יעבוד גם בלי אינטרנט.

**אנדרואיד:** ‏**@wllama/wllama** (מודל קטן שרץ בטלפון עצמו) ותוספי `capacitor-kesher-*` משלנו.

**מנוע המודלים** הוא לא ספרייה אלא תוכנה נפרדת: ‏**llama.cpp** (`llama-server`), ש-KesherAI מוריד מ-GitHub ומריץ כתהליך בן. יצירת תמונות היא ב-**ComfyUI**, גם הוא תהליך נפרד.

---

## 3. מפת התיקיות

```
packages/                ← הלוגיקה (בלי מסכים)
  shared/                טיפוסים ו-schemas משותפים. אין בו I/O בכלל
  providers/             "ספקי מודלים": llama.cpp, ‏LM Studio, ‏Ollama, ‏OpenAI, ‏Anthropic, ‏ComfyUI…
  downloads/             הורדת מודלים מ-Hugging Face, וזיהוי חומרה
  skills/                קבצי SKILL.md (הוראות לסוכן)
  plugin-sdk/            מה שתוסף (plugin) מקבל כדי להרחיב את KesherAI
  agent/                 הסוכן: הלולאה שקוראת למודל ומריצה כלים, הרשאות, כלי קוד
  core/                  השרת: מחבר את כל השאר. כאן רוב הקוד
    src/server.ts        ← נקודת ההתחלה. כל השאר נוצר כאן
    src/routes/          51 קבצי API, אחד לכל נושא (conversations, engine, inbox…)
apps/
  web/                   הממשק (React). רץ גם במחשב וגם בטלפון
    src/App.tsx          ← הניתוב בין המסכים (#/c/…, ‏#/settings…)
    src/pages/           המסכים הגדולים
    src/ui/              רכיבים משותפים (Menu…)
  desktop/               ‏Electron: מריץ את השרת בתוך האפליקציה ופותח חלון
  android/               ‏Capacitor: האפליקציה לטלפון
  browser-extension/     תוסף לדפדפן
plugins/                 דוגמאות לתוספים
docs/                    התיעוד, כולל המדריך הזה
```

**כלל הזהב:** תלויות זורמות רק למטה בטבלה: ‏`shared` ← `providers` ← `agent` ← `core` ← `desktop`. ‏`shared` לא מייבא כלום מ-KesherAI, ואף אחד מלבד `desktop` לא מייבא את `core`.

---

## 4. איך זה עובד: הזרימות המרכזיות

### 4.1 הפעלה
`createKesherServer` ב-`packages/core/src/server.ts` (שורה ~222) הוא המקום היחיד שבו הכל נוצר. כדאי לקרוא אותו מלמעלה למטה:
1. טעינת `~/.kesher/config.json` ויצירת תיקיות הנתונים (`config.ts`: ‏`loadConfig`, ‏`saveConfig`).
2. רישום ספקי המודלים ‏(`ProviderRegistry` ב-`packages/providers/src/registry.ts`).
3. טעינת תוספים, ואז ספקים מההגדרות, ואז סריקה של פורטים מוכרים (LM Studio, ‏Ollama, ‏ComfyUI).
4. יצירת השירותים: מנהל השיחות, המנוע, השומר על כרטיס המסך, ההתראות, העבודה העצמית.
5. רישום כל ה-routes, בדיקת הגישה מרחוק (`registerRemoteAuth` ב-`auth.ts`) והממשק.
6. טעינת המודל האחרון (`loadModel`), חוץ מאחרי Terminate.

**Electron** (`apps/desktop/src/main.ts`) קורא ל-`createKesherServer` ופותח חלון על `http://127.0.0.1:7420`.

### 4.2 הודעה בצ'אט, מקצה לקצה (הכי חשוב להבין)
1. **הממשק** (`apps/web/src/pages/Conversation.tsx`) שולח `POST /api/conversations/:id/messages` דרך `api()` ב-`apps/web/src/api.ts`.
2. **ה-route** (`packages/core/src/routes/library.ts`) קורא ל-`ConversationManager.send` ב-`packages/core/src/conversations.ts`.
3. **המנהל** פותח את השיחה (`open`): טוען אותה מהקובץ, בונה את רשימת הכלים וההנחיה למודל (system prompt), ומעביר ל-`AgentSession.send`.
4. **הסוכן** (`packages/agent/src/session.ts`, ‏`run()` בשורה ~723) רץ בלולאה:
   - קורא למודל דרך `ProviderRegistry.resolve` ("llamacpp/Qwen…" → ספק + שם מודל).
   - הטקסט מגיע בהזרמה כאירועי `assistant_delta`.
   - כשהמודל מבקש כלי, `decide()` ב-`permissions.ts` מחליט אם להריץ מיד או לשאול. שאילה שולחת `approval_request`.
   - הכלי רץ (`packages/agent/src/tools.ts`, ‏`CODE_TOOLS`), התוצאה חוזרת למודל, והלולאה ממשיכה.
   - הלולאה נגמרת כשהמודל עונה בלי כלים, או אחרי 60 צעדים (`maxSteps`).
5. **כל אירוע** נשלח (`push`) לכל מי שצופה, למחשב ולטלפון, דרך **SSE** (`GET /api/conversations/:id/events`), ונשמר בקובץ השיחה.
6. **הממשק** מאזין ב-`EventSource` ומעדכן את המסך. אם החיבור נתקע, ‏watchdog פותח אותו מחדש.

### 4.3 אישורים
- `decide(mode, risk, alwaysAllowed, command)` ב-`packages/agent/src/permissions.ts` מחליט על כל כלי. ‏risk: ‏read (קריאה), ‏write (כתיבה), ‏exec (הרצת פקודה). ‏mode: שאל, אשר עריכות, אוטומטי, תוכנית.
- `dangerReason()` מזהה פקודות מסוכנות (`rm -rf`, ‏format…). פקודה כזו מבקשת אישור תמיד.
- כללי "תמיד לאשר" נשמרים ב-config ומוצגים בהגדרות ← פרטיות והרשאות.
- `AgentSession.approve(requestId, decision)` מקבל את התשובה, מהכרטיס בצ'אט, מ-🔔 (`routes/inbox.ts`) או מהטלפון.

### 4.4 המנוע המקומי ושמירה על כרטיס המסך
- `LlamaEngine` ב-`packages/core/src/llamacpp.ts`:
  - `install()` מוריד את llama.cpp המתאים למחשב.
  - `load(modelPath)` מריץ את `llama-server` כתהליך בן, ואז הוא נרשם כספק `llamacpp`.
  - `stop()` עוצר אותו.
- `GpuGuard` ב-`packages/core/src/gpu-guard.ts`:
  - `check()` מודד טמפרטורה וזיכרון כל כמה שניות, דרך `nvidia-smi`.
  - `before()` נקרא לפני כל קריאה למודל. אם המודל נפרק הוא טוען אותו מחדש, ואם הכרטיס חם מדי הוא מחכה.
  - פריקה אחרי זמן בלי שימוש (`unloadAfterMinutes`).
- Terminate (`routes/system.ts`) עוצר הכל, משאיר סימון ומפעיל מחדש.

### 4.5 טלפון וגישה מרחוק
- הטלפון הוא עוד לקוח של אותו שרת. אין קוד נפרד לטלפון, רק אותו ממשק במסך צר.
- `packages/core/src/auth.ts`:
  - `isLocalRequest()` בודק אם הבקשה באה מהמחשב עצמו.
  - `registerRemoteAuth()` דורש טוקן או מכשיר מזווג מכל מי שבא מבחוץ.
  - חלק מה-routes מוגבלים למחשב בלבד, למשל נתיבי קבצים ומפתחות.
- "מכל מקום" עובד דרך מנהרה (cloudflared) שהמחשב פותח (`tunnel.ts`).
- ההתראות לטלפון נשלחות דרך ntfy (`notify.ts`: ‏`Notifier.send`).

### 4.6 עבודה עצמית ולוח המשימות
- `TaskBoard` ב-`packages/core/src/task-board.ts`: קובץ JSON אחד, עם תביעה של משימה, סיום, הערות, ומספר גרסה (rev) נגד דריסות.
- `SelfWork` ב-`packages/core/src/self-work.ts`: מריץ את המודל המקומי על משימות CoolDown, בענף git נפרד. לעולם לא push ולא merge.
- `+` ← משימות מהלוח (`apps/web/src/AddMenu.tsx`, ‏`toBoard`): מכניס את המשימות לצ'אט. בצ'אט רגיל הוא גם נותן גישה לתיקיית הפרויקט (`routes/library.ts`, ‏`board-project`).

### 4.7 סוכנים חיצוניים (Antigravity)
- `packages/core/src/acp.ts`: חיבור ACP לתוכנה חיצונית (`agy acp`).
- `packages/core/src/acp-chat.ts`: הופך סוכן חיצוני ל"מודל" בצ'אט. הוא משתמש באותם כרטיסי אישור, ב-`AgentSession` עם `external`.

---

## 5. מתודות מפתח: טבלה מהירה

| מה | איפה | מה היא עושה |
| --- | --- | --- |
| `createKesherServer()` | core/src/server.ts | בונה ומחבר את כל המערכת |
| `ConversationManager.open()` | core/src/conversations.ts | טוען שיחה ובונה לה סוכן, כלים והנחיה |
| `ConversationManager.send()` | core/src/conversations.ts | שולח הודעה, או מכניס לתור אם השיחה עובדת |
| `AgentSession.run()` | agent/src/session.ts | הלולאה: מודל ← כלי ← מודל |
| `AgentSession.approve()` / `stop()` / `grant()` | agent/src/session.ts | אישור או דחייה, עצירה, מתן גישה לתיקייה |
| `decide()` / `dangerReason()` | agent/src/permissions.ts | האם להריץ כלי בלי לשאול |
| `CODE_TOOLS` | agent/src/tools.ts | כלי הקוד: ‏list_files, ‏read_file, ‏edit_file, ‏search, ‏run_command… |
| `runShell()` | agent/src/shell.ts | מריץ פקודה, עם זהות git של KesherAI |
| `ProviderRegistry.resolve()` | providers/src/registry.ts | ממזהה מודל לספק שיודע להריץ אותו |
| `LlamaEngine.load()` / `stop()` | core/src/llamacpp.ts | מריץ או עוצר את llama-server |
| `GpuGuard.check()` / `before()` | core/src/gpu-guard.ts | מדידה, הגנה מחום, פריקה וטעינה מחדש |
| `Notifier.send()` / `onConversationEvent()` | core/src/notify.ts | התראות למחשב ולטלפון |
| `registerRemoteAuth()` | core/src/auth.ts | מי רשאי להיכנס מבחוץ |
| `TaskBoard.change()` | core/src/task-board.ts | שינוי בלוח, כותב אחד בכל פעם |
| `saveConfig()` | core/src/config.ts | שמירה בטוחה של ההגדרות (קובץ חדש ואז rename) |
| `api()` | web/src/api.ts | כל קריאה מהממשק לשרת, כולל הטוקן בטלפון |
| `App()` | web/src/App.tsx | הניתוב בין המסכים |

---

## 6. מושגים שחוזרים בקוד

- **model id:** תמיד `<ספק>/<מודל>`, למשל `llamacpp/Qwen3.8-27B-UD-Q4_K_XL`. ‏`makeModelId` בונה ו-`parseModelId` מפרק.
- **Provider (ספק):** כל מקור מודלים נראה אותו דבר, מנוע מקומי או ענן. להוסיף ספק חדש לא דורש שינוי בשאר הקוד.
- **AgentEvent:** כל מה שקורה בשיחה הוא אירוע: ‏`user`, ‏`assistant_delta`, ‏`tool_call`, ‏`tool_result`, ‏`approval_request`, ‏`status`… השיחה השמורה היא רשימת אירועים.
- **SSE ‏(Server-Sent Events):** זרם חד-כיווני מהשרת לממשק. בחרנו בו ולא ב-WebSocket כי הוא עובר בכל proxy ושורד שינה של הטלפון.
- **workspace:** התיקייה שהסוכן רשאי לעבוד בה. ‏`extraRoots` הן תיקיות נוספות שניתנה אליהן גישה.
- **Feature flags:** `packages/shared/src/features.config.ts` קובע אילו מסכים ו-routes קיימים.
- **i18n:** הטקסטים של הממשק נמצאים ב-`apps/web/src/i18n.ts` (עברית ואנגלית). ‏`t("key")`, או `L("עברית", "English")` לטקסט חד-פעמי.

---

## 7. מסלול קריאה לסוף השבוע

**יום ראשון: השרת והסוכן (בערך 4–5 שעות)**
1. `docs/ARCHITECTURE.md`: התמונה הגדולה, 15 דקות.
2. `packages/shared/src/store.ts`: איך נראית שיחה ופרויקט כנתונים.
3. `packages/core/src/server.ts`: רק `createKesherServer`. לדלג על פרטים ולהבין את הסדר.
4. `packages/agent/src/session.ts`: הלב. ‏`send` ← `run` ← `push`.
5. `packages/agent/src/permissions.ts`: קצר וחשוב.
6. `packages/agent/src/tools.ts`: לקרוא 3–4 כלים, למשל `readFileTool`, `editFileTool` ו-`runCommandTool`.
7. `packages/core/src/conversations.ts`: ‏`open` ו-`send`.
8. `packages/providers/src/registry.ts`, ואז ספק אחד: `openai-compatible.ts`.

**יום שני: מנוע, טלפון וממשק (בערך 4 שעות)**
9. `packages/core/src/llamacpp.ts` ו-`gpu-guard.ts`.
10. `packages/core/src/auth.ts`, ואז `notify.ts`.
11. `packages/core/src/routes/library.ts` ו-`routes/inbox.ts`: איך נראה route.
12. `apps/web/src/api.ts`, ‏`App.tsx`, ואז `pages/Conversation.tsx`, הצ'אט עצמו.
13. `apps/web/src/ui/Menu.tsx`: דוגמה לרכיב משותף.
14. `apps/desktop/src/main.ts`: איך Electron עוטף הכל.

**טיפים:**
- ב-VS Code, ‏F12 קופץ להגדרה, ו-Shift+F12 מראה איפה משתמשים בפונקציה. הכי מהיר להבין זרימה.
- קובץ הבדיקה שליד כל קובץ (`x.test.ts`) מראה איך משתמשים בו.
- `git log -p -- <קובץ>` מראה למה כל שינוי נעשה. כל commit מסביר את ה"למה".

---

## 8. איך להריץ מקומית

```
pnpm install
pnpm dev            # שרת + ממשק במצב פיתוח (http://localhost:5173)
pnpm test           # כל הבדיקות
pnpm lint           # סגנון והערות חובה
pnpm typecheck      # בדיקת טיפוסים
pnpm dev:desktop    # האפליקציה לשולחן העבודה
```
