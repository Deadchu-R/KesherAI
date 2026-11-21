# Review of UI Texts in Hebrew and English

This review covers interface texts in `apps/web/src/i18n.ts` and the `L(he, en)` calls across `apps/web/src/pages/*.tsx`.
Problems are categorized into four kinds:
1. **Hebrew typos and unnatural wording** (spelling errors, grammatical agreement issues, unnatural literal translations).
2. **English and Hebrew that say different things** (semantic mismatches, divergent information, or brand name translation discrepancies).
3. **The same thing named differently in different places** (inconsistent terminology for key concepts, actions, or punctuation/symbols).
4. **Texts too long for a 390 px phone** (excessively long labels on buttons, tabs, or chips that wrap awkwardly or overflow on mobile screens).

## Summary Count of Problems by Kind

- **Hebrew typos and unnatural wording**: 32
- **English and Hebrew that say different things**: 14
- **The same thing named differently in different places**: 14
- **Texts too long for a 390 px phone**: 12
- **Total problems**: 72

---

## Detailed Problems by File

### `apps/web/src/i18n.ts`

- apps/web/src/i18n.ts: Current: `batchNav: "כלי תמונות בכמות"` | Suggested: `batchNav: "עיבוד תמונות באצווה"` | Kind: Hebrew typos and unnatural wording (Unnatural phrasing in Hebrew for batch image processing; "בכמות" sounds like wholesale shopping).
- apps/web/src/i18n.ts: Current: `batchTitle: "כלי תמונות בכמות"` | Suggested: `batchTitle: "עיבוד תמונות באצווה"` | Kind: Hebrew typos and unnatural wording (Unnatural phrasing in Hebrew for batch image processing).
- apps/web/src/i18n.ts: Current: `batchBoth: "שניהם"` | Suggested: `batchBoth: "גם וגם"` | Kind: Hebrew typos and unnatural wording (Grammar mismatch: "שניהם" is masculine, but the two actions "הסרת רקע" and "הגדלה פי 4" are feminine nouns; "גם וגם" or "שתי הפעולות" is natural).
- apps/web/src/i18n.ts: Current: `nodesNav: "נודים (ComfyUI)"` | Suggested: `nodesNav: "צמתים (ComfyUI)"` | Kind: Hebrew typos and unnatural wording (Unnatural transliteration; in Hebrew "נודים" is awkward slang with an unfortunate homograph with flatulence; GamesPage.tsx:262 uses "צמתים").
- apps/web/src/i18n.ts: Current: `bankNav: "בנק היצירות"` (EN: `bankNav: "Everything made"`) | Suggested: `bankNav: "כל מה שנוצר"` (or EN: `bankNav: "Creations bank"`) | Kind: English and Hebrew that say different things (English uses plain descriptive text while Hebrew uses a metaphorical title).
- apps/web/src/i18n.ts: Current: `ideasNav: "מוח פתוח"` | Suggested: `ideasNav: "ראש פתוח"` | Kind: Hebrew typos and unnatural wording (Unnatural literal translation of "Open mind"; in Hebrew the idiom is "ראש פתוח", whereas "מוח פתוח" sounds like brain surgery).
- apps/web/src/i18n.ts: Current: `pagesNav: "מסמכים"` (EN: `pagesNav: "Pages"`) | Suggested: `pagesNav: "דפים"` | Kind: English and Hebrew that say different things (English says "Pages", but Hebrew says "מסמכים", creating direct conflict with `docsNav: "מסמכים"` for Documents).
- apps/web/src/i18n.ts: Current: `lorasNone: "עוד אין LoRAs. חפש אחד, או שים קבצי ‎.safetensors בתיקייה models/loras."` | Suggested: `lorasNone: "עוד אין LoRAs. חפש אחד, או שים קובצי ‎.safetensors בתיקייה models/loras."` | Kind: Hebrew typos and unnatural wording (Spelling error: construct state in standard ktiv male is "קובצי", not "קבצי").
- apps/web/src/i18n.ts: Current: `plPermFiles: "לקרוא ולכתוב קבצים שלך"` | Suggested: `plPermFiles: "לקרוא ולכתוב את הקבצים שלך"` | Kind: Hebrew typos and unnatural wording (Grammar error: missing definite direct object marker "את" before the definite noun phrase "הקבצים שלך").
- apps/web/src/i18n.ts: Current: `answer: "ענה"` (EN: `answer: "Answer"`) | Suggested: `answer: "תשובה"` | Kind: Hebrew typos and unnatural wording (Unnatural translation: "ענה" is an imperative verb, whereas this string labels a status badge/field alongside "אושר", "נדחה", and "פלט").
- apps/web/src/i18n.ts: Current: `oneNeedsClient: "...רשום אחד (כ-5 דקות, חינם, בלי סוד)..."` | Suggested: `oneNeedsClient: "...צור אחד (כ-5 דקות, חינם, בלי סוד)..."` | Kind: Hebrew typos and unnatural wording ("רשום אחד" is broken colloquial Hebrew for registering an application ID).
- apps/web/src/i18n.ts: Current: `ideaCode: "תסתכל על הפרויקט שלי ותציע שיפורים"` | Suggested: `ideaCode: "הסתכל על הפרויקט שלי והצע שיפורים"` | Kind: Hebrew typos and unnatural wording (Tense inconsistency: uses future tense "תסתכל... ותציע" instead of imperative "הסתכל... והצע" like adjacent ideas).
- apps/web/src/i18n.ts: Current: `ggufHint: "קבצי GGUF רצים במנוע המובנה של KesherAI..."` | Suggested: `ggufHint: "קובצי GGUF רצים במנוע המובנה של KesherAI..."` | Kind: Hebrew typos and unnatural wording (Spelling error: construct state is "קובצי" in standard ktiv male).
- apps/web/src/i18n.ts: Current: `noWeightFiles: "אין קבצי מודל במאגר הזה."` | Suggested: `noWeightFiles: "אין קובצי מודל במאגר הזה."` | Kind: Hebrew typos and unnatural wording (Spelling error: construct state is "קובצי").
- apps/web/src/i18n.ts: Current: `pickleWarning: "קבצי pickle יכולים להריץ קוד..."` | Suggested: `pickleWarning: "קובצי pickle יכולים להריץ קוד..."` | Kind: Hebrew typos and unnatural wording (Spelling error: construct state is "קובצי").
- apps/web/src/i18n.ts: Current: `healthNav: "בריאות המחשב"` (EN: `healthNav: "Health"`) | Suggested: `healthNav: "בריאות המערכת"` | Kind: English and Hebrew that say different things (English is generic "Health", while Hebrew specifies computer health even though the page also inspects phone health).
- apps/web/src/i18n.ts: Current: `chats: "שיחות"` vs `tabChats: "צ'אטים"` | Suggested: unify to `tabChats: "שיחות"` (or `chats: "צ'אטים"`) | Kind: The same thing named differently in different places (Both correspond to "Chats" in English; inconsistent terminology across navigation items).
- apps/web/src/i18n.ts: Current: `plugins: "תוספים"` vs `pluginsNav: "פלאגינים ומודים"` | Suggested: `plugins: "פלאגינים"` | Kind: The same thing named differently in different places (Inconsistent term: "תוספים" in Connections tab vs "פלאגינים" throughout the rest of the application).
- apps/web/src/i18n.ts: Current: `ccRuleStop: "(באפליקציית המחשב)"` vs `keepAwake: "(באפליקציית הדסקטופ)"` | Suggested: unify to `keepAwake: "(באפליקציית המחשב)"` | Kind: The same thing named differently in different places (The exact same English phrase `(desktop app)` is translated as "המחשב" in one place and "הדסקטופ" in another).
- apps/web/src/i18n.ts: Current: `parallelLabel: "צ׳אטים במקביל"` vs `chat: "צ'אט"` | Suggested: unify to standard apostrophe `parallelLabel: "צ'אטים במקביל"` | Kind: The same thing named differently in different places (Inconsistent geresh: typographic geresh `צ׳` vs apostrophe `צ'`).
- apps/web/src/i18n.ts: Current: `alwaysChat: "אשר תמיד {tool} בשיחה הזו"` vs `ws-agentEdits: "העריכות של הסוכן בצ'אט הזה"` | Suggested: `alwaysChat: "אשר תמיד {tool} בצ'אט הזה"` | Kind: The same thing named differently in different places (The phrase "in this chat" is translated as "בשיחה הזו" in one place and "בצ'אט הזה" in another).

