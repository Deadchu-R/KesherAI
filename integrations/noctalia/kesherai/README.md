# KesherAI for Noctalia

A bar button for [Noctalia](https://noctalia.dev): lit while KesherAI's chats are working; click for a small panel
to ask your local AI (a new KesherAI chat) and open it in KesherAI; right-click to open KesherAI.

Install: copy this folder to `~/.config/noctalia/plugins/kesherai`, then enable it in Noctalia's plugin settings
and add the widget to the bar. It needs `curl` and KesherAI running on this computer (or set another computer's
address and its remote-access token in the widget's settings).

Toggle the panel from a key binding: `qs ipc call plugin:kesherai toggle`.
