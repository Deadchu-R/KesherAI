# Gemini CLI

The rules for this repository are in [AGENTS.md](AGENTS.md); read it first and follow it.

@AGENTS.md

## Research rule (Roee, 25.11)
Every research of a new feature or addition includes a "Language and weight" part: for each part of it, the language or runtime that runs fastest and lightest on the PC (TypeScript, Rust via napi-rs or a sidecar, Go, C++, WebAssembly, GPU shaders), the expected gain, the cost (build, Windows, maintenance, how well coding agents write it), and what to measure first.