### `apps/web/src/pages/AvatarCamera.tsx`

- apps/web/src/pages/AvatarCamera.tsx: Current: `L("פתחי מצלמה וממשיכים", "Open the camera and continue")` | Suggested: `L("פתחי מצלמה כדי להמשיך", "Open the camera to continue")` | Kind: Hebrew typos and unnatural wording (Grammar mismatch: mixes 2nd person feminine imperative "פתחי" with 1st person plural present "ממשיכים").
- apps/web/src/pages/AvatarCamera.tsx: Current: `L("(כ-7GB, כמה דקות)", "(about 7 GB, a few minutes)")` | Suggested: `L("(כ-7 GB, כמה דקות)", "(about 7 GB, a few minutes)")` | Kind: Hebrew typos and unnatural wording (Missing space between number and unit: "7GB" -> "7 GB").
- apps/web/src/pages/AvatarCamera.tsx: Current: `L("התקנה (כ-7GB)", "Install (about 7 GB)")` | Suggested: `L("התקנה (כ-7 GB)", "Install (about 7 GB)")` | Kind: Hebrew typos and unnatural wording (Missing space between number and unit: "7GB" -> "7 GB").
- apps/web/src/pages/AvatarCamera.tsx: Current: `L("התחילי הקלטה (ספירה לאחור 3 שניות)", "Start recording (3-second countdown)")` | Suggested: `L("התחלת הקלטה (3 שנ')", "Start recording (3s)")` | Kind: Texts too long for a 390 px phone (Primary CTA button text has 36-38 characters and wraps into multiple cramped lines on 390px mobile).
- apps/web/src/pages/AvatarCamera.tsx: Current: `L("בדיקה: האווטאר מדבר הקלטה לדוגמה (20 שניות)", "Test: the avatar speaks a sample recording (20 seconds)")` | Suggested: `L("בדיקת הקלטה לדוגמה (20 שניות)", "Test sample recording (20s)")` | Kind: Texts too long for a 390 px phone (Button label has 45-57 characters; causes severe overflow on mobile screens).

