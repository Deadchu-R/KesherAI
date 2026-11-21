# KesherAI Bridge for Unreal Engine

Connects the Unreal Editor to KesherAI on the same computer. In KesherAI (**Create → Unreal Blueprints**) you see your project's Blueprints, and change them in words with your local model. The change happens in the open editor as one undo step (Ctrl+Z), and the Blueprint is compiled so the model sees any errors.

- Unreal Engine 5.1 or newer, editor only (nothing goes into a packaged game).
- The editor connects to `ws://127.0.0.1:7420/api/unreal/ws` (set `KESHER_PORT` for another port). Nothing listens inside Unreal, and KesherAI accepts the connection only from the same computer.
- Licence: Apache-2.0, like KesherAI.

## Install

1. Download `KesherAIBridge.zip` from https://github.com/Deadchu-R/KesherAI/releases/tag/unreal-plugin-latest
2. Unzip it into your project: `YourProject/Plugins/KesherAIBridge/` (the folder with `KesherAIBridge.uplugin`).
3. Open the project. Unreal offers to build the plugin; say yes (needs Visual Studio or Rider with C++ game development).

**Blueprint-only project?** Use KesherAI → Unreal Blueprints → **Install into a project…** instead: it builds the plugin once for your engine (`RunUAT BuildPlugin`) and copies the built files in, so Unreal does not need to compile anything. Or by hand: `Engine\Build\BatchFiles\RunUAT.bat BuildPlugin -Plugin=<path>\KesherAIBridge.uplugin -Package=<out> -TargetPlatforms=Win64`, then copy `<out>` (without `Source` and `Intermediate`) into `YourProject/Plugins/KesherAIBridge`.
4. With KesherAI running, the Unreal page shows 🟢 Connected.

## What KesherAI can ask

| Command | Does |
| --- | --- |
| `list` | Every Blueprint under `/Game` |
| `graph` | One Blueprint: variables, and each graph's nodes, pins, defaults and links |
| `apply` | Operations in one undo step: `add` (call, event, custom_event, branch, sequence, macro, get, set, reroute, comment_box; cast and timeline in 0.1.26), `connect`, `set` (a pin's default), `move`, `delete`, `comment`, `collapse` |
| `compile` | Compiles and returns errors and warnings; 0.1.26: also `nodes`, each node with a compiler message (its id, graph, severity, text) |
| `actions` | The node menu for a Blueprint; 0.1.26: a function's entry carries its `pins` and `pure`, so KesherAI can add it with Unreal closed |
| `save` | Saves the Blueprint's package |
| `open` | Opens the Blueprint in its editor |
| `play_test`, `play_test_status`, `play_test_stop` | A gameplay test (0.1.25): a plan of steps (spawn/possess, Enhanced Input actions, keys and axes for N frames, wait for a condition, assert a value, screenshot) runs in Play In Editor; each step's result is read while it runs |

### Gameplay tests

KesherAI keeps each test as `Content/KesherTests/<name>.json`. The plugin also registers them as automation tests, `KesherAI.PlayTest.<name>`, so they run from **Session Frontend → Automation** or CI (`UnrealEditor-Cmd <project> -ExecCmds="Automation RunTests KesherAI.PlayTest" -unattended -NullRHI`). With Unreal closed, KesherAI runs `KesherAI.PlayTest.Request` the same way (no pictures without rendering). A test changes nothing in the level or assets: it runs only in the play world, and a map in the plan is only the map played.

Changes are not saved to disk until you press Save (in KesherAI or in Unreal).
