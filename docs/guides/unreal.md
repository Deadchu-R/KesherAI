# Unreal bridge

**עברית בקצרה:** תוסף KesherAI Bridge מציג ומשנה Blueprints במילים. "התקן בפרויקט" בונה את התוסף פעם אחת עם `RunUAT BuildPlugin` (דורש כלי C++ של Visual Studio, לא פרויקט C++). כש-Unreal סגור, בקשות מחכות ב"ממתין ל-Unreal" ומוחלות בפתיחה. ב-Unreal 5.8+ אפשר גם לחבר את שרת ה-MCP של Unreal. פרטים: [../UNREAL.md](../UNREAL.md).

## What it does
Create > Unreal Blueprints draws a Blueprint's graphs and changes them from words as one undo step, compiles, and reports errors. From 5.8 the editor's own MCP tools are offered to every chat.

## Prerequisites
Unreal Engine 5.1+, Windows for the one-click build, Visual Studio's free C++ tools.

## Steps
1. **Plugin build:** Unreal page > **Install into a project...** > pick the project. KesherAI builds the plugin for that project's engine (a few minutes, reused by other projects of the same engine) and copies it to `Plugins/KesherAIBridge` without source.
2. By hand instead: unzip `KesherAIBridge.zip` into `YourProject/Plugins/` and let Unreal build it (C++ project only).
3. **Play tests:** with the editor connected (the page shows green), ask the chat to run Play-in-Editor and read the log; it should check the result before saying it worked.
4. **Offline Blueprints:** every Blueprint opened while connected is kept as a copy in KesherAI's data folder. With Unreal closed you can view it; asked changes wait in "Waiting for Unreal", are applied and compiled (not saved) when the project opens, and can be cancelled first.
5. **Unreal 5.8+ MCP:** "Connect chats to Unreal 5.8+ (MCP)..." edits the `.uproject` (backup kept as `.uproject.kesher-backup`) and adds the connection `http://127.0.0.1:8000/mcp`.

## Verify
The Unreal page shows green; ask "on BeginPlay print Hello" and see the nodes; press Compile.

## Troubleshooting
- Build fails: check Visual Studio's C++ workload and the engine version; open an issue with the message.
- Nothing connects: KesherAI must be running on the same computer.

## Safety
The editor link accepts only `127.0.0.1`. Nothing is saved to disk until you press Save. Calls that change things ask first.
