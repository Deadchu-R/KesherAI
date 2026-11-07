# Legal notes for contributors and forks

This is not legal advice. It records the rules the project follows so contributors make the same choices. If you plan a commercial product or a large distribution, ask a lawyer who knows open-source licensing.

## KesherAI's own code

Licensed under [Apache-2.0](../LICENSE). Anyone may use, modify and redistribute it, including commercially, as long as they keep the licence and notices. Apache-2.0 includes a patent grant from contributors and a warranty disclaimer ("AS IS").

## Projects that inspired KesherAI

Ideas, workflows and interface concepts are not protected by copyright; code, icons, logos and artwork are. **Never copy code or assets from these projects into KesherAI** unless their licence allows it and you keep their notices.

| Project | Licence (check the current one before relying on this) | How KesherAI uses it |
| --- | --- | --- |
| ComfyUI | GPL-3.0 | Talks to a separately running ComfyUI over its HTTP API. KesherAI does not bundle or modify ComfyUI's code. A "managed ComfyUI" must download and install ComfyUI from its official source as a separate program, not ship its code inside KesherAI's installer. |
| LobeHub / LobeChat | LobeHub Community License (Apache-2.0 plus conditions; distributing a derivative of their code needs a commercial licence from LobeHub) | No code is taken from LobeHub. KesherAI can import skills and MCP servers listed on LobeHub — each of those has its own licence — and LobeHub can use KesherAI as an OpenAI-compatible provider. |
| OpenCode | MIT | Talks to `opencode serve` over HTTP. MIT code could be reused with its copyright notice kept, but none is today. |
| LM Studio | Proprietary | Talks to the local API LM Studio exposes for exactly this purpose. Nothing else. |
| Ollama, llama.cpp, whisper.cpp | MIT | Talked to as separate programs. |

## Names and trademarks

Saying KesherAI "works with LM Studio, ComfyUI and Ollama" is fine: it describes compatibility. Do not use other projects' logos as part of KesherAI's branding, and do not suggest they endorse KesherAI. Before the project settles on its final name, check that it is not a registered trademark for software.

## Models

**KesherAI does not distribute model weights.** Users download them from Hugging Face (or pull them with Ollama) themselves, and each model has its own licence that the user accepts — for example, FLUX.1 [dev] uses a non-commercial licence for the model, while Llama, Gemma and Qwen each have their own terms. Gated models require the user's own Hugging Face account and token. Rules for contributors:

- Never commit model weights to the repository or bundle them in installers.
- The downloader should show a model's licence before downloading (tracked on the roadmap).
- Preset "bundles" link to the official repos; they do not mirror files.

## Cloud APIs

Users bring their own API keys and are bound by each provider's terms. KesherAI sends keys only to the provider they belong to and never to any server of its own.

## Dependencies

Runtime dependencies must use licences compatible with Apache-2.0 distribution (MIT, BSD, ISC, Apache-2.0 and similar). Avoid adding GPL or AGPL libraries that would be linked into KesherAI. Bundling external programs (for example ffmpeg, which can be LGPL or GPL depending on the build) needs a check of that program's licence and its notice in the installer.

## Privacy

KesherAI collects no data. If telemetry or crash reporting is ever added, it must be opt-in and come with a privacy policy before release.

## Non-profit status

An open-source project does not need a legal entity. If the project later wants to accept donations or grants formally, it can form a non-profit or join an organisation that hosts open-source projects. Neither changes the licence obligations above.
