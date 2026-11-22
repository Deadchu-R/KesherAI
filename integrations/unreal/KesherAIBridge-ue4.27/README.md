# KesherAI Bridge for Unreal Engine 4.27

Connects the Unreal Editor to KesherAI on the same computer. In KesherAI (**Create → Unreal Blueprints**) you see your project's Blueprints, and change them in words with your local model. The change happens in the open editor as one undo step (Ctrl+Z), and the Blueprint is compiled so the model sees any errors.

- Unreal Engine 4.27, editor only (nothing goes into a packaged game).
- The editor connects to `ws://127.0.0.1:7420/api/unreal/ws` (set `KESHER_PORT` for another port). Nothing listens inside Unreal, and KesherAI accepts the connection only from the same computer.
- Licence: Apache-2.0, like KesherAI.

## Limitations (compared to UE 5.x version)

- **Enhanced Input**: not available in UE 4.27. Gameplay test `input` steps (Enhanced Input actions) are not supported; use `key` steps instead.
- **Gameplay tests**: Play In Editor start is simplified (no FRequestPlaySessionParams), map override is not supported.
- **World Partition**: not available in UE 4.27.
- **Live Coding**: not available in UE 4.27.
- **Mesh description export**: LOD mesh export in `level_mesh` is not available (requires UE 5 MeshDescription API changes).
- **Asset export/import**: FBX export options are simplified (no UFbxExportOption in 4.27).

## Install

1. Copy the `KesherAIBridge` folder into your project: `YourProject/Plugins/KesherAIBridge/` (the folder with `KesherAIBridge.uplugin`).
2. Open the project. Unreal offers to build the plugin; say yes (needs Visual Studio with C++ game development).
3. With KesherAI running, the Unreal page shows 🟢 Connected.

Changes are not saved to disk until you press Save (in KesherAI or in Unreal).
