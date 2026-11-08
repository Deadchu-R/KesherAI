# Unity Visual Scripting in KesherAI

**Create → Unity Visual Scripting** shows your Unity project's Script Graphs and changes them in words, with the chat model you chose (a local one keeps everything on your computer).

It works through the **KesherAI Bridge** editor package ([integrations/unity/com.kesherai.bridge](../integrations/unity/com.kesherai.bridge)), Unity 2021.3 and newer with Visual Scripting. Unity compiles the package by itself: no Visual Studio, no build step.

## Set up

- **From KesherAI (this computer):** on the Unity page press **Add to a project…** and pick the project folder (with `Assets/` and `Packages/`). The package is copied into `Packages/com.kesherai.bridge`; no git needed.
- **Or in Unity:** Window → Package Manager → **+** → **Add package from git URL…** →
  `https://github.com/Deadchu-R/KesherAI.git?path=/integrations/unity/com.kesherai.bridge` (needs git installed).

With KesherAI running, the Unity page shows 🟢.

## Use

- Pick a Script Graph (assets under `Assets/`). It is drawn with its units, ports and connections.
- Write what to change, e.g. *on Start log "Hello", and if open is true move the door up*. The model turns it into operations; the editor applies them as **one undo step** (Ctrl+Z in Unity), then KesherAI checks the graph (inputs left without a value, broken ports).
- **Open in Unity**, **Check** and **Save** do what they say. Nothing is saved to disk until you press Save.

## With Unity closed

Like Unreal: every graph opened while Unity is connected is kept as a copy (`unity/<project>/` in KesherAI's data folder), and changes asked for with Unity closed wait under **Waiting for Unity** until the project opens.

## Limits (0.1)

- Script Graph assets only; graphs embedded in a Script Machine and State Graphs come later.
- Node kinds the model can add: method calls (any public method, `Namespace.Type:Method`), events (Start, Update, OnTriggerEnter…), any unit by class name (If, Sequence, ForLoop, Wait…), variables (get/set, any kind), literals, custom events.
