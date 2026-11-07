/**
 * Plain-language explanations of shell commands, for approval cards: the
 * user sees what a command does before allowing it, not just its text.
 * Each part of a command line (split at `&&`, `;`, `|`, `||`) gets one line,
 * in English and Hebrew.
 */

/** One part of a command, explained. */
export interface CommandPart {
  /** The command text of this part. */
  text: string;
  en: string;
  he: string;
  /** Deletes, overwrites or changes the system: shown in warning colour. */
  risky?: boolean;
}

type Rule = { re: RegExp; en: (m: RegExpExecArray) => string; he: (m: RegExpExecArray) => string; risky?: boolean };

const arg = (m: RegExpExecArray, i = 1) => (m[i] ?? "").trim().replace(/^["']|["']$/g, "");

const RULES: Rule[] = [
  { re: /^(?:python3?|py)(?:\s+-m)?\s+pip\s+install\s+(.+)/i, en: (m) => `Installs the Python packages: ${arg(m)}`, he: (m) => `מתקין חבילות פייתון: ${arg(m)}` },
  { re: /^pip3?\s+install\s+(.+)/i, en: (m) => `Installs the Python packages: ${arg(m)}`, he: (m) => `מתקין חבילות פייתון: ${arg(m)}` },
  { re: /^(?:python3?|py)(?:\s+-m)?\s+pip\s+uninstall\s+(.+)/i, en: (m) => `Removes the Python packages: ${arg(m)}`, he: (m) => `מסיר חבילות פייתון: ${arg(m)}`, risky: true },
  { re: /^(?:python3?\s+-m\s+)?pyinstaller\b(.*)/i, en: () => "Builds a program (.exe) from Python code with PyInstaller", he: () => "בונה תוכנה (‎.exe) מקוד פייתון בעזרת PyInstaller" },
  { re: /^(?:python3?|py)\s+-m\s+venv\s+(\S+)/i, en: (m) => `Creates a separate Python environment in the folder ${arg(m)}`, he: (m) => `יוצר סביבת פייתון נפרדת בתיקייה ${arg(m)}` },
  { re: /^(?:python3?|py)\s+(?:-\S+\s+)*(\S+\.py)\b/i, en: (m) => `Runs the Python script ${arg(m)}`, he: (m) => `מריץ את סקריפט הפייתון ${arg(m)}` },
  { re: /^(?:python3?|py)\s+(?:--version|-V)\b/i, en: () => "Checks which Python version is installed", he: () => "בודק איזו גרסת פייתון מותקנת" },
  { re: /^(?:python3?|py)\s+-c\b/i, en: () => "Runs a short piece of Python code", he: () => "מריץ קטע קוד פייתון קצר" },
  { re: /^winget\s+install\b(?:.*?--id[ =]|(?:\s+-{1,2}[\w-]+)*\s+)([\w.][\w.-]*)/i, en: (m) => `Installs the program ${arg(m)} with Windows' package manager (winget)`, he: (m) => `מתקין את התוכנה ${arg(m)} דרך מנהל החבילות של Windows‏ (winget)`, risky: true },
  { re: /^winget\s+uninstall\s+(.+)/i, en: (m) => `Uninstalls the program ${arg(m)}`, he: (m) => `מסיר את התוכנה ${arg(m)} מהמחשב`, risky: true },
  { re: /^(?:brew|apt(?:-get)?|sudo\s+apt(?:-get)?)\s+install\s+(.+)/i, en: (m) => `Installs on the system: ${arg(m)}`, he: (m) => `מתקין במערכת: ${arg(m)}`, risky: true },
  { re: /^(?:npm|pnpm|yarn)\s+(?:install|i|add)\b\s*(.*)/i, en: (m) => (arg(m) ? `Installs the JavaScript packages: ${arg(m)}` : "Installs the project's JavaScript packages"), he: (m) => (arg(m) ? `מתקין חבילות JavaScript‏: ${arg(m)}` : "מתקין את חבילות ה-JavaScript של הפרויקט") },
  { re: /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(build|test|start|dev|lint)\b/i, en: (m) => `Runs the project's "${arg(m)}" script`, he: (m) => `מריץ את סקריפט ה-"${arg(m)}" של הפרויקט` },
  { re: /^npx\s+(\S+)/i, en: (m) => `Downloads (if needed) and runs the tool ${arg(m)}`, he: (m) => `מוריד (אם צריך) ומריץ את הכלי ${arg(m)}` },
  { re: /^node\s+(\S+)/i, en: (m) => `Runs the JavaScript file ${arg(m)}`, he: (m) => `מריץ את קובץ ה-JavaScript‏ ${arg(m)}` },
  { re: /^git\s+clone\s+(\S+)/i, en: (m) => `Downloads the repository ${arg(m)}`, he: (m) => `מוריד את המאגר ${arg(m)}` },
  { re: /^git\s+(status|diff|log|show|branch)\b/i, en: (m) => `Shows the project's git ${arg(m)} (reads only)`, he: (m) => `מציג את ה-${arg(m)} של git בפרויקט (קריאה בלבד)` },
  { re: /^git\s+(add|commit)\b/i, en: () => "Saves the current changes in git (locally)", he: () => "שומר את השינויים הנוכחיים ב-git (מקומית)" },
  { re: /^git\s+push\b/i, en: () => "Uploads the commits to the remote repository (GitHub or similar)", he: () => "מעלה את השינויים למאגר המרוחק (GitHub וכדומה)", risky: true },
  { re: /^git\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore)\b/i, en: () => "Throws away uncommitted changes in git", he: () => "מוחק שינויים שלא נשמרו ב-git", risky: true },
  { re: /^git\s+init\b/i, en: () => "Turns the folder into a git repository", he: () => "הופך את התיקייה למאגר git" },
  { re: /^(?:rm|del|erase|rmdir|rd|remove-item)\b\s*(.*)/i, en: (m) => `Deletes: ${arg(m) || "files"}`, he: (m) => `מוחק: ${arg(m) || "קבצים"}`, risky: true },
  { re: /^(?:mv|move|ren|rename|move-item)\s+(.+)/i, en: (m) => `Moves or renames: ${arg(m)}`, he: (m) => `מעביר או משנה שם: ${arg(m)}` },
  { re: /^(?:cp|copy|xcopy|robocopy|copy-item)\s+(.+)/i, en: (m) => `Copies: ${arg(m)}`, he: (m) => `מעתיק: ${arg(m)}` },
  { re: /^(?:mkdir|md|new-item\s+-itemtype\s+directory)\s+(.+)/i, en: (m) => `Creates the folder ${arg(m)}`, he: (m) => `יוצר את התיקייה ${arg(m)}` },
  { re: /^(?:ls|dir|tree|get-childitem)\b/i, en: () => "Lists the files in a folder (reads only)", he: () => "מציג את הקבצים בתיקייה (קריאה בלבד)" },
  { re: /^(?:cat|type|more|get-content|head|tail)\s+(.+)/i, en: (m) => `Shows the contents of ${arg(m)} (reads only)`, he: (m) => `מציג את התוכן של ${arg(m)} (קריאה בלבד)` },
  { re: /^cd\s+(.+)/i, en: (m) => `Goes into the folder ${arg(m)}`, he: (m) => `נכנס לתיקייה ${arg(m)}` },
  { re: /^(?:where|which|get-command)\s+(\S+)/i, en: (m) => `Checks whether ${arg(m)} is installed`, he: (m) => `בודק אם ${arg(m)} מותקן` },
  { re: /^(?:curl|wget|invoke-webrequest|iwr)\b\s*(\S*)/i, en: (m) => `Downloads from the internet${arg(m) ? `: ${arg(m)}` : ""}`, he: (m) => `מוריד מהאינטרנט${arg(m) ? `: ${arg(m)}` : ""}` },
  { re: /^(?:java|javac)\b/i, en: () => "Compiles or runs Java code", he: () => "מקמפל או מריץ קוד Java" },
  { re: /^dotnet\s+(build|run|publish|new)\b/i, en: (m) => `Runs .NET ${arg(m)} on the project`, he: (m) => `מריץ ‎.NET ${arg(m)} על הפרויקט` },
  { re: /^(?:cargo|go)\s+(build|run|test)\b/i, en: (m) => `Runs ${arg(m)} on the project`, he: (m) => `מריץ ${arg(m)} על הפרויקט` },
  { re: /^(?:start|explorer|open|xdg-open)\s+(.+)/i, en: (m) => `Opens ${arg(m)}`, he: (m) => `פותח את ${arg(m)}` },
  { re: /^(?:taskkill|kill|pkill|stop-process)\b/i, en: () => "Stops running programs", he: () => "סוגר תוכנות שרצות", risky: true },
  { re: /^(?:shutdown|restart-computer|reboot)\b/i, en: () => "Shuts down or restarts the computer", he: () => "מכבה או מפעיל מחדש את המחשב", risky: true },
  { re: /^(?:reg|regedit|set-itemproperty)\b/i, en: () => "Changes Windows settings (registry)", he: () => "משנה הגדרות של Windows (רישום)", risky: true },
  { re: /^(?:setx|\[environment\]::setenvironmentvariable)\b/i, en: () => "Changes an environment variable permanently", he: () => "משנה משתנה סביבה לצמיתות", risky: true },
  { re: /^(?:echo|write-output|write-host)\b/i, en: () => "Prints text", he: () => "מדפיס טקסט" },
  { re: /^(?:powershell|pwsh)\b/i, en: () => "Runs PowerShell commands", he: () => "מריץ פקודות PowerShell" },
  { re: /^\.?[\\/]?(?:dist[\\/])?([\w.-]+\.(?:exe|bat|cmd|sh))\b/i, en: (m) => `Runs the program ${arg(m)}`, he: (m) => `מריץ את התוכנה ${arg(m)}` },
];

/**
 * Splits a command line into parts and explains each one.
 *
 * @param command - The command line the agent wants to run.
 * @returns One entry per part; unknown commands get a generic line.
 */
export function explainCommand(command: string): CommandPart[] {
  const parts = command
    .split(/\s*(?:&&|\|\||;|\|(?!\|))\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((text) => {
    const writesFile = /(?:^|[^>])>{1,2}\s*\S/.test(text) && !/2>&1|>\s*nul\b|>\s*\/dev\/null/i.test(text);
    for (const r of RULES) {
      const m = r.re.exec(text);
      if (m) {
        const extra = writesFile ? { en: " (and writes the output to a file)", he: " (וכותב את הפלט לקובץ)" } : { en: "", he: "" };
        return { text, en: r.en(m) + extra.en, he: r.he(m) + extra.he, ...(r.risky ? { risky: true } : {}) };
      }
    }
    const name = text.split(/\s+/)[0] ?? text;
    return { text, en: `Runs ${name}`, he: `מריץ את ${name}`, ...(writesFile ? { risky: true } : {}) };
  });
}