### `apps/web/src/pages/BankPage.tsx`

- apps/web/src/pages/BankPage.tsx: Current: `L("🗑 מחק את כל העותקים (הישן בכל קבוצה נשמר)", "🗑 Delete all copies (the oldest in each group stays)")` | Suggested: `L("🗑 מחק עותקים (הישן נשמר)", "🗑 Delete copies (oldest kept)")` | Kind: Texts too long for a 390 px phone (Action button text with 44-55 characters overflows or crowds out toolbar on 390px mobile).
- apps/web/src/pages/BankPage.tsx: Current: `L("חיפוש לפי שם, תיאור או צ׳אט", "Search by name, description or chat")` vs `L("צ'אט", "Chat")` | Suggested: unify to standard apostrophe `L("חיפוש לפי שם, תיאור או צ'אט", ...)` | Kind: The same thing named differently in different places (Uses typographic geresh `צ׳` while elsewhere apostrophe `צ'` is used).

### `apps/web/src/pages/CanvasPage.tsx`

- apps/web/src/pages/CanvasPage.tsx: Current: `L("לוח ציור שאתם והמודל עורכים יחד...", "A board you and the model draw on together...")` | Suggested: `L("לוח ציור שאתה והמודל עורכים יחד...", "A board you and the model draw on together...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "שאתם" in single-user application).

### `apps/web/src/pages/ChatReportsPage.tsx`

- apps/web/src/pages/ChatReportsPage.tsx: Current: `L("קשר פותח את הדוח בדפדפן הפנימי שלו...", "KesherAI opens the report in its own browser...")` | Suggested: `L("KesherAI פותח את הדוח בדפדפן הפנימי שלו...", "KesherAI opens the report in its own browser...")` | Kind: English and Hebrew that say different things (Translates official brand name "KesherAI" into Hebrew "קשר", contradicting the rest of the application).
- apps/web/src/pages/ChatReportsPage.tsx: Current: `L(\`הקורא של קשר · ...\`, \`KesherAI's reader · ...\`)` | Suggested: `L(\`הקורא של KesherAI · ...\`, \`KesherAI's reader · ...\`)` | Kind: English and Hebrew that say different things (Uses "קשר" instead of official brand name "KesherAI").
- apps/web/src/pages/ChatReportsPage.tsx: Current: `L("האמוג'ים שלכם", "Your emojis")` | Suggested: `L("האימוג'ים שלכם", "Your emojis")` | Kind: Hebrew typos and unnatural wording (Spelling inconsistency: line 222 uses "אימוג'ים" with yod, line 454 writes "האמוג'ים" without yod).
- apps/web/src/pages/ChatReportsPage.tsx: Current: `L("יש לך כבר דוח מ-What Brandon Thinks? ייבא אותו", "Already have a report from What Brandon Thinks? Import it")` | Suggested: `L("ייבוא דוח מ-What Brandon Thinks", "Import from What Brandon Thinks")` | Kind: Texts too long for a 390 px phone (Action button in step card is 48-59 characters; wraps into 3 cramped lines on 390px mobile).
- apps/web/src/pages/ChatReportsPage.tsx: Current: `L("...מתוך הצ׳אט.", "...")` vs `L("...תשובה מהצ'אט.", "...")` | Suggested: unify to `הצ'אט` | Kind: The same thing named differently in different places (Typographic geresh `צ׳` on line 520 vs apostrophe `צ'` on line 529 in the same view).

### `apps/web/src/pages/CodeHome.tsx`

- apps/web/src/pages/CodeHome.tsx: Current: `L("בחרו תיקייה לעבוד בה.", "Choose a folder to work in.")` | Suggested: `L("בחר תיקייה לעבוד בה.", "Choose a folder to work in.")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "בחרו" instead of singular "בחר").
- apps/web/src/pages/CodeHome.tsx: Current: `L("תארו מה לכתוב, לתקן או לבדוק בקוד…", "Describe what to write, fix or check in the code…")` | Suggested: `L("תאר מה לכתוב, לתקן או לבדוק בקוד…", "Describe what to write, fix or check in the code…")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "תארו" vs singular "תאר" in `codePlaceholder`).

