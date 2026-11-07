# Command line and server mode

## Without a window

- Desktop app: `KesherAI --headless` (or `--server`) runs KesherAI with no window — the tray icon opens it. **Settings → "Start with the computer, in the background"** does this at every start-up, so a strong computer is always there for the phone and your other computers.
- From the repository: `kesher serve [--port 7420] [--data-dir …]` (the same as `kesher-core`).

## `kesher`

```
kesher chat "explain BM25"            one answer, streamed
kesher chat                            an interactive chat (empty line quits)
    --model <id>  --persona <name>  --code <folder>  --web  -y (approve every tool)
echo "text" | kesher chat --persona Editor
kesher models [category]               the models you can use (● = active)
kesher search "refund policy"          your knowledge bases, with sources
kesher run "Translate line by line" text="..." language=English
kesher status
```

It talks to the KesherAI running on this computer; chats it starts appear in the app. For another computer: `--url http://host:7420 --token <remote token>` (or `KESHER_URL`, `KESHER_TOKEN`); an app access key works too.

Where it is: the desktop app ships `kesher.cmd` (Windows) and `kesher` (macOS, Linux) in its resources folder (`C:\Users\<you>\AppData\Local\Programs\KesherAI\resources` on Windows) — add that folder to PATH. In the repository: `node packages/core/dist/cli.js`, or `pnpm --filter @kesher/core exec kesher`.
