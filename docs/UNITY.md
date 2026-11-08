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