### `apps/web/src/pages/Conversation.tsx`

- apps/web/src/pages/Conversation.tsx: Current: `L("...מצא את הסיבה, ותגיד לי במילים פשוטות...", "...")` | Suggested: `L("...מצא את הסיבה, ואמור לי במילים פשוטות...", "...")` | Kind: Hebrew typos and unnatural wording (Grammar error: switches from imperative verbs "חקור... השתמש... מצא" to future tense "ותגיד לי").
- apps/web/src/pages/Conversation.tsx: Current: `L("כתבו אחרי /model חלק מהשם, למשל /model qwen.", "Type part of a name after /model, e.g. /model qwen.")` | Suggested: `L("כתוב אחרי /model חלק מהשם, למשל /model qwen.", "Type part of a name after /model, e.g. /model qwen.")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "כתבו" in single-user chat).

### `apps/web/src/pages/Day.tsx`

- apps/web/src/pages/Day.tsx: Current: `L("למחוק רק את ההקלטה? התמלול והסיכום נשארים.", "Delete only the recording? The transcript and write-up stay.")` | Suggested: `L("למחוק רק את ההקלטה? התמלול והסיכום נשארים.", "Delete only the recording? The transcript and summary stay.")` | Kind: English and Hebrew that say different things (English says "write-up" while Hebrew says "סיכום").
- apps/web/src/pages/Day.tsx: Current: `L("⏸ השהה את ההקלטה במחשב לשעה", "⏸ Pause recording on the computer for an hour")` | Suggested: `L("⏸ השהה לשעה", "⏸ Pause for 1 hr")` | Kind: Texts too long for a 390 px phone (Header button is 29 chars in Hebrew and 47 chars in English; overflows header row on 390px mobile).

### `apps/web/src/pages/DesignPage.tsx`

- apps/web/src/pages/DesignPage.tsx: Current: `L("...בחר אותה בהגדרות > תיבת משימות.", "...")` | Suggested: `L("...בחר אותה בהגדרות ← תיבת משימות.", "...")` | Kind: The same thing named differently in different places (Uses `>` for settings breadcrumb path instead of standard arrow `←`, which causes visual reversal in RTL).

### `apps/web/src/pages/DocsPage.tsx`

- apps/web/src/pages/DocsPage.tsx: Current: `L("מסמכים", "Documents")` vs `i18n.ts: pagesNav: "מסמכים"` (EN: "Pages") | Suggested: distinguish `pagesNav` as "דפים" | Kind: The same thing named differently in different places (Both `DocsPage` and `Pages` navigation item are called "מסמכים" in Hebrew).

### `apps/web/src/pages/GamesPage.tsx`

- apps/web/src/pages/GamesPage.tsx: Current: `L("דולג לעכשיו", "Skipped for now")` | Suggested: `L("דולג בינתיים", "Skipped for now")` | Kind: Hebrew typos and unnatural wording (Unnatural phrasing: "דולג לעכשיו" is awkward literal translation; standard Hebrew is "דולג בינתיים").
- apps/web/src/pages/GamesPage.tsx: Current: `L("דלג לעכשיו", "Skip for now")` | Suggested: `L("דלג בינתיים", "Skip for now")` | Kind: Hebrew typos and unnatural wording (Unnatural phrasing; should match `skipForNow` which uses "דלג בינתיים").
- apps/web/src/pages/GamesPage.tsx: Current: `L("אותם צמתים; השתנו חיבורים או ערכים", "Same nodes; links or values changed")` vs `i18n.ts: nodesNav: "נודים (ComfyUI)"` | Suggested: unify terminology to "צמתים" | Kind: The same thing named differently in different places (Inconsistent naming for nodes: "צמתים" in GamesPage vs "נודים" in i18n).

### `apps/web/src/pages/HealthPage.tsx`

- apps/web/src/pages/HealthPage.tsx: Current: `L("...רק אחרי שתאשרו. כל השאר הם צעדים שאתם עושים.", "...")` | Suggested: `L("...רק אחרי שתאשר. כל השאר הם צעדים שאתה עושה.", "...")` | Kind: Hebrew typos and unnatural wording (Unnatural plural address "שתאשרו/שאתם עושים" where app addresses user in singular).
- apps/web/src/pages/HealthPage.tsx: Current: `L(\`${todo} דברים כדאי לעשות\`, \`${todo} things worth doing\`)` | Suggested: `L(\`${todo} דברים שכדאי לעשות\`, \`${todo} things worth doing\`)` | Kind: Hebrew typos and unnatural wording (Missing relative particle "ש-" in "דברים שכדאי לעשות").

### `apps/web/src/pages/IdeasPage.tsx`

- apps/web/src/pages/IdeasPage.tsx: Current: `L("מוח פתוח", "Open mind")` | Suggested: `L("ראש פתוח", "Open mind")` | Kind: Hebrew typos and unnatural wording (Unnatural literal translation of "Open mind").
- apps/web/src/pages/IdeasPage.tsx: Current: `L("שבו בנוח, דברו כל מה שעולה. אפשר לחזור על עצמכם...", "...")` | Suggested: `L("שב בנוח, דבר כל מה שעולה. אפשר לחזור על עצמך...", "...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "שבו/דברו/עצמכם" on single-user app).
- apps/web/src/pages/IdeasPage.tsx: Current: `L("כל מה שחשבתם, כמו שזה…", "Everything you thought, as it came…")` | Suggested: `L("כל מה שחשבת, כמו שזה…", "Everything you thought, as it came…")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "שחשבתם" vs singular "שחשבת").

