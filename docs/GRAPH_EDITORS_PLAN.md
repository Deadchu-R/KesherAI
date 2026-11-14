# Blueprint and Unity Visual Scripting editing: research and plan

Written 2026-11-13 after Roee's report: "Editing Blueprints and Unity Visual Scripting does not work well on the
computer. Sometimes I pull from a pin to drag a wire and it just moves the screen (Blueprint). The Unity one
supports nothing. I want both to support everything the engines can do, synced when I open a project."

## What was wrong (found in the code)
- **Pulling from a pin moved the view.** The canvas is read-only when the editor is not connected (or the graph
  is a saved copy). In read-only, any drag on a node or a pin pans, and nothing said why. So it looked like a bug
  in the drag. Fixed in 0.6.124: the canvas says why it is read-only when the user tries; a pin's grab area keeps
  its size on screen when zoomed out.
- **Unity editing was switched off in the page** (`editable={!unity && …}`), although KesherAI's Unity package
  already applies operations (add, connect, set, move, delete, as one undo step). 0.6.124 turns on what the
  installed package supports: move, connect, delete. Adding nodes from a menu and breaking links need the
  package's next version (below).

## How the engines do it

### Unreal's Blueprint graph (Epic's cheat sheet)
- **Wires:** drag pin to pin connects; **drag from a pin and release on empty space opens the action menu
  filtered for that pin**; Alt+click a pin breaks all its links; Ctrl+drag a pin moves all its links to another
  pin; hovering a pin highlights its wires.
- **Nodes:** right-click empty space: all actions; hold a letter and click to place a node (B Branch, S Sequence,
  D Delay, F For Each, G Gate, M MultiGate, N Do N, O Do Once, P BeginPlay, C Comment); drag a variable in: Get
  or Set (Ctrl = Get, Alt = Set).
- **Selection and view:** click, Shift/Ctrl+click, marquee (Shift adds, Ctrl removes); right-drag pans; wheel
  zooms; Home fits; arrows move nodes.
- **Editing:** cut/copy/paste, Ctrl+D duplicate, F2 rename, C wraps the selection in a comment, double-click
  enters a function or collapsed graph, F7 compile, Ctrl+S save, F9 breakpoint, Ctrl+F find.
- Not on the cheat sheet but in the editor: reroute nodes (double-click a wire), align and straighten, collapse
  to function/macro, promote a pin to a variable, split a struct pin, per-pin "Break link to…".

### Unity Visual Scripting (Unity's manual)
- **Connections:** click (or drag from) a port, then a port on another node; **ending on empty space opens the
  fuzzy finder**, filtered for that port, and the new node arrives connected. **Right-click a port deletes its
  connection.** Incompatible ports dim while a connection is being made.
- A control output has one connection; a value output can feed many inputs; a value input takes one.
- Nodes come from the fuzzy finder (right-click empty space), which lists every unit type, the project's own
  types and members (after "Regenerate Nodes"), and graph/object/scene variables.
- Groups (Ctrl+drag), subgraphs, State Graphs with transitions, Blackboard variables (graph, object, scene, app,
  saved), inline literal values on ports.

### How others edit graphs from outside the editor
- **MCP servers for Unreal** (many on Fab and GitHub in 2026; Epic's own Unreal MCP has a Blueprints toolset in
  5.8, expanded in 5.9): all drive the editor's own API from a plugin inside it; none keeps a second copy of the
  graph. The good ones return the changed graph and the compile result after each change.
- **blueprintUE and similar web viewers** render copied Blueprint text; they do not write back.
- The lesson: the editor is the only source of truth. An outside canvas is a view that sends operations and
  reads the graph again. That is how KesherAI's canvas already works.

## What to build, in order

### 1. Unity to the same level as Unreal (needs a new Unity package version)
- C# (`KesherGraph.cs`): `disconnect` for flow graphs (one port, or one link); `actions` (the fuzzy finder's
  options for a graph, filtered by a text and by a port's type: unit types, members of the project's types,
  variables); `undo` / `redo` commands; `copy`/`paste` of units.
- Routes: `/api/unity/actions`, `/api/unity/undo`, `/api/unity/redo`.
- Canvas: the action menu for Unity; Alt+click and right-click a port to disconnect; a control output replaces
  its link instead of adding one; dim ports that cannot take the wire.
- State Graphs: states and transitions drawn as a state machine (today only flow graphs get the canvas).

### 2. The Blueprint canvas to the cheat sheet
- ✅ 0.6.135: hold B / S / D / P + click empty space → Branch, Sequence, Delay, Event BeginPlay.
- ✅ 0.6.143 (plugin 0.1.11): reroute nodes (R + click; drawn as dots on wires) and comment boxes (C around the selected
  nodes; moved by the title with the nodes inside, resized from the corner, renamed by double-click; colour kept).
- Hold-a-letter + click to place common nodes; drag a variable in for Get/Set; Ctrl+drag a pin to move its
  links; break one link (click a wire, Delete); hover highlight.
- Reroute nodes; comments (C) with resize and colour; align; duplicate, copy, paste (inside one graph first).
- Rename (F2); promote to variable; split struct pin; collapse to function. Each needs a bridge operation;
  listed here so the plugin's API grows in one planned step, not ten small ones.
- Compile result drawn on the nodes (error and warning badges), as the editor does.

### 3. Sync when a project opens
- ✅ 0.6.134: the page reads the open graph again every 10 s while the editor is connected (changes made in the
  editor show up), skipped right after a click or key on the page.
- ✅ 0.6.143: the bridge's "changed" event (on compile) makes the page read the graph at once; the page says when it last
  read the graph from the editor. Unity still relies on the 10 s reads (its package has no change event yet).
- **Unreal:** the bridge connects by itself when the editor starts. Add: the page refreshes its Blueprint list and
  the open graph the moment the editor connects (today only on reload); queued changes made while the editor
  was closed are applied and shown one by one; the canvas reloads when the Blueprint changes in the editor
  (the bridge sends a "changed" event on compile or save).
- **Unity:** the package reports when the project opens (a hello on domain reload) so KesherAI marks it
  connected without a CLI poll; the same "changed" event on asset save.
- Both: a line in the page saying when the graph was last read from the editor.

### 4. "Everything the engine can do"
Not every editor feature has a public API (Unreal's timeline editor, Unity's inspector widgets for custom
types). The honest target: every operation the graph API allows, listed per engine in this file and checked
off; for the rest, an "Open in the editor" button at that node.

## Risks
- **The Unity changes cannot be compiled or run in Claude's workspace** (no Unity). Each package version must be
  tried on Roee's computer before it is called working.
- **Unreal 5.9 changes the Blueprint toolset.** If Epic's own MCP tools become reliable for graph edits, the
  bridge can call them instead of its own code; to be checked when 5.9 is installed.
- The canvas file is 550 lines and grows with each feature: split it (view, wires, menu, shortcuts) before
  stage 2.

## Sources
- Blueprint Editor Cheat Sheet: https://dev.epicgames.com/documentation/unreal-engine/blueprint-editor-cheat-sheet-in-unreal-engine
- Connect nodes in a Script Graph: https://docs.unity3d.com/Packages/com.unity.visualscripting@1.9/manual/vs-creating-connections.html
- Unreal Engine 5.9 Preview release notes (Unreal MCP toolsets): https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-9-release-notes
