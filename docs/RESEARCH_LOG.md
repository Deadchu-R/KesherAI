# Research log

Research done while nothing could run on the PC and no release could ship. Each entry: what was looked at, what was found, what it changed, and **where it stopped** (the next session starts there).

## 2026-11-10

### Running models without other apps (llama.cpp, Jan, LM Studio)
- **llama.cpp fitting** ([discussion #18049](https://github.com/ggml-org/llama.cpp/discussions/18049)): `--fit` is on by default and leaves 1 GB free per GPU (`-fitt`); it shrinks the context first, then moves tensors to system RAM, MoE experts first. Any explicit `-ngl`, `--tensor-split` or `--override-tensor` turns it off completely. An explicit `-c` is kept.
  - Changed: 0.6.41 drops KesherAI's old `-ngl 99` default on b7400+ builds (it froze self-work when two models shared the 3090), and the embedding engine no longer forces the GPU.
- **Jan** ([Managing models](https://docs.jan.ai/jan/manage-models)): imports a GGUF by link (symlink) or copy, chosen by hand; it does not find LM Studio or Ollama models by itself. KesherAI already finds them and uses them in place.
- **LM Studio**: keeps its own embedding model (nomic) in `.lmstudio/.internal/bundled-models`, not in `models/`. Changed: 0.6.40 looks there too.

### Import from other apps
- **LibreChat** ([Import conversations](https://www.librechat.ai/docs/features/import_convos)): ChatGPT and Claude `conversations.json`, ChatbotUI, LibreChat; the format is read from the content; limits 250 MiB per file, about 16 MB per chat. KesherAI already imports ChatGPT, Claude and Gemini chats.
  - Changed: VISION "Import from other apps" now lists what is still missing (agents, personas, presets, Ollama Modelfiles, Open WebUI/LobeHub agents, Jan assistants, AnythingLLM workspaces, MCP from Claude Desktop/Cursor/VS Code).

### UX check (phone 390 px, computer 1280 px)
- Knowledge page: the setup text always promised a 0.64 GB download, and the brackets around the model name flipped in Hebrew. Fixed: it names the model already on the computer ("no download") and keeps the name in its own LTR span.
- Models page on the phone: fine; the "Qwen3 4B" name wraps next to its speed chip (minor, left as is).

### Importer formats (continued)
- **Open WebUI** ([Import & Export](https://docs.openwebui.com/features/chat-conversations/data-controls/import-export.md)): chats export as a JSON array of `{ chat: { title, models, history: { currentId, messages: { id → { id, parentId, childrenIds, role, content, model, timestamp } } } }, meta.tags, pinned, archived, folder_id, created_at }`. Messages are a tree, like ChatGPT's `mapping` (which Open WebUI also reads). Its docs page covers chats only; agents/prompts export is not documented there.
- **Ollama Modelfile** ([reference](https://docs.ollama.com/modelfile.md)): `FROM` (model, GGUF or folder), `PARAMETER` (`num_ctx`, `temperature`, `top_k`, `top_p`, `min_p`, `repeat_penalty`, `repeat_last_n`, `seed`, `stop`, `num_predict`), `TEMPLATE`, `SYSTEM`, `MESSAGE` (example turns), `LICENSE`, `REQUIRES`, `CAPABILITY`. `ollama show --modelfile <name>` prints one; KesherAI already reads the manifests in `.ollama/models` to find the GGUF.
- **Draft mapping to KesherAI** (for the importer):

  | From | KesherAI |
  |---|---|
  | Modelfile `SYSTEM` + `MESSAGE` | a persona (instructions + example turns) |
  | Modelfile `PARAMETER temperature/top_p/num_ctx/stop` | the persona's model settings |
  | Modelfile `FROM` (a GGUF) | the model, used in place (model-scan) |
  | Open WebUI chat (`history.messages` tree, `currentId` branch) | a chat (same as the ChatGPT tree reader) |
  | Open WebUI `meta.tags`, `pinned`, `folder_id` | chat tags / pinned / project |

### Where it stopped
- Next: **LobeHub agent JSON**: read `agent-template-full.json` and `schema/` in [lobe-chat-agents](https://github.com/lobehub/lobe-chat-agents) (fields `identifier`, `meta`, `config.systemRole`…), then **Open WebUI models/agents** (its admin "Models" export), then **Jan assistants** and **AnythingLLM workspaces**.
- Next UX pages to look at, at 390 px: Unreal (C++ tab), Unity (Rider mode pill), Settings → Active models.
