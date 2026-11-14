# KesherAI in Waybar (and other bars)

`kesherai-status.sh` prints KesherAI's state as Waybar JSON: `✦` when ready, `✦ 2` while two chats work, and
an `offline` class when KesherAI is not running. Copy it to `~/.config/waybar/` and add:

```jsonc
"custom/kesherai": {
  "exec": "~/.config/waybar/kesherai-status.sh",
  "return-type": "json",
  "interval": 10,
  "on-click": "xdg-open http://127.0.0.1:7420"
}
```

then put `"custom/kesherai"` in `modules-right`. Style it with `#custom-kesherai.working { color: #5EEAD4; }`.
Another of your computers: set `KESHERAI_URL` and `KESHERAI_TOKEN` (its remote-access token) in the `exec` line.
For Noctalia, use the plugin in `integrations/noctalia/kesherai`.
