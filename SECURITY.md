# Security

Kesher runs models, downloads files and (later) executes code on your computer, so security is a design concern, not an afterthought.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability"). We aim to reply within 7 days.

## What Kesher does today

- **Listens on localhost only by default.** The core server binds to `127.0.0.1` unless you turn on remote access.
- **Remote access requires a token.** With `remote.enabled`, every request that does not come from the computer itself must send the token (`Authorization: Bearer …`, or `?token=` for images and event streams). Tokens are compared in constant time.
- **No built-in TLS yet.** Remote traffic is plain HTTP. Use it only inside a trusted network or over an encrypted tunnel such as Tailscale or WireGuard. Never forward the port to the internet.
- **Config file is owner-only.** `~/.kesher/config.json` holds API keys and is written with mode `0600`. Moving keys into the operating system's keychain is planned.
- **Downloads are verified.** Files with a SHA-256 on Hugging Face are checked after download, and a mismatch deletes the file. The UI warns about pickle formats (`.ckpt`, `.bin`, `.pt`), which can execute code when loaded; prefer `safetensors` and `GGUF`.
- **Download paths cannot escape their folder**, and llama.cpp only loads models from Kesher's models folder.

## Known limitations

- **Plugins run inside the core process** with the same permissions as Kesher itself. Only install plugins you trust. Running each plugin in its own process limited to the permissions in its manifest is on the roadmap.
- **Skills and MCP servers** can contain instructions or code. Review them before installing.
