# Code signing policy

Free code signing for the Windows installer is provided by [SignPath.io](https://signpath.io), with the certificate by [SignPath Foundation](https://signpath.org).

> Status: KesherAI is applying to SignPath Foundation. Until it is approved, the Windows installer is not signed, and Windows may warn about it or, with Smart App Control on, block it.

## What is signed

Only KesherAI's own files, built from this repository by the [Release workflow](../.github/workflows/release.yml) on GitHub Actions: the app (`KesherAI.exe` and its files) and the installer (`KesherAI-Setup-<version>.exe`). Engines and models that KesherAI downloads later at your request (llama.cpp, whisper.cpp, stable-diffusion.cpp, sherpa-onnx, model files) are other projects' files and are not signed by us.

Every signed file has the product name **KesherAI** and the version of that release.

## Team

| Role | Who |
| --- | --- |
| Authors (change the source without further review) | [Roee Tal (@Deadchu-R)](https://github.com/Deadchu-R) |
| Reviewers (review changes from other people, such as pull requests) | [Roee Tal (@Deadchu-R)](https://github.com/Deadchu-R) |
| Approvers (approve each signing request) | [Roee Tal (@Deadchu-R)](https://github.com/Deadchu-R) |

Some of the code is written with AI coding assistants; every release is approved for signing by an approver. All team members use multi-factor authentication on GitHub and SignPath.

## Privacy

KesherAI runs on your computer and does not send information to other networked systems unless you ask it to. The exceptions, each one something you start or turn on:

- **Updates:** the installed app checks this repository's GitHub releases for a new version every few hours and downloads it (set `KESHER_NO_AUTO_UPDATE=1` to turn this off).
- **Downloads** of engines and models happen when you press a download button (from GitHub, Hugging Face or npm).
- **Cloud models** (OpenAI, Anthropic, Google, Groq and others) get what you send them, only when you choose such a model and add your own key.
- **Google Drive sync** copies your library to a KesherAI folder in your own Drive, only after you sign in with Google.
- **Remote access** (phone, Tailscale, the Cloudflare tunnel) is off until you turn it on, and needs your access token.
- **Web search and the browser extension** reach the sites you or the agent open while you use them.

Nothing is sent to the KesherAI project itself: there is no telemetry and no account with us.

## Uninstalling

Windows: Settings → Apps → KesherAI → Uninstall. Your data stays in `%USERPROFILE%\.kesher` until you delete it.
