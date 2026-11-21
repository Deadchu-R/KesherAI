# Unity bridge

**עברית בקצרה:** גשר Unity מציג ומשנה גרפי Visual Scripting ומאפשר לכל שיחה לכתוב C# ולהפעיל את העורך, דרך ה-CLI של Unity וחבילת KesherAI Bridge. מתקינים CLI פעם אחת, לוחצים "הוסף לפרויקט", והחבילה מועתקת ל-`Packages/`. כש-Unity סגור שינויים נכנסים לתור ומוחלים בהפעלה הבאה. פרטים: [../UNITY.md](../UNITY.md).

## What it does
Create > Unity Visual Scripting shows Script and State graphs and changes them from words (one undo step each). In any chat, Unity tools write and compile scripts, edit the scene, read the Console and take screenshots.

## Prerequisites
Unity 6 or newer, a project with `Assets/` and `Packages/`, Unity's free CLI. Optional: Visual Studio or another code editor.

## Steps
1. Install the CLI once. Windows PowerShell: `irm https://unity.com/install.ps1 | iex`. macOS/Linux: `curl -fsSL https://unity.com/install.sh | bash`.
2. On the Unity page press **Add to a project...** and pick the folder. KesherAI copies `com.kesherai.bridge` into `Packages/` and runs `unity pipeline install`. Unity compiles both.
3. **Update:** press **Add to a project...** again on the same project to copy the newer bridge. Needed for features such as Close Unity (0.2.7) and Unreal-style graph keys (0.2.6).
4. **Code editor:** scripts are plain files under `Assets/`; open them in Visual Studio, Rider or VS Code as usual (KesherAI finds installed editors; Visual Studio through `vswhere`).
5. **Unity closed:** graphs read are kept as copies ("offline copy, saved ..."); changes you ask for queue and are applied by a one-shot batch editor or at the next open. Slower, because Unity must start.

## Verify
With Unity open, ask "on Start log Hello". The graph updates in under a second and Ctrl+Z in Unity undoes it. `unity_status` in a chat says whether the Editor is ready.

## Troubleshooting
- Editor in Safe Mode: fix the compile errors shown, then retry.
- Frame stays at 1 in tests: an unfocused Editor needs `editor set_auto_tick`.
- Bridge outdated: update it (step 3).

## Safety
Paths stay inside the project; writes go only to code files under `Assets/`. Writing a script is as powerful as running code, so it follows your approval setting (never from Telegram). Nothing runs through a shell.
