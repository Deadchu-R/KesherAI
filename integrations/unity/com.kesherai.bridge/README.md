# KesherAI Bridge for Unity

Connects the Unity Editor to KesherAI on the same computer. In KesherAI (**Create → Unity Visual Scripting**) you see your project's Script Graphs and change them in words with your local model; the change happens in the open editor as one undo step (Ctrl+Z).

- Unity 2021.3 or newer with Visual Scripting (installed with it if missing). Editor only; nothing goes into a build.
- No compiler or Visual Studio needed: Unity compiles the package by itself.
- The editor connects to `ws://127.0.0.1:7420/api/unity/ws` (set `KESHER_PORT` for another port). Nothing listens inside Unity, and KesherAI accepts the connection only from the same computer.
- Licence: Apache-2.0, like KesherAI.

## Install

Either press **Add to a project…** on KesherAI's Unity page, or in Unity: **Window → Package Manager → + → Add package from git URL…** and paste

```
https://github.com/Deadchu-R/KesherAI.git?path=/integrations/unity/com.kesherai.bridge
```

## What KesherAI can ask

| Command | Does |
| --- | --- |
| `list` | Every Script Graph asset under `Assets/` |
| `graph` | One graph: its units (nodes), ports, defaults and connections, and its graph variables |
| `apply` | Operations in one undo step: `add` (call a method, an event or any unit such as If/Sequence, get/set a variable, a literal), `connect`, `set` (an input's default), `move`, `delete` |
| `compile` | Checks the graph: inputs without a value, broken ports |
| `save` | Saves the asset |
| `open` | Opens the graph in the Visual Scripting window |

Graphs embedded in a Script Machine component (not saved as an asset) and State Graphs are not supported yet.
