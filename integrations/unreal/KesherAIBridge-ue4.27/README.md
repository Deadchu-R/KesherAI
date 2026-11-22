# KesherAI Bridge for Unreal Engine 4.27

Connects the Unreal Editor to KesherAI on the same computer. In KesherAI (**Create → Unreal Blueprints**) you see your project's Blueprints, and change them in words with your local model. The change happens in the open editor as one undo step (Ctrl+Z), and the Blueprint is compiled so the model sees any errors.

- Unreal Engine 4.27, editor only (nothing goes into a packaged game).
- The editor connects to `ws://127.0.0.1:7420/api/unreal/ws` (set `KESHER_PORT` for another port). Nothing listens inside Unreal, and KesherAI accepts the connection only from the same computer.
- Licence: Apache-2.0, like KesherAI.

## Limitations (compared to the Unreal 5 version)

- **Enhanced Input**: Unreal 4.27 has no Enhanced Input plugin. Gameplay test `input` steps answer "Not available in Unreal 4.27"; use `key` or `axis` steps instead.
- **Live Coding**: `live_coding` starts the compile but cannot wait for it (4.27's Live Coding gives no result back); the outcome shows in Unreal's Live Coding window.
- **World Partition**: Unreal 5 only, so `level` always reports `partitioned: false` (every 4.27 level is whole).
- **Headless editor**: Unreal 4.27's command-line editor is `UE4Editor-Cmd` (not `UnrealEditor-Cmd`).
- Everything else (Blueprints, variables, widgets, levels and meshes, block-outs, Niagara copies, asset export/import, gameplay tests with a map) works as in the Unreal 5 version.

## Source layout

KesherAI lays the Unreal 5 plugin's files first and this folder's files over them, then builds with Unreal 4.27's `RunUAT BuildPlugin`. Every source file of the module is here in its 4.27 form; the comments marked "Unreal 4.27" explain each difference from the Unreal 5 code.

## Install

1. Copy the `KesherAIBridge` folder into your project: `YourProject/Plugins/KesherAIBridge/` (the folder with `KesherAIBridge.uplugin`).
2. Open the project. Unreal offers to build the plugin; say yes (needs Visual Studio with C++ game development).
3. With KesherAI running, the Unreal page shows 🟢 Connected.

Changes are not saved to disk until you press Save (in KesherAI or in Unreal).
