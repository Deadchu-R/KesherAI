# KesherAI for Noctalia (v5)

A KesherAI button on the Noctalia bar: whether KesherAI is running and how many chats are working. Click it for a
small panel (open KesherAI, My day); right-click opens KesherAI.

## Install

In KesherAI: Settings → Noctalia → **Connect to Noctalia**. Then in Noctalia: Settings → Bar → Add widget → KesherAI.

By hand: copy this folder to `~/.local/share/noctalia/plugins/kesherai/`, run
`noctalia msg plugins enable kesherai/kesherai`, and add the widget to the bar
(`"kesherai/kesherai:bar"` in a bar lane, or from Settings → Bar).

## Settings

- **KesherAI address**: `http://127.0.0.1:7420` for KesherAI on this computer.
- **Access token** (advanced): only for KesherAI on another computer of yours.

For Noctalia Shell v4 (Quickshell), use `integrations/noctalia/kesherai` instead.
