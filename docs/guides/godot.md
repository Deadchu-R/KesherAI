# Godot bridge

**עברית בקצרה:** התוסף `addons/kesher_bridge` מחבר את עורך Godot ל-KesherAI במחשב. הצ'אט רואה ומשנה סצנות, צמתים וסקריפטים (כל שינוי ניתן לביטול ב-Ctrl+Z), מריץ את המשחק וקורא את היומן. עובד גם בפרויקטי C#. אפשר לקרוא סצנות גם בלי Godot.

## What it does
Lets the chat inspect and edit scenes, nodes and scripts, run the game and read its log. The Godot page can also show a `.tscn` scene without Godot running.

## Prerequisites
Godot 4 and a project folder. KesherAI running on the same computer.

## Steps
1. Open the **Godot** page (`#/godot`) and add the project. KesherAI puts `addons/kesher_bridge` in it and turns it on; remove it any time, the project works without it.
2. Open the project in Godot. The addon connects to `ws://127.0.0.1:7420/api/godot/ws` by itself; the page shows connected.
3. Ask for a change in words. Each one is an undo step in the editor's history.
4. **No Godot open:** "A scene without Godot" reads and writes the `.tscn` text directly, with conflict checks and a backup.

## Verify
Ask "add a Sprite2D named Hero to the main scene" and see it in the scene tree; Ctrl+Z removes it.

## Troubleshooting
- Not connected: KesherAI is not running, or its port is not 7420.
- Changes missing after editing a scene file outside Godot: reload the scene in Godot.

## Safety
The addon connects out to this computer only. Edits go through the editor's undo history; scene writes keep a backup.