### `apps/web/src/pages/Libraries.tsx`

- apps/web/src/pages/Libraries.tsx: Current: `L("חנות ספריות", "Library store")` vs `LibraryStore.tsx: "מהספרייה של KesherAI"` | Suggested: `L("ספריות קוד ותיעוד", "Code libraries and docs")` | Kind: The same thing named differently in different places (`Libraries.tsx` manages offline docs/reference libraries, but is titled "חנות ספריות" while `LibraryStore.tsx` manages prompts, personas and skills).

### `apps/web/src/pages/LibraryStore.tsx`

- apps/web/src/pages/LibraryStore.tsx: Current: `L("יש לכם", "Added")` (line 64) | Suggested: `L("נוסף", "Added")` | Kind: English and Hebrew that say different things (English indicates status "Added", Hebrew says "יש לכם" / "You have", with plural address).
- apps/web/src/pages/LibraryStore.tsx: Current: `L("יש לכם", "Added")` (line 79) | Suggested: `L("נוסף", "Added")` | Kind: English and Hebrew that say different things (English indicates status "Added", Hebrew says "יש לכם").
- apps/web/src/pages/LibraryStore.tsx: Current: `L("לקוד", "View")` | Suggested: `L("הצג", "View")` | Kind: English and Hebrew that say different things (English button says "View", Hebrew specifies "לקוד").
- apps/web/src/pages/LibraryStore.tsx: Current: `L("רוצים לשתף פרומפט או פרסונה? פתחו בקשת שינוי...", "...")` | Suggested: `L("רוצה לשתף פרומפט או פרסונה? פתח בקשת שינוי...", "...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "רוצים... פתחו").

### `apps/web/src/pages/MemoryPage.tsx`

- apps/web/src/pages/MemoryPage.tsx: Current: `L("משהו לא נכון או לא רצוי? הסירו אותו כאן.", "Anything wrong or unwanted? Remove it here.")` | Suggested: `L("משהו לא נכון או לא רצוי? הסר אותו כאן.", "Anything wrong or unwanted? Remove it here.")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "הסירו").
- apps/web/src/pages/MemoryPage.tsx: Current: `L("צ'אט בלי זיכרון: בצ'אט חדש לחצו על 👻...", "...")` | Suggested: `L("צ'אט בלי זיכרון: בצ'אט חדש לחץ על 👻...", "...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "לחצו").
- apps/web/src/pages/MemoryPage.tsx: Current: `L("בקשו מ-ChatGPT או מ-Claude: \"תכתוב רשימה...\", והדביקו כאן...", "...")` | Suggested: `L("בקש מ-ChatGPT או מ-Claude: \"כתוב רשימה...\", והדבק כאן...", "...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "בקשו... והדביקו" plus future tense "תכתוב" instead of imperative "כתוב").
- apps/web/src/pages/MemoryPage.tsx: Current: `L("...כשאתה אומר...", "...")` vs `L("...הסירו אותו כאן.", "...")` | Suggested: unify to singular address | Kind: The same thing named differently in different places (Mixes singular "כשאתה אומר" with plural "הסירו", "לחצו", "בקשו" on the same screen).

### `apps/web/src/pages/NodesPage.tsx`

- apps/web/src/pages/NodesPage.tsx: Current: `L("נודים (ComfyUI)", "Nodes (ComfyUI)")` | Suggested: `L("צמתים (ComfyUI)", "Nodes (ComfyUI)")` | Kind: Hebrew typos and unnatural wording (Unnatural transliteration; in Hebrew "נודים" is awkward slang with homograph with flatulence).

### `apps/web/src/pages/PipelinesPage.tsx`

- apps/web/src/pages/PipelinesPage.tsx: Current: `L("עריכת צינור", "Edit pipeline")` | Suggested: `L("עריכת תהליך", "Edit pipeline")` | Kind: Hebrew typos and unnatural wording (Unnatural literal translation "צינור" for automated workflow pipeline).

### `apps/web/src/pages/RemotePage.tsx`

- apps/web/src/pages/RemotePage.tsx: Current: `L("לא הצלחתי לקחת את התמונה.", "Could not take the picture.")` | Suggested: `L("לא הצלחתי לצלם את התמונה.", "Could not take the picture.")` | Kind: Hebrew typos and unnatural wording (Unnatural literal translation: "לקחת תמונה" is a false friend from English "take a picture"; in Hebrew it is "לצלם תמונה").

### `apps/web/src/pages/SelfWorkPage.tsx`

- apps/web/src/pages/SelfWorkPage.tsx: Current: `L("עוד לא נבחר פרויקט. בדף הקוד בחרו את תיקיית הפרויקט, ואז חזרו לכאן.", "...")` | Suggested: `L("עוד לא נבחר פרויקט. בדף הקוד בחר את תיקיית הפרויקט, ואז חזור לכאן.", "...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "בחרו... חזרו").

### `apps/web/src/pages/StremioPage.tsx`

- apps/web/src/pages/StremioPage.tsx: Current: `L(\`נוספו \${r.added} אנימה, סה״כ \${r.total}\`, \`\${r.added} anime added, \${r.total} in all\`)` | Suggested: `L(\`נוספו \${r.added} כותרי אנימה, סה״כ \${r.total}\`, \`\${r.added} anime added, \${r.total} in all\`)` | Kind: Hebrew typos and unnatural wording (Unnatural phrasing: "אנימה" is a genre name, not a countable noun in Hebrew).

### `apps/web/src/pages/StudyPage.tsx`

- apps/web/src/pages/StudyPage.tsx: Current: `L("התרגיל הועתק מהצילום. בדקי שהוא נכון ושלחי.", "The exercise was copied from the photo. Check it and send.")` | Suggested: `L("התרגיל הועתק מהצילום. יש לבדוק שהוא נכון ולשלוח.", "The exercise was copied from the photo. Check it and send.")` | Kind: Hebrew typos and unnatural wording (Hardcoded feminine singular address "בדקי... ושלחי" without respecting user address settings or gender-neutral phrasing).
- apps/web/src/pages/StudyPage.tsx: Current: `L("הדביקי את התרגיל. המורה עוזרת צעד אחר צעד: כתבי כל צעד שעשית והיא תבדוק, בקשי רמז כשנתקעת, ופתרון מלא כשתרצי.", "...")` | Suggested: `L("הדבק/הדביקי את התרגיל. המורה עוזר/ת צעד אחר צעד: כתוב/כתבי כל צעד שעשית...", "...")` | Kind: Hebrew typos and unnatural wording (Hardcoded feminine address in instructions).
- apps/web/src/pages/StudyPage.tsx: Current: `L("הראי לי את הפתרון המלא, צעד אחר צעד", "Show me the full solution, step by step")` | Suggested: `L("הצג את הפתרון המלא, צעד אחר צעד", "Show me the full solution, step by step")` | Kind: Hebrew typos and unnatural wording (Hardcoded feminine imperative to model "הראי" instead of neutral "הצג").
- apps/web/src/pages/StudyPage.tsx: Current: `L("הדביקי כאן את התמלול או הסיכום שלך, או הוסיפי מצגת...", "...")` | Suggested: `L("הדבק/הדביקי כאן את התמלול או הסיכום שלך, או הוסף/הוסיפי מצגת...", "...")` | Kind: Hebrew typos and unnatural wording (Hardcoded feminine address).
- apps/web/src/pages/StudyPage.tsx: Current: `L("הקישי או לחצי רווח כדי לראות את התשובה", "Tap or press space to see the answer")` | Suggested: `L("הקש/הקישי או לחץ/לחצי על מקש רווח כדי לראות את התשובה", "Tap or press space to see the answer")` | Kind: Hebrew typos and unnatural wording (Hardcoded feminine address).
- apps/web/src/pages/StudyPage.tsx: Current: `L("...היכנסי פעם אחת בדפדפן של קשר. בפעם הראשונה קשר מוריד את yt-dlp...", "...sign in once in KesherAI's browser. The first time, KesherAI downloads yt-dlp...")` | Suggested: `L("...היכנס/היכנסי פעם אחת בדפדפן של KesherAI. בפעם הראשונה KesherAI מוריד את yt-dlp...", "...sign in once in KesherAI's browser. The first time, KesherAI downloads yt-dlp...")` | Kind: English and Hebrew that say different things (Translates official brand name "KesherAI" into Hebrew "קשר", contradicting the rest of the application).
- apps/web/src/pages/StudyPage.tsx: Current: `L("הראי לי את הפתרון המלא, צעד אחר צעד", "Show me the full solution, step by step")` | Suggested: `L("פתרון מלא, צעד אחר צעד", "Full step-by-step solution")` | Kind: Texts too long for a 390 px phone (Quick action chip has 37-41 characters; wraps awkwardly on 390px mobile).
- apps/web/src/pages/StudyPage.tsx: Current: `L("תרגיל דומה לתרגול, בבקשה (בלי הפתרון)", "A similar problem to practice, please (without the solution)")` | Suggested: `L("תרגיל דומה לתרגול (ללא פתרון)", "Similar problem (no solution)")` | Kind: Texts too long for a 390 px phone (Quick action chip has 39-62 characters; too long for 390px quick actions row).
- apps/web/src/pages/StudyPage.tsx: Current: `L("הראי לי דרך אחרת לפתור את אותו תרגיל (שיטה אחרת), צעד אחר צעד, ומתי כדאי כל דרך", "Show me another way to solve the same problem (a different method), step by step, and when each way is better")` | Suggested: `L("דרך פתרון נוספת צעד אחר צעד", "Alternative step-by-step method")` | Kind: Texts too long for a 390 px phone (Action chip has 81 Hebrew characters and 111 English characters; wraps across 4 lines and breaks layout on 390px mobile).
- apps/web/src/pages/StudyPage.tsx: Current: `L("שבוע מבחן: מבחן תרגול על הנושאים החלשים", "Exam week: a practice test on the weak topics")` | Suggested: `L("מבחן תרגול על נושאים חלשים", "Practice test on weak topics")` | Kind: Texts too long for a 390 px phone (Action card button is 41-47 characters; overflows button box on 390px mobile).
- apps/web/src/pages/StudyPage.tsx: Current: `L("+ הרצאה מטקסט, מצגת או צילום", "+ Lecture from text, slides or a photo")` | Suggested: `L("+ הרצאה מקובץ או צילום", "+ Lecture from file/photo")` | Kind: Texts too long for a 390 px phone (Header add button has 30-40 characters; crowds header toolbar on 390px mobile).
- apps/web/src/pages/StudyPage.tsx: Current: `L("מבחן דמה (עם שעון, ציון בסוף)", "Mock exam (timed, graded at the end)")` | Suggested: `L("מבחן דמה מתוזמן", "Timed mock exam")` | Kind: Texts too long for a 390 px phone (Tab/button label has 31-38 characters; overflows screen width on 390px phone).

### `apps/web/src/pages/TaskInboxPage.tsx`

- apps/web/src/pages/TaskInboxPage.tsx: Current: `L("הגדרות › תיבת משימות", "Settings › Task inbox")` vs `i18n.ts: "הגדרות ← זמן ושפה..."` | Suggested: `L("הגדרות ← תיבת משימות", "Settings → Task inbox")` | Kind: The same thing named differently in different places (Inconsistent breadcrumb separator `›` vs `←`).
- apps/web/src/pages/TaskInboxPage.tsx: Current: `L("עוד אין משימות. Claude כותב אותן לענף kesher-inbox, או הוסיפו אחת כאן.", "No tasks yet. Claude writes them to the kesher-inbox branch, or add one here.")` | Suggested: `L("עוד אין משימות. Claude כותב אותן לענף kesher-inbox, או הוסף אחת כאן.", "No tasks yet. Claude writes them to the kesher-inbox branch, or add one here.")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "הוסיפו" instead of singular "הוסף").

### `apps/web/src/pages/TextHelper.tsx`

- apps/web/src/pages/TextHelper.tsx: Current: `L("לא נבחר טקסט. סמנו טקסט בכל אפליקציה ולחצו Ctrl+Alt+K...", "...")` | Suggested: `L("לא נבחר טקסט. סמן טקסט בכל אפליקציה ולחץ Ctrl+Alt+K...", "...")` | Kind: Hebrew typos and unnatural wording (Inconsistent plural address "סמנו... ולחצו").

### `apps/web/src/pages/TrainingPage.tsx`

- apps/web/src/pages/TrainingPage.tsx: Current: `L("להוסיף את המסמכים שלי (דף המסמכים)", "Add my documents (the Pages page)")` | Suggested: `L("להוסיף את המסמכים שלי (דף הדפים)", "Add my documents (the Pages page)")` | Kind: English and Hebrew that say different things (English refers to "the Pages page", but Hebrew says "דף המסמכים", creating confusion with `DocsPage`).
- apps/web/src/pages/TrainingPage.tsx: Current: `L("להוריד ולהתקין את סביבת האימון (בערך 4GB)?", "Download and set up the trainer (about 4 GB)?")` | Suggested: `L("להוריד ולהתקין את סביבת האימון (בערך 4 GB)?", "Download and set up the trainer (about 4 GB)?")` | Kind: Hebrew typos and unnatural wording (Missing space between number and unit: "4GB" -> "4 GB").

### `apps/web/src/pages/UnityCliPanel.tsx`

- apps/web/src/pages/UnityCliPanel.tsx: Current: `L("הוסף פלטפורמת בילד", "Add a build platform")` | Suggested: `L("הוסף פלטפורמת בנייה", "Add a build platform")` | Kind: Hebrew typos and unnatural wording (Slang transliteration "פלטפורמת בילד" instead of standard "פלטפורמת בנייה").
- apps/web/src/pages/UnityCliPanel.tsx: Current: `L("סוג", "Template")` | Suggested: `L("תבנית", "Template")` | Kind: English and Hebrew that say different things (English says "Template" for project template, Hebrew translates as "סוג" / Type).
- apps/web/src/pages/UnityCliPanel.tsx: Current: `L("להוריד ולהתקין את Unity CLI מ-unity.com?", "Download and install Unity's CLI from unity.com?")` | Suggested: `L("הורד והתקן את Unity CLI", "Install Unity CLI")` | Kind: Texts too long for a 390 px phone (Action button label is 42-50 characters; too long for single button row on 390px mobile).

### `apps/web/src/pages/UnrealPage.tsx`

- apps/web/src/pages/UnrealPage.tsx: Current: `L("...כשמשהו משתנה ביוניטי", "...")` vs `L("...מריץ את הסצנה ב-Unity...", "...")` | Suggested: `L("...כשמשהו משתנה ב-Unity", "...")` | Kind: The same thing named differently in different places (Inconsistent naming of Unity: transliterated "ביוניטי" vs English "ב-Unity").
- apps/web/src/pages/UnrealPage.tsx: Current: `L("הצג את הנוד", "Show the node")` vs `GamesPage.tsx: L("אותם צמתים...", "...")` | Suggested: `L("הצג את הצומת", "Show the node")` | Kind: The same thing named differently in different places (Inconsistent term for node: "נוד" vs "צמתים").
