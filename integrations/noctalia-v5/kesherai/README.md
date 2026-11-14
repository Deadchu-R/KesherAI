# KesherAI for Noctalia (v5)

Chat with KesherAI, your local AI, from a side panel (like Noctalia's Notes). Click the KesherAI button on the bar:
the panel opens on the right; type and press Enter (Shift+Enter for a new line), and the answer is written live.
Approvals KesherAI asks for can be answered right there. + starts a new chat; the arrow opens the chat in KesherAI.
The button shows how many chats are working; right-click opens KesherAI.

From the keyboard: `noctalia msg plugin kesherai/kesherai:bar focused toggle` opens or closes the panel (bind it to a
key in your compositor).

## Install

In KesherAI: Settings → Noctalia → **Connect to Noctalia**. Then in Noctalia: Settings → Bar → Add widget → KesherAI.

By hand: copy this folder to `~/.local/share/noctalia/plugins/kesherai/`, run
`noctalia msg plugins enable kesherai/kesherai`, and add the widget to the bar
(`"kesherai/kesherai:bar"` in a bar lane, or from Settings → Bar).

## Settings

- **KesherAI address**: `http://127.0.0.1:7420` for KesherAI on this computer.
- **Access token** (advanced): only for KesherAI on another computer of yours.

For Noctalia Shell v4 (Quickshell), use `integrations/noctalia/kesherai` instead.
