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

### Microsoft TokenEconomizer (coding-agent cost) — asked by Roee
Sources: [EveryDev summary](https://www.everydev.ai/tools/tokeneconomizer), [explainx breakdown](https://explainx.ai/blog/microsoft-tokeneconomizer-coding-agent-cost-control-plugin-claude-code-codex-copilot-2026), repo [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) (the MarkTechPost page Roee sent would not load here).
- A plugin for Claude Code, Codex, Copilot CLI and Pi. It learns from finished sessions in one repo and changes what later sessions get; the model and agent stay as they are. Its data stays local (`~/.tokeneconomizer`).
- **Micro-skills** (off by default): repo facts that sessions keep finding by failing (e.g. `python -m pytest` works, `pytest` does not). A fact is added at session start only after 3 sessions confirm it and is dropped when a later one contradicts it. The `envfacts` mode learns from failures alone, with no model calls.
- **Tool pruning** (on): a tool unused in 10 prompts across 2+ sessions, or in 5 sessions, is left out of later sessions (restore command; the deny list is written only after 60 idle minutes so the prompt cache is not broken mid-work).
- **Loop guard** (on): a turn repeating the same failing edit-and-test is checked by a judge model, and a redirect is sent at most once per turn (at 70%+ confidence). It never stops the turn itself, and it waits for 5 normal turns in the repo first.
- **Results** (authors' harness, not yet replicated): SWE-Bench 277 tasks, 18.4–30.9% cheaper, pass@1 up in 4 of 5. Web-Bench 16–21%. Smaller savings when every task is a fresh repo.
- **What KesherAI already has:** a loop guard on repeated identical changing actions (agent/session.ts); tools loaded on demand (`find_tools`) instead of all at once; known engine issues injected before builds (known-issues.ts); self-work's handoff.md.
- **What to learn (added to VISION):**
  1. **Project facts learned from failures**, per workspace: after the same command fails the same way and a fix works in 2–3 chats, tell every new chat or self-work run about it at the start (and drop it when contradicted). This matters most for local models with a 24K-token context, which cannot afford to rediscover things.
  2. **Tool pruning per project**: the always-on tool list (MCP servers included) is a big part of every request to a local model. Leave out tools a project never uses, with a visible list and a restore button.
  3. **Failure-loop guard on checks**: the same check failing the same way after edits (self-work's check, check_code) triggers one redirect note ("step back, read the error, try another approach"), never a stop. Today's guard counts identical actions only.
  4. **Measure it**: chat-stats already counts waste; show tokens per finished item in self-work.

### TokenEconomizer internals (for KesherAI's "project facts")
- From the repo (`tokeneconomizer/microskills/README.md`, `docs/PLUGIN.md`): each finished session goes through *observe → propose → keep or retire*.
  - **Observe:** shell commands are split into segments and classified by intent (tests, interpreter, build/check, package tool, fetch, VCS probe) and by form (the exact spelling); the outcome is an error class or "tests ran".
  - **The five fact families with no model call:** *form repair* (a failing spelling followed by a working one: `pytest` → `python -m pytest`), *boundary* (every fetch to a host is refused), *empty probe* (VCS probes that always return nothing), *arg repair* (a test label that works once rewritten), and *env value* (a missing variable a later run sets).
  - **Lifecycle:** active after 3 confirming sessions; retired on contradiction (2 in a row for a spelling fact); injected only while the failure it prevents still shows up in at least 40% of the sessions that touch it (over 4 or more).
  - **Caps:** 4 facts and about 150 tokens; a lint refuses facts that read like "you are done" or verification advice.
- **Security note they make:** the facts come from command output, which the repository controls, so the free layer only fills fixed templates with the observed command forms and hosts. Free text from a model is riskier (prompt injection). KesherAI should do the same: templated facts only, shown in a list the user can remove from.
- **Loop guard:** rules first (the same edits and failures repeated, a turn 2.5× its usual length), a judge model only when unsure, one redirect per turn, never a stop.

### LobeHub agent format
- [lobe-chat-agents](https://github.com/lobehub/lobe-chat-agents) `agent-template-full.json` (schema `schema/lobeAgentSchema_v1.json`): `{ identifier, author, homepage, locale, meta: { title, description, avatar (emoji or URL), tags[] }, config: { systemRole, model, params: { temperature, top_p, frequency_penalty, presence_penalty }, displayMode, enableHistoryCount, historyCount, inputTemplate ("{{text}}" is the user's input) } }`.
- Mapping: `meta.title/description/avatar/tags` → persona name, description, icon, tags; `config.systemRole` → persona instructions; `params` → model settings; `historyCount` → how many past messages it keeps; `inputTemplate` → a prompt template (KesherAI prompts.ts).

### Token and speed optimizations for agents (asked by Roee: for Claude and for KesherAI)
Sources: [Pinggy: 8 tools](https://pinggy.io/blog/tools_to_reduce_ai_coding_agent_token_usage/), [Token reduction is not cost reduction (2,848 billed runs)](https://codex.danielvaughan.com/2026/07/28/token-reduction-is-not-cost-reduction-prompt-cache-economics-codex-cli-tool-output-compaction-billing/), [SWE-Pruner, Pichay, ContextBudget](https://codex.danielvaughan.com/2026/06/17/context-pruning-research-swe-pruner-pichay-contextbudget-codex-cli-token-management-compaction/), [rtk](https://mintlify.com/rtk-ai/rtk/introduction), [Serena](https://glama.ai/mcp/servers/oraios/serena).
- **The cache matters more than the token count.** In billed runs, cache writes (~44%) and reads (~35%) were most of the cost; tool output was a small share. Compressing tool output changed the prompt's prefix, broke the cache and patch anchors (applied patches fell from 27/40 to 15/40), and *raised* cost: RTK about −2.7%, RTK-ML +6.8%, Headroom +48%. Advice: keep the system prompt, the tool list and project notes fixed during a session; compact late (85–90% of the window), not often; measure cost per finished task.
- **Semantic tool selection:** embed the tool descriptions and send only the top-k for each request. In an AWS-documented test, tool text fell 82% (1,557 → 275 tokens) and wrong-tool picks fell 89%.
- **Goal-aware pruning** (SWE-Pruner, a 0.6B skimmer that keeps the lines relevant to a stated goal): 23–54% fewer tokens with the same solve rate. **Pichay** (OS-style paging of stale tool results): 21.8% of input was structural waste.
- **Code graph and symbol tools** (Serena with language servers; Graphify with tree-sitter): ask for one symbol instead of reading whole files.
- **Terse output** (Caveman skill): about 65% fewer output tokens. Output is slow on local models, so this matters most there.
- **Routing:** cheap models for simple tool calls, strong ones for reasoning (LiteLLM-style rules).
- **For KesherAI (local llama.cpp), the cost is time and context, not money:**
  1. **A stable prefix** lets llama.cpp reuse its slot cache instead of processing 20K tokens again every turn. Nothing dynamic should go before the conversation (time, changing tool lists), and a conversation should stay on one slot. Check what KesherAI sends today and measure prompt-processing time per turn.
  2. **Semantic tool selection** with the Qwen3 Embedding model KesherAI already runs: top-k tools per request for local models, with find_tools as the fallback.
  3. **Code symbols through the language servers** KesherAI already has (csharp-ls; add TypeScript/clangd): "show symbol X" tools instead of whole-file reads.
  4. **Terse mode** for local models (shorter answers, faster), and a "cost per finished item" counter in self-work.
- **For Claude (this session):** it runs in Anthropic's cloud, so nothing can be installed into it; what applies is working practice (narrow reads, filtered command output, no repeated reads, one stable plan). On Roee's own Claude Code: TokenEconomizer (above), and Serena as an MCP server for symbol-level reading; rtk is optional (small gain, can break the cache).

### Open WebUI workspace models (agents)
- [Workspace models](https://docs.openwebui.com/features/workspace/models.md): a wrapper around a base model with a system prompt (variables like `{{USER_NAME}}`), parameters (temperature, stop…), bindings (knowledge, tools, skills, filters, actions), capabilities (vision, web search, code interpreter) and meta (name, id, avatar, description, tags, prompt suggestions). Export is one `.json` holding every model you can edit; import stops at the first id that is taken and that you cannot edit.
- Mapping: system prompt → persona instructions (variables → KesherAI's own); params → model settings; base model → the model if it is local, else ask; knowledge bindings → a knowledge base of the same name if there is one (else listed as "to set up"); capabilities → tools on/off; prompt suggestions → the persona's starter prompts.

### Jan and AnythingLLM
- **Jan** ([data folder](https://www.mintlify.com/janhq/jan/desktop/data-folder)): `models/<provider>/<model>/` (the `.gguf` + `model.json`), `threads/<id>/thread.json` (title, model, assistants) + `messages.jsonl` (one `{role, content}` per line), `assistants/<id>.json` (name, instructions, temperature…), `settings.json`, `extensions/mcp/servers.json` (`command`, `args`, `env`, `enabled`). Everything is plain files, easy to import: chats, assistants → personas, MCP servers, and models in place (add `models/` to the model scan).
- **AnythingLLM** ([guide](https://betterstack.com/community/guides/ai/anythingllm-local-llm/)): a workspace holds chats, documents and settings, and documents are indexed in an embedded LanceDB. There's a REST API (create workspaces, upload documents); export and file layout aren't documented in what was read. Lower priority: import its documents folder as a knowledge base rather than its vectors.

### Design: KesherAI "project facts" (from TokenEconomizer's envfacts, Cursor and Windsurf memories)
- **How others do it:** Cursor has a side model that pulls memories out of chats, scoped to the project and managed in Settings → Rules ([docs](https://docs.cursor.com/context/memories)). Windsurf creates memories automatically and lists them for the user to delete. TokenEconomizer uses templated facts from repeated failures only, with no model calls (`envfacts.py`): FormRepair, Boundary, EmptyProbe, ArgRepair, EnvValue, AbsentTool, each with its own retire rule.
- **KesherAI v1 (templated, no model calls, per workspace):**
  - **Families, Windows first:**
    - *form repair*: a command form fails with an infrastructure error and a later form with the same intent works (e.g. `python` → `py -3`, `pytest` → `python -m pytest`, `npm test` → `pnpm test`);
    - *shell syntax*: PowerShell rejects `&&`/`export`, and the cmd form works;
    - *absent tool*: command not found and nothing else worked;
    - *env value*: a missing variable that a later run sets.
  - **Source:** run_command/check_code results in chats with a workspace and in self-work runs (events already store the command, its output and ok/failed).
  - **Lifecycle:** active after 3 different chats confirm it; retired on contradiction (2 in a row for a form); at most 4 facts and about 150 tokens.
  - **Text:** fixed templates filled with the observed command forms only, never model text (repository output can carry prompt injection).
  - **Where:** KesherAI's data folder (`project-facts/<workspace hash>.json`), not the repo.
  - **Shown:** on the project page (phone too), each fact with "remove" and how many chats proved it.
  - **Injected:** at the start of the system part (it changes only between chats, so it doesn't break llama.cpp's cache mid-chat), and into self-work's handoff.


- Project facts: design written (above). Next: read `lifecycle.py` for the exact retire and firing-gate code; then implement v1 (the form-repair family first, with tests built from real Windows failures).
- Importer: LM Studio presets still unread; then write the importer's design.
- UX at 390 px (checked on the PC 2026-11-10): Settings → Active models showed a model that is not in the list as its whole path, cut from the start; it now shows the file name. On the Unity page, the downloads button covered the Add button of the first project found; on the phone it now shows only while something downloads or failed.

### LM Studio presets
- [Presets](https://lmstudio.ai/docs/app/presets.md): one JSON file per preset in `%USERPROFILE%\.lmstudio\config-presets` (Windows) or `~/.lmstudio/config-presets`. A preset holds a system prompt plus any inference setting from the sidebar; load settings (GPU layers, context) are not in the new format. The docs don't list the exact keys, so they should be read from a real file on the PC (Roee has `.lmstudio`) before the importer is written. Legacy 0.2.x presets still load. Import from a file or URL exists since 0.3.15.
- Mapping: system prompt → persona instructions; sampling settings → the persona's model settings.
- **Real file read on the PC** (`config-presets/short no reason.preset.json`): `{ identifier: "@local:short-no-reason", name, changed, operation: { fields: [ { key: "llm.prediction.systemPrompt", value } ] }, load: { fields: [] } }`. Every setting is a `{ key, value }` pair: prediction keys (`llm.prediction.systemPrompt`, `llm.prediction.temperature`, `…topPSampling`, `…stopStrings`…) under `operation`, load keys (`llm.load.contextLength`…) under `load`. Roee has 2 presets ("Short Answers with code fixing", "short no reason").
- Mapping: `name` → persona name; `llm.prediction.systemPrompt` → instructions; other `llm.prediction.*` keys → persona params; `llm.load.contextLength` → noted, not applied (KesherAI's engine manages context).

### Design: "Import from other apps" (one screen)
- **Where:** Settings → "Import", next to the existing chat import (ImportChats.tsx, `/api/import/chats`, which already reads ChatGPT/Claude/Gemini). Computer only for reading other apps' folders (local paths); the phone can import a file it uploads (the JSON exports).
- **Steps:**
  1. **Find:** KesherAI looks for the apps' folders on this computer (LM Studio `.lmstudio/config-presets`, Ollama models/Modelfiles via its API or manifests, Jan's data folder, Open WebUI/LobeHub/AnythingLLM by an exported file, Claude Desktop/Cursor/VS Code MCP configs) and shows what each has: N personas/agents, N chats, N MCP servers, N models.
  2. **Preview:** per item, its name, what it becomes in KesherAI (persona, chat, MCP server, model in place), and conflicts (a persona of the same name → "keep both" / "replace" / "skip"; never overwrite silently).
  3. **Import** what is ticked; a summary with links; the source files are only read.
- **Persona gaps found:** KesherAI personas hold name, icon, instructions, model, knowledge. Imports also bring sampling settings (temperature, top_p, stop, context), starter prompts and example turns (Modelfile MESSAGE). Add `params` and `starters` to Persona first (both small), then the importer.
- **Security:** MCP servers from another app's config are shown with their command and arguments and are added **off** (the user turns each on), since a config file can name any program. API keys found in configs are not imported unless the user ticks them.
- **Order to build:** (1) Persona `params` + `starters`; (2) MCP import from Claude Desktop/Cursor/VS Code/Jan (high value, simple JSON); (3) Ollama Modelfile and LM Studio presets → personas; (4) Jan threads → chats; (5) Open WebUI and LobeHub exported files → personas/chats.

### AnythingLLM storage (for the last importer step)
- [Storage](https://docs.anythingllm.com/installation-desktop/storage): `%APPDATA%\anythingllm-desktop\storage` holds `documents/` (the parsed text of every uploaded file, as JSON), `lancedb/` (its vectors), `vector-cache/`, `models/` (GGUF files: add it to the model scan), `anythingllm.db` (SQLite: workspaces, chats, system prompts), `plugins/` and `direct-uploads/`.
- Plan: add `storage/models` to the model scan (models used in place); offer `storage/documents` as a knowledge-base folder (KesherAI indexes it with its own embedding model, not AnythingLLM's vectors); workspaces' system prompts and chats need reading SQLite (`workspaces.openAiPrompt`, `workspace_chats`), so that waits for a SQLite reader (Node 22.5+ has `node:sqlite`).

### Measured: how much of a local model's window KesherAI's fixed part takes
- **Tool descriptions:** KesherAI already sends local models only the core tools in full and the rest by name (`find_tools`). The 18 code tools alone are ~8.5K characters (≈2.4K tokens); the largest are build_executable (828), run_command (691), install_tool (582), read_document (578) and edit_file (570).
- **The whole fixed part** (system prompt + tools) of self-work's first request on the PC was ~5.8K tokens (the engine's log: 2,048 tokens = 35% of the prompt), about 26% of a 22K window.
- **What actually broke the window was tool *output***, not descriptions: a single read of a big file. That's fixed in 0.6.48 (one output at most a quarter of the window).
- **Semantic tool selection** (top-k core tools by the request's meaning) could save another ~1.5–2.5K tokens per request, about 10% of the window. It's worth doing after the output cap is proven on the PC, and it must keep the tool list fixed within a chat (llama.cpp's cache).

### Long agent runs with small local models (Aider, OpenHands, SWE-agent)
- **Masking old tool outputs works as well as summarizing them** ([The Complexity Trap, NeurIPS 2025](https://arxiv.org/abs/2508.21433)): on SWE-bench Verified, replacing old observations with a placeholder halved cost and matched (sometimes beat) LLM summarization; a hybrid saved another 7%. KesherAI already shortens older outputs inside a run (0.6.48), which is the same idea, with no extra model call. Summarizing would cost a local model a whole extra turn, so masking stays the method.
- **OpenHands' condenser** ([docs](https://docs.openhands.dev/sdk/guides/context-condenser)): keeps the first events (system + task) word for word, keeps the latest ones, and summarizes the middle once the history passes a size; about 2× cheaper per turn. KesherAI's equivalent: keep the task and the latest turns, shorten the middle.
- **Budget for 16K/32K windows** ([llmconfigurator](https://llmconfigurator.com/en/guides/coding-agents/context-engineering-local-coding-agents)): harness + tools ≤4K at 16K and ≤8K at 32K; 2–3 working files at 16K; reply reserve 2–3K; **trim when the window is half to two-thirds full, not near the limit** ("context rot" lowers quality before it is full). KesherAI: ~5.8K fixed at 22K is inside that; but it fits to 90% of the slot, which is near the limit.
- **KV cache at 8 bits** roughly halves its memory: often the difference between 16K and 32K on the same card. llama-server: `--cache-type-k q8_0 --cache-type-v q8_0` (the V cache needs flash attention, which recent builds turn on automatically).
- **Aider's edit formats** ([docs](https://aider.chat/docs/llms/editing-format.html)): "whole" (rewrite the file) is the easiest for weak models but costs tokens; diff formats need a model that handles them. KesherAI's edit_file (find/replace) is a diff format; write_file is "whole".
- **What KesherAI can take:**
  1. ~~q8 KV cache~~: **already on** (`serverArgs` adds `--cache-type-k/v q8_0` and `-c 32768 + 16384` per extra chat). The window each chat gets is the total divided by the chats at once (2 → 24.5K each). Open question: whether one chat (self-work alone) should get the whole 49K. That needs llama.cpp's unified KV (`--kv-unified`), to be checked against the build on the PC.
  2. **A softer target for local models:** trim older outputs once the history passes ~65% of the slot, not 90%.
  3. For a small file that edit_file failed on twice, point the model at write_file (whole), Aider's fallback for weak models. Learnable as a project fact.
  4. Exploration (searching, reading many files) in a separate short session that returns only a summary: later, with self-work.

### Git inside a code agent (Claude Code Desktop, Kilo, OpenCode)
- **Claude Code Desktop** ([docs](https://code.claude.com/docs/en/desktop)): a "Changes" card with `+12 -1` counts opens the diff, file by file. Hovering a line → "+" → a comment; several comments are sent together and the agent answers with a new diff. No commit button: you ask in chat. "Create PR" pushes and runs `gh pr create` (needs `gh` signed in). The PR then shows in the card with its CI checks; from a menu: auto-fix failing checks, merge when ready. Worktree per session (branch prefix set in settings); a warning before archiving with uncommitted changes.
- **Kilo** ([docs](https://kilo.ai/docs/desktop/features/git)): a Changes tab (uncommitted work vs the last commit, live, each file with status and counts; unified/split; a file tree that jumps). One main button that offers the next step (Commit → Push → Create PR). Commit stages everything, with a **one-line message written by the chat's model in the style of the repo's recent commits**. Branch switcher (default, recent, others; search; a remote branch → local tracking branch). A failed push shows git's full output and **"Fix in chat"** puts the error into the chat draft. PR: title and description by the model, PR template filled in, opened as a draft.
- **Limits that hold for KesherAI too:** Anthropic forbids using a Claude Pro/Max subscription's sign-in in other apps (Feb 2026: [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)). Claude inside KesherAI therefore needs an API key, paid per use. Push and PRs use the git and `gh` sign-in that is already on the computer; KesherAI never asks for passwords.
- **Design for KesherAI (code page, computer and phone):**
  1. **Changes:** a card in the chat with `+N −M` and the number of files, opening a diff per file (split on the computer, unified on the phone). It updates as the agent edits. A comment on a line goes to the chat as "in file:line — …".
  2. **One next-step button:** Commit (message written by the model from the diff and the repo's last 10 commits, editable before saving) → Push → (if the repo uses PRs) Create PR. Push always asks first, whatever the permission mode.
  3. **Branch:** the current branch and how far ahead or behind it is, a switcher, and a new branch from the current one.
  4. **After a push:** the GitHub Actions run of that commit (`gh run list --commit`), with its status live; on a failure, "Fix in chat" brings the failing step's log into the chat.
  5. **A failed git command** → its full output and "Fix in chat".
  6. **Project actions** (later): buttons the project defines, e.g. "release" = bump the version, commit, push main + release, which is KesherAI's own flow.
- **Order to build:** (a) a guard: write_file may not replace a large existing file that wasn't read in full (the t5 failure); (b) API: status, diff, commit, push, branches, run status; (c) the Changes card + diff + button; (d) line comments and "Fix in chat"; (e) project actions.

### Gemini CLI inside KesherAI's own chat (ACP, like Zed and JetBrains)
- **What exists:** `gemini --acp` (Gemini CLI's own flag; `--experimental-acp` is the old name) runs Gemini CLI as an ACP agent over stdio JSON-RPC (`@agentclientprotocol/sdk`, v1 stable; read from the SDK's schema and Gemini CLI's `packages/cli/src/acp/`). Zed (with Google) and JetBrains (ACP registry) host it this way.
- **Sign-in stays in Gemini CLI:** `initialize` returns its sign-in methods (`Log in with Google`, Gemini API key, Vertex AI, a gateway). `authenticate { methodId }` makes Gemini CLI itself reuse its saved sign-in or open the browser on the computer. KesherAI never sees a token, which is the line Google draws (the bans were for apps that took the subscription's tokens). Small risk: Google has not said anything about third-party ACP clients other than Zed and JetBrains. Zed and JetBrains do exactly this, so the risk is low.
- **The protocol, the parts KesherAI needs:**
  - KesherAI → agent: `initialize`, `authenticate`, `session/new { cwd, mcpServers }`, `session/load` (Gemini CLI supports it: a chat can be reopened), `session/prompt { prompt: ContentBlock[] }` → `{ stopReason }`, and `session/cancel`.
  - Agent → KesherAI (notifications) `session/update`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call` / `tool_call_update` (title, kind, status, content with `type: "diff"`, locations), `plan`, `available_commands_update`, `current_mode_update`.
  - Agent → KesherAI (requests): `session/request_permission { toolCall, options: [{ optionId, name, kind: allow_once | allow_always | reject_once | reject_always }] }`; `fs/read_text_file` and `fs/write_text_file` when KesherAI advertises `fs` (Gemini CLI then writes through KesherAI, so its checkpoints and diffs work); `terminal/*` when advertised.
- **Design for KesherAI:**
  1. A code chat can use **Gemini CLI as its engine** (model picker: "Gemini CLI, with your Google sign-in"), next to KesherAI's own agent.
  2. Core spawns `gemini --acp` in the project folder (found like the terminal buttons find it) and maps ACP to KesherAI's events: message chunks → assistant text; thoughts → the thinking line; tool calls → the same tool cards with diffs; `request_permission` → KesherAI's approval card (so the phone can approve too); `plan` → the plan card.
  3. Advertise `fs` read/write so edits go through KesherAI (checkpoints, the Changes tab); `terminal` later.
  4. Sign-in: the first time, a card says "Gemini CLI opens Google sign-in on the computer" and calls `authenticate` with Log in with Google; nothing is typed in KesherAI.
  5. Reopening the chat uses `session/load`; stopping uses `session/cancel`.
  6. A small JSON-RPC client of our own, or the official SDK as a dependency (Apache-2.0). Ask Roee before adding the dependency.
- **Order to build:** (a) the ACP client in core with tests against a fake agent; (b) the "Gemini CLI" engine for code chats; (c) approval cards and diffs; (d) phone check at 390 px; (e) later, the same for other ACP agents (Codex CLI and others), each with its own sign-in.

### Thinking in local agents (Qwen3.6/3.8) and a newer model
- **Qwen3.8-27B exists** (Qwen, 2026-08-05; unsloth GGUF 2026-08-13; ~7.4M downloads). It is the same size and architecture as Qwen3.6-27B (64 layers, attention in 16; 262K context). Its card claims a big step up for agents: SWE-bench Pro 61.7 vs 53.5, Terminal Bench 2.1 73.0 vs 63.4, DeepSWE 42.2 vs 13.3, QwenSWEBench 79.0 vs 49.3. These are vendor numbers. The guides I used for picking (InsiderLLM, Kilo, updated in August) did not have it yet. Lesson: check Hugging Face itself for the newest version of a model family before picking. UD-Q4_K_XL is 17.6 GB, the same as 3.6. Download started 2026-11-10.
- **Its sampling** (card): thinking mode temperature 1.0, top-p 0.95, top-k 20, min-p 0; non-thinking 0.7/0.8/20 with presence penalty 1.5. Added to the engine's defaults.
- **Thinking depth:** Qwen3.8 has `reasoning_effort` (`low`, `medium`, `xhigh`; the default is xhigh) and `preserve_thinking` (on by default: earlier reasoning stays in the history, so every prompt grows). llama-server takes `--reasoning-effort` / `--reasoning-budget N` (0 = off, -1 = no cap) / `--chat-template-kwargs '{"enable_thinking":false}'` as server defaults, and per request `reasoning_effort` and `chat_template_kwargs` on `/v1/chat/completions` ([SSD Nodes, 2026-10](https://www.ssdnodes.com/learn/reasoning-effort-settings-local-llm)).
- **For agents:** keep effort low on the many small steps and raise it for planning and multi-file edits. Pay attention to preserve_thinking, because the history grows with every step. A community template for Qwen3.6 in llama.cpp reports 26–73× longer reasoning in JSON tool mode, and recommends XML tool calls, which are the default ([template](https://huggingface.co/Moore2877/Qwen-Agentic-Chat-Template-llamacpp)).
- **What KesherAI can take (measure first, on the CoolDown run):**
  1. Count thinking tokens per step from the engine's timings.
  2. Send `reasoning_effort: "medium"` on agent steps, and `xhigh` only for the plan step and after a failed check.
  3. Maybe turn `preserve_thinking` off for long self-work runs, so the history does not grow with old reasoning.
  4. Check that the build on the PC (b12110) accepts `--reasoning-effort` before adding it as a server flag. A per-request field is safer, because an unknown field is ignored.

### Why each self-work step took about a minute (prompt cache with hybrid models)
- **Measured on the PC** (Qwen3.6-27B, self-work): one step re-read 6,345 tokens of prompt at 120 tok/s, which is 53 s before it wrote a word; the next step re-read 360 tokens (4 s).
- **Cause 1 (KesherAI):** older tool outputs were shortened with a line that moved one message every turn, so the conversation changed a little higher up on every step. llama.cpp keeps its cache only up to the first difference. **Fixed:** no shortening while the conversation uses less than half the window, and then the line moves 8 messages at a time.
- **Cause 2 (llama.cpp, hybrid models):** Qwen3.5–3.8 have recurrent layers (Gated DeltaNet). Their state cannot be rolled back, so the server can resume only from a saved *context checkpoint* (`--ctx-checkpoints`, 32 per chat by default). It saves one at the last user message and near the end of each prompt, with at least `--checkpoint-min-step` tokens between them (8,192 by default). After a change in the middle, it goes back to the nearest checkpoint, which can be up to 8K tokens back (tools/server/server-context.cpp, common/common.h).
- **b12110 (the PC's build) has it**, along with `--ctx-checkpoints`, `--reasoning-effort`, `--reasoning-budget`, `--fit-ctx` and `--spec-type` (read from the b12110 tag's common/arg.cpp). **Added:** `--checkpoint-min-step 1024` for hybrid models on b12000+. Each checkpoint is the recurrent state of 48 layers (my estimate: about 150 MB of system memory each, up to 32 per chat). Measure RAM and seconds per step on the PC.
- **Speculative decoding with MTP** (`--spec-type draft-mtp`, in b12110): Qwen3.6/3.8 are trained with MTP, but the GGUF must contain the MTP (NextN) tensors. unsloth has a separate `Qwen3.6-27B-MTP-GGUF`, and there is none for 3.8 yet (only community fine-tunes, not to be trusted). Next: check whether the 3.8 file we have includes NextN tensors (llama-server's load log), and wait for an official MTP GGUF.

### What the competitors added lately (Aug–Nov 2026) and what KesherAI takes
- **Ollama 0.40.x** ([releases](https://releasebot.io/updates/ollama)): `ollama launch claude|opencode|kimi` starts another agent's CLI on Ollama's models (Claude Code through Ollama's Anthropic-compatible API, [docs](https://docs.ollama.com/integrations/claude-code): ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, a 64K+ context, a model with tools). Also concurrent requests for recurrent (hybrid) models, speech, "decision" models.
- **Bionic 1.1–1.2** ([changelog](https://lmstudio.ai/changelog)): an in-app terminal with shell profiles; MTP and speculative decoding; an "MoE expert GPU cache" for llama.cpp; on-demand MCP tool discovery to save context; more reliable compaction; Canvas (a board both edit); the agent reading its own earlier sessions; tool-call argument streaming.
- **Conclusions for KesherAI:**
  1. **Built: "Claude Code on the local model".** KesherAI already had `/v1/messages` (Anthropic-compatible), so the terminal button starts `claude` with ANTHROPIC_BASE_URL set to KesherAI. No Anthropic account or key is used, and any model name goes to the active chat model. This gives Roee the same harness I work in, with free local Qwen. It needs 64K+, which is fine with Qwen3.8's 77K per chat.
  2. Already in KesherAI: on-demand tool discovery (find_tools), compaction, an in-app terminal.
  3. Worth doing: MTP when an official GGUF is out; "MoE expert GPU cache" for MoE models (Qwen3.6-35B-A3B, Coder-Next) when offloading; the agent reading its own earlier sessions (like Bionic's Introspection), which fits self-work handoffs.
  4. An `ollama launch`-style list (OpenCode, Codex, Kimi CLI) on the same idea, each pointed at KesherAI's /v1.

### OpenCode 2 and Cline Desktop (Sep–Oct 2026)
- **OpenCode 2.0** (2026-10-12, [Tech Insider](https://tech-insider.org/opencode-2-0-background-service-launch-2026/)): a local background service now owns sessions, plugins, permissions and tools; the terminal, web and desktop clients share them; background subagents and shell commands; an SDK (`@opencode/sdk`). KesherAI is built this way already (the core server, with desktop, phone and web as clients, and self-work in its own worker).
- **Cline Desktop** (2026-09, [AIToolly](https://aitoolly.com/ai-news/article/2026-09-12-cline-desktop-app-launches-as-an-open-source-multi-agent-workspace-optimized-for-open-weight-models), [RuntimeWire](https://runtimewire.com/article/cline-launches-desktop-coding-agent-open-weight-models)): several agent threads in the background, follow-up queues, forking, rolling back to checkpoints (KesherAI has all of these); **scheduled recurring workflows**; **import of Claude Code and Codex sessions "to continue when those tools hit limits"**; a harness tuned for open-weight models (structured tool calls, scratchpads).
- **Conclusions for KesherAI:**
  1. **Import Claude Code (and Codex) sessions** (`~/.claude/projects/<project>/*.jsonl`) into a code chat, so the local model continues where Claude stopped. This is exactly the CoolDown case. It sits next to the existing chat import.
  2. **Scheduled self-work:** e.g. "every night at 01:00, run the open [CoolDown] tasks". KesherAI has no schedule for self-work yet.
  3. Already in KesherAI: one background service with several clients, queues, branching, checkpoints.

### LM Studio 0.4.x, and the engine's speed on the PC
- **LM Studio:** 0.4.26 (2026-10-13) moved to llama.cpp b11337, added Windows ARM CUDA 13, and lets LM Studio run alongside Bionic. 0.4.15 (2026-05-29) added **tensor parallelism** across cards and a "physical batch size" load option. Both matter for Roee's planned second 3090.
- **Measured on the PC during the CoolDown run** (Qwen3.6-27B dense, Q4, RTX 3090): writing 18 tok/s (40 when the model was alone with a 24.5K context), reading 80–120 tok/s. The card was 100% busy, at 25.1 of 25.8 GB, 210–340 W. A dense 27B Q4 on a 3090 should read many hundreds of tokens per second, so something is off. Likely causes: memory spilled to system RAM (the card was full after fit grew the context), or a slow path for the recurrent layers when reading prompts.
- **Next:** after the release with the 2 GB margin, load the model alone and record the load log ("offloaded N/N layers", buffer sizes), then read and write speeds. KesherAI should keep the load lines (they scroll out of the 60-line log) and show them on the Models page ("Engine memory, visible" in VISION).

### Design: continue a Claude Code session in KesherAI (the CoolDown handoff)
- **The format** (read from a real Claude Code session file, `~/.claude/projects/<folder-slug>/<session>.jsonl`): one JSON object per line. Lines with `type: "user"` / `"assistant"` carry `message: { role, content }`, where `content` is a string or blocks (`text`, `thinking`, `tool_use { id, name, input }`, `tool_result { tool_use_id, content, is_error }`). Each line also has `uuid` / `parentUuid` (the conversation is a tree: follow parents back from the last line), `isSidechain` (subagent work), `cwd`, `gitBranch` and `timestamp`. Other line types (`ai-title`, `summary`, `attachment`, `mode`, `queue-operation`, `system`…) are skipped, except `ai-title`, which gives the title.
- **Import:**
  1. Find the sessions on this computer by project (the folder from `cwd`), with title, date and size.
  2. Follow the chain back from the newest leaf and drop sidechains.
  3. Make a code chat in that folder (`cwd`), on the chosen local model.
  4. Keep the user's and Claude's text in full. Tool calls and results become one short line each ("ran: …", "edited: path"), so the history fits a local model.
  5. End with a note: "This continues a Claude Code session; read the last steps and go on".
- **Local only:** session files can hold secrets from commands. They are never read from the phone, and the import is shown first.
- **Also from Codex** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, [schema notes](https://lin-guanguo.github.io/llm-memory-research/agent-cli/codex-session-file-schema/)): each line is `{ timestamp, type, payload }`. `session_meta` comes first (`payload.cwd`). `response_item` lines hold `message` (role, content blocks `input_text` / `output_text`), `function_call` (name, arguments as a JSON string, call_id), `function_call_output` (call_id, output) and `reasoning` (encrypted: skipped). `turn_context` holds cwd. `compacted` is the summary history. The same mapping works: text kept, tool calls as one line each. Codex is not on Roee's PC (no `~/.codex`), so it can wait.

### Plan: a fair Qwen3.8 vs Qwen3.6 comparison on the PC
- **The same task, from the same commit:** one CoolDown task that has not been started (e.g. "Settings.tsx: StartupToggle and HttpsCard to their own files"). Each model gets its own self-work run, on its own branch, from the same main commit, with the same goal text, check and hours.
- **The same engine settings:** 0.6.55 (77K for self-work, prompt cache kept, checkpoints every 1,024 tokens, 2 GB margin). The model is loaded alone, and nothing else uses the card.
- **What is measured:**
  - minutes to "done";
  - turns and failures;
  - whether the check passed the first time;
  - read/write tokens per second from the engine's timings;
  - the size of the diff, and whether it does only what was asked (I review the diff);
  - for Qwen3.8, how much of each step is thinking.
- **Then:** the better model becomes the default for code chats and self-work. I ask Roee before deleting the other model's file (17.6 GB).

### Measured: Qwen3.8-27B on the PC after the fixes (0.6.57)
- With the model alone, on E: (NVMe), and a 2 GB margin: **writing 38.8 tok/s, reading a 13K prompt at 1,297 tok/s**, 68.6K context per chat (2 chats). During the earlier run, with the card full to 0.5 GB, it was 18 and 80–120. So the slowdown was memory spilling to system RAM, and the 2 GB margin fixed it. The C: drive was also full, so Windows could not grow its page file, which may have made it worse.
- The Qwen3.8 GGUF (unsloth UD-Q4_K_XL) **carries NextN (MTP) tensors** (`blk.64.nextn.*` in the load log). 0.6.58 turns on `--spec-type draft-mtp` for files whose header has `*.nextn_predict_layers > 0`. Next: measure the same two requests on 0.6.58 (writing speed, draft acceptance), and keep it only if it is faster.

### Where it stopped
- Qwen3.8 speed: baseline measured (above). Next: same requests on 0.6.58 with MTP.
- Qwen3.8 vs 3.6: plan written (above). Next: run it after 0.6.55 is installed and the current run ends.
- Engine speed on the PC: measured during the run (above). Next: load log + speeds after the 2 GB margin release.
- Competitors Aug–Nov 2026: Ollama, Bionic, OpenCode 2 and Cline Desktop read (above). Next: design scheduled self-work (Claude Code session import designed, below).
- Prompt cache with hybrid models: both sides done in code (above). Next: measure on the PC after the next release; MTP GGUF for 3.8 when one is out.
- Thinking in local agents: read (above). Next: measure thinking tokens per step on the CoolDown run, then try reasoning_effort per step; compare Qwen3.8 against Qwen3.6 on the same CoolDown task.
- Gemini CLI over ACP: protocol and Gemini CLI's side read, design written (above). Next: build (a)–(d) after the CoolDown test.
- Git inside the agent: researched and designed (above). Next: build in the order listed.
- Long local agent runs: read (above). Next: check `--kv-unified` in llama-server's `--help` on the PC (one chat could use the whole window); the 65% target after that.
- Project facts: **built** (0.6.43). Unity/Unreal error classes: Unity's build docs give no exact environment-error texts, and KesherAI's own Unreal build logs on the PC have no failures yet, so there is nothing real to learn from. Next: after a few weeks of chats on the PC, read `project-facts.json` and the failed commands, and add the classes that actually show up (no guessing).
- Importer: all formats are read except the exact LM Studio preset keys (read one real file from `.lmstudio/config-presets` on the PC). Importer: design written and every format read (LM Studio presets from a real file). Next: build in the order listed (Persona params + starters first).
- UX at 390 px (checked on the PC 2026-11-10): Settings → Active models showed a model that is not in the list as its whole path, cut from the start; it now shows the file name. On the Unity page, the downloads button covered the Add button of the first project found; on the phone it now shows only while something downloads or failed.
