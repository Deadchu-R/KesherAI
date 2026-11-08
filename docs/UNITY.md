# Unity Visual Scripting in KesherAI

**Create → Unity Visual Scripting** shows your Unity project's Visual Scripting graphs and changes them in words, with the chat model you chose (a local one keeps everything on your computer).

It works through **Unity's own CLI** (`unity`, from unity.com) and the project's **Pipeline** package, with the **KesherAI Bridge** package ([integrations/unity/com.kesherai.bridge](../integrations/unity/com.kesherai.bridge)) adding a few commands (`kesher_list`, `kesher_graph`, `kesher_apply`, `kesher_check`, `kesher_save`, `kesher_open`). Unity 6 or newer.

## Set up

1. Install Unity's CLI once (free). Windows PowerShell: `irm https://unity.com/install.ps1 | iex` (macOS / Linux: `curl -fsSL https://unity.com/install.sh | bash`).
2. On the Unity page press **Add to a project…** and pick the project folder (with `Assets/` and `Packages/`). KesherAI copies the bridge package into `Packages/com.kesherai.bridge` and runs `unity pipeline install` for the Pipeline package. Unity compiles both by itself: no Visual Studio.

## What it covers

- **Script Graph** and **State Graph** assets.
- Graphs kept **inside a Script Machine or State Machine** on a GameObject — in prefabs, and in scenes (open ones are listed; KesherAI opens a scene beside yours when it needs one).
- A State Graph shows as tabs: **States** (states and transitions; add Flow / Super / Any states, connect them, pick the start state, rename), then the flow graph inside each state and each transition, and the states inside each Super State.

## Use

- Pick a graph and a tab. It is drawn with its units, ports and connections.
- Write what to change, e.g. *on Start log "Hello", and if open is true move the door up*. The model turns it into operations; they are applied as **one undo step** and the graph is checked (inputs left without a value, broken ports, no start state).
- **With Unity open** each step reaches the open editor in well under a second (`unity command …`), and Ctrl+Z in Unity undoes it.
- **With Unity closed** KesherAI runs the same command in a one-shot batch editor (`unity run <project> --command …`): slower (Unity has to start), and the change is saved right away.

## Projects

Every project you add stays in the list on the page; pick which one to work on. Graphs inside prefabs are written back to the prefab when they change.

## Unity in any chat (Unity CLI tools)

When Unity's CLI is installed (or a Unity project was added with **+ → Project** in the message box), every chat gets Unity tools that follow Unity's own guidance for AI agents and work like the Unity connections of other AI tools (MCP for Unity, the Unity AI Assistant): the model writes real C# into `Assets/`, compiles it in the open Editor, reads the errors and fixes them, puts GameObjects and components in the scene, saves it, and checks the Console and a screenshot. It never makes a build or a folder unless you ask, and it is told never to claim a change no tool result shows.

| Tool | What it does | Asks first |
| --- | --- | --- |
| `unity_status` | Is an Editor open on the project and ready (or in Safe Mode, with its compile errors) | no |
| `unity_list_scripts` | The project's code files under `Assets/` | no |
| `unity_read_script` | Reads a text file in `Assets/`, `Packages/` or `ProjectSettings/` | no |
| `unity_write_script` | Writes a code file (C#, shader, USS/UXML, .asmdef) in `Assets/`, then compiles at once (`unity recompile`) and returns the errors; Undo in KesherAI restores the old file | per your file-change setting (never from Telegram) |
| `unity_recompile` | Compiles now and reports errors and warnings (no build) | no |
| `unity_console` | The latest Console entries (`unity logs --console`) | no |
| `unity_scene` | The open scene's hierarchy with components, or saves it | per your file-change setting |
| `unity_create_gameobject` | Adds a GameObject (name, primitive, parent, position, components), one Undo step in Unity | per your file-change setting |
| `unity_add_component` | Adds components (built-in or your compiled scripts) to a GameObject | per your file-change setting |
| `unity_find_commands` | Searches the commands the open Editor offers (`unity command --query`), with their parameters | no |
| `unity_command` | Runs one of them in the open Editor (`unity command <group> <name> -- --flag value`), about half a second, no recompile | yes |
| `unity_script_eval` | Runs C# in the Editor (`script eval`) for anything without a command | yes (never from Telegram) |
| `unity_screenshot` | A picture of the Game or Scene view, for the model and the user | no |

The project is the one chosen on the Unity page (Create → Unity Visual Scripting), where you can also make a new project through the CLI. Arguments go to the CLI as a list, never through a shell; command and parameter names are checked. To test a game the model turns on `editor set_auto_tick` (an unfocused Editor otherwise freezes at frame 1), starts Play mode, checks frames advance, takes a screenshot, reads the console and stops Play mode; when you are already playing it only reads.

While a Unity project is in use, these tools are always sent to the model in full (tool search never hides them), so a small local model cannot "forget" it has them and invent an answer.

**Safety:** paths are checked to stay inside the project (no `..`, no link leading out), writes only go to `Assets/` and only code files; text the model gives (names, paths) reaches C# only as escaped string literals, and type names are checked; nothing runs through a shell. Writing a script is as powerful as running code (an Editor script runs inside Unity), so it follows your approval setting for file changes, and Telegram chats never get it.
