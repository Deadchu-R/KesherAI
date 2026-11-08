# Unreal Blueprints in KesherAI

**Create → Unreal Blueprints** shows your Unreal project's Blueprints and changes them in words, with the chat model you chose (a local one keeps everything on your computer).

It works through the **KesherAI Bridge** editor plugin ([integrations/unreal/KesherAIBridge](../integrations/unreal/KesherAIBridge)), Unreal Engine 5.1 and newer.

## Set up

**Easiest (Windows, also for Blueprint-only projects):** on the Unreal page press **Install into a project…** and pick the project folder. KesherAI finds the project's engine, builds the plugin for it once with the engine's own tool (`RunUAT BuildPlugin`, a few minutes; it needs Visual Studio's free C++ tools, but not a C++ project), and copies the built plugin into `Plugins/KesherAIBridge` without its source, so Unreal loads it without asking to compile. Other projects of the same engine reuse the build.

**By hand:**

1. Download [KesherAIBridge.zip](https://github.com/Deadchu-R/KesherAI/releases/download/unreal-plugin-latest/KesherAIBridge.zip) (also on the Unreal page).
2. Unzip it into `YourProject/Plugins/` so you have `YourProject/Plugins/KesherAIBridge/KesherAIBridge.uplugin`.
3. Open the project and let Unreal build the plugin (a C++ project with Visual Studio or Rider). For a Blueprint-only project use **Install into a project** instead.
4. Keep KesherAI running: the editor connects by itself, and the Unreal page shows 🟢.

## Use

- Pick a Blueprint, then a graph (event graph, functions, macros). The graph is drawn as in the editor: nodes, pins in Unreal's colors, links.
- Write what to change, e.g. *on BeginPlay print "Hello", and if Open is true call OpenDoor*. The model turns it into operations, the editor applies them as **one undo step**, and the Blueprint is compiled; errors and warnings are shown.
- **Open in Unreal**, **Compile** and **Save** do what they say. Nothing is saved to disk until you press Save.

## With Unreal closed

Blueprint files (`.uasset`) can be read and written safely only by the engine, so KesherAI does not touch them directly. Instead:

- Every Blueprint opened while the editor is connected is kept as a copy in KesherAI's data folder (`unreal/<project>/`). With Unreal closed you can still look at it.
- A change asked for then waits in **Waiting for Unreal**. When the project opens with the plugin, waiting changes are applied and compiled (not saved). You can cancel any of them first.

## Safety

- The connection is only within this computer (`127.0.0.1`); KesherAI refuses it from anywhere else.
- From the phone (remote access) you can look at Blueprints and ask for changes like any other chat action.

## Limits (0.1)

- Node kinds the model can add: function calls (any `UFUNCTION`), parent events, custom events, Branch, Sequence, variable get/set. Others (timelines, macros, casts) come later.
- The plugin is new: if a build or a command fails in your engine version, open an issue with the message.

## Unreal 5.8+: Unreal's own MCP server for every chat

Create → Unreal Blueprints → "Connect chats to Unreal 5.8+ (MCP)…" picks the project folder and:

- turns on the `ModelContextProtocol` and `AllToolsets` plugins in the `.uproject` (the old file is kept as `.uproject.kesher-backup`);
- sets `bAutoStartServer=True` in `Saved/Config/<Platform>Editor/EditorPerProjectUserSettings.ini` (per user, not in source control);
- adds and turns on the "Unreal Engine" connection (http://127.0.0.1:8000/mcp).

When the project is open, every chat gets the editor's tools (`list_toolsets`, `describe_toolset`, `call_tool`) with Unreal's guidance in the prompt: discover before calling, check for project skills, save before changes across assets, wait for compiles, read every result, mind Play-in-Editor. Calls that change things ask first. Projects on Unreal 5.7 or older keep using the KesherAI Bridge plugin above.
