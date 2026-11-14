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

### MoE expert cache in llama.cpp, and Qwen3.8-Flash-Next
- **`--moe-cache-mib N`** (llama.cpp PR #29887, 2026-10-07; multi-GPU a day later, [Developers Digest](https://www.developersdigest.tech/blog/llama-cpp-moe-offload-n-cpu-moe-vs-moe-cache-2026)): an LRU cache of MoE experts in VRAM, for models whose experts live in system RAM. Only cache misses cross PCIe. The author's numbers (Qwen3.8-Flash-Next): 1.6–2.2× faster writing than plain `--fit`. One RTX 3090 tester saw only 1–5% over a tuned `--n-cpu-moe`. It does nothing when the whole model fits in VRAM (Qwen3.8-27B today). Start at about 10% of the experts' size, and use it with `--fit` when every turn has long prompts (agents). The build on the PC (b12110) is older than the PR, so the engine needs an update first; check with `--help | grep moe-cache`.
- **Qwen3.8-Flash-Next** (MoE, ~177B total, ~4.9B active, 512 experts; llama.cpp support from 2026-08-27; [GGUF](https://huggingface.co/batiai/Qwen3.8-Flash-Next-GGUF)): IQ3_XXS 85 GB, IQ4_XS 97.5 GB, Q4_K_M 119 GB. On Roee's PC (24 GB VRAM + 96 GB RAM), IQ3_XXS fits with the experts in RAM; IQ4_XS is tight. The card has no coding benchmarks against Qwen3.8-27B. It is described as a preview of Qwen4.
- **What KesherAI can take:**
  1. When a MoE model does not fit the card, add `--moe-cache-mib` (about 10% of the experts' size, within the free VRAM) on builds that have it.
  2. Offer an engine update to a build with the cache.
  3. A future experiment, like DeepSeek V4-Flash: Qwen3.8-Flash-Next IQ3_XXS (85 GB), measured against 27B on the same CoolDown task. Ask Roee before downloading.

### Where it stopped
- MoE expert cache + Qwen3.8-Flash-Next: read (above). Next: engine update to a build with --moe-cache-mib; ask Roee about trying Flash-Next.
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

## 2026-11-10 — Gemini CLI → Antigravity CLI; MTP speed on the PC

**Finding that changes a plan:** since June 18, 2026 Google AI Pro and Ultra subscriptions no longer sign in to Gemini CLI (it kept paid API keys and business accounts; The Register, geminicli.com/docs/cli/acp-mode). Their CLI is now **Antigravity CLI (`agy`)**, a closed-source Go binary.
- Windows install: `irm https://antigravity.google/cli/install.ps1 | iex` → `%LOCALAPPDATA%\agy\bin\agy.exe`; update with `agy update` (how2shout, inventivehq).
- Official install page: personal Google sign-in works on Free, Pro and Ultra; also `GEMINI_API_KEY`, ADC, Enterprise.
- **`agy acp`** (v1.5.0, Nov 4) is an official ACP v1 stdio server: "Any ACP client can launch Antigravity CLI". It has flags `--add-dir`, `--agent`, `--sandbox`, `--process-per-session` and `--login` (paste code). Sessions can be loaded, resumed and listed; it shows a model picker per account and thinking levels Low to Max. v1.5.1 made all account models available to ACP clients; v1.5.4 (Nov 10) added Auto mode.
- Config lives in `~/.gemini/antigravity-cli/` (settings.json, mcp_config.json; remote servers use `serverUrl`). It reads AGENTS.md and GEMINI.md.
- **Done:** the terminal buttons are now Antigravity CLI (start, update, install on Windows; PATH gets its folder for a fresh install). The MCP import reads its mcp_config.json.
- **Next:** the ACP client in KesherAI should target `agy acp` (the official SDK is already approved), not `gemini --acp`. This is sanctioned, because Google documents third-party ACP clients and the sign-in stays inside agy.

**MTP on the PC** (Qwen3.8-27B UD-Q4_K_XL, b12110, `--spec-type draft-mtp` at llama.cpp's default draft length):
- 700-token CSV parser: 13.5s and 10.4s, about 52–67 tok/s, against 38.8 tok/s without MTP (≈1.5–1.7×).
- Cost: the slot fell from 68.6K to 45.5K tokens.
- Others' results: a 3090 at Q4_K_XL found `--spec-draft-n-max 2` best (+60% overall, +92% on code; hackmd thc1006). A 24 GB Blackwell run found n=8 best with NVFP4 (dev.to/pich). Each extra draft slot costs about 150 MiB.
- **Decision:** keep MTP on. Next, try `--spec-draft-n-max 2` to win back VRAM and context.

## 2026-11-10 (cont.) — Antigravity over ACP: may KesherAI host it?

- **Terms of use:** a Google AI forum thread from July 23, 2026 asked whether a single-user editor may run `agy` as a child process. The September 16 reply says that is compliant: the unmodified binary runs under the user's own login, and tokens are never extracted, stored or forwarded. Normal, prompt-driven turns only count against the user's quota and do not trigger abuse flags. The officially supported path is the "Antigravity ACP Server" (`agy acp`). Reading agy's local databases is allowed read-only, but their schema can change, so we will not depend on it. (The page does not say whether the person who answered works at Google.)
- **The ACP registry** lists Antigravity under Zed's ACP pages (`agy_acp_server.par`, a binary distribution); the CLI's own path is `agy acp`.
- **Design (updates the Gemini CLI plan above):**
  - (a) An ACP client in core, using `@agentclientprotocol/sdk` 2.5.0 (approved), tested against a fake agent.
  - (b) An "Antigravity" engine for code chats: spawn `agy acp --add-dir <project>`, with no token handling in KesherAI. `authenticate` uses agy's own methods, and `agy acp --login` covers the case with no browser.
  - (c) `session/request_permission` becomes KesherAI's approval card, so it also shows on the new 🔔 page and on the phone. Tool calls map to cards with diffs, and agent `plan` updates map to the plan card.
  - (d) Model picker from agy's session models; thinking level Low to Max.
  - (e) Check on the phone at 390 px.
- **Where this stopped:** the design is ready. Next is building (a) and (b) once 0.6.60 is installed and checked on the PC.
- **SDK 2.5.0, client side (read from the package):** `client().onRequest("session/request_permission", …).onNotification("session/update", …).connectWith(ndJsonStream(stdin, stdout), async (ctx) => …)`. The `ActiveSession` helper queues `session/update` notifications in the order they arrive. A `ClientApp` can connect directly to an in-process `AgentApp`, which gives tests a fake agent with no child process. The only peer dependency is `zod`, which is already in the repo. Terminals use a `TerminalHandle` (`release()` must be called).

## 2026-11-10 (cont.) — Antigravity's ACP modes
- The v1.5.0 notes (havoptic) list the session modes `default`, `accept-edits` and `plan`. A prompt sent mid-turn steers the turn; `session/resume` works without replaying; each session keeps its own model and thinking level; `agy acp --login` is for setups with no browser. Auto mode applies to commands that would leave the terminal sandbox; it is not an ACP mode.
- **Done:** before each turn, KesherAI's mode is mapped to Antigravity's: ask → default, auto-edit → accept-edits, plan → plan. Auto keeps Antigravity's own setting, because KesherAI never passes `--dangerously-skip-permissions`.
- **Next ideas:** a model and thinking-level picker from the session's config options; resume after a restart (`session/resume`); images in prompts.

## 2026-11-10 (cont.) — Tuning Qwen3.8 MTP on one 24 GB card (github.com/sudoingX/qwen38-mtp)
- A recommended start: `--spec-type draft-mtp --spec-draft-n-max 2 --parallel 1`. Results others reported (not verified): an RTX 4090 at UD-Q4_K_XL went from 44.7 to 84.9 tok/s at n-max 4 (acceptance 0.64, VRAM 21.8 → 23.8 GB). A 3090 at Q4_K_M went from 31.9 to 52.8 at n-max 4. The best n-max differs by card (2–4); 8 was the worst on most cards.
- **Two findings that matter to KesherAI:**
  1. **The MTP gain mostly disappears with several slots** (`--parallel 4`), and `--parallel 2` hides part of it. KesherAI's default is 2 chats at once, so for Qwen3.8 one chat at a time may be the faster choice. To measure on the PC: parallel 1 against 2, with the same n-max.
  2. **A q4_0 KV cache** (`--cache-type-k q4_0 --cache-type-v q4_0`) lets a 24 GB card reach 131K+ context with ~17 GB of weights; f16 was within 2% on some cards. KesherAI already uses q8_0 (llamacpp.ts). Going to q4_0 would roughly double the context, at some quality cost on long contexts. Next: an option for the KV cache type (q8_0 / q4_0), measured on the PC.
- Benchmark with the desktop off the card: a compositor that shares the GPU halved speed with no error.
- **Where this stopped:** when 0.6.62 is installed, measure n-max auto, 2 and 3 at parallel 2, then n-max 2 at parallel 1. Report tok/s and slot tokens.

**Measured on the PC (0.6.62, Qwen3.8-27B UD-Q4_K_XL, b12110; KesherAI's 200-token prose benchmark, two runs each):**

| chats at once | guesses ahead | tokens per chat | tok/s |
|---|---|---|---|
| 2 | llama.cpp's own | 45,568 | 69.1 / 62.2 |
| 2 | 2 | **49,152** | 68.2 / 62.7 |
| 2 | 3 | 45,568 | 65.5 / 63.7 |
| 1 | 2 | **75,264** | 65.6 / 65.5 |
| 1 | llama.cpp's own | 61,440 | 62.1 / 60.4 |

- **Conclusion:** 2 guesses ahead is as fast as llama.cpp's default and leaves more room, so 2 is now KesherAI's default. Running one chat at a time gives 75K per chat at the same speed. The cost is that self-work and a chat then wait for each other. The PC is set to 2 chats at once with 2 guesses ahead. (Prose; code gains more from MTP, so it was not measured here.)

## 2026-11-10 (cont.) — Is a q4_0 KV cache worth it for Qwen3.8? No, for now
- InventiveHQ (June 2026; Qwen2.5-Coder-7B, 8K context): q8_0 output stayed 81.6% similar to f16, but q4_0 dropped to 8.3%, a "quality cliff". On CUDA the speed barely changed, so speed alone would not reveal the loss.
- Qwen3.8-27B is hybrid: only 16 of its 64 layers have a KV cache (3 DeltaNet layers to every attention layer), so its KV is small (~16 KB per token at f16, ~8 KB at q8_0; wal.sh). Going from q8_0 to q4_0 would save only about 1 GB at 100K tokens. The rest of the memory goes to weights, the recurrent state per slot, the MTP head and compute buffers.
- **Decision:** keep q8_0. The context is better won back with parallel 1 or fewer MTP guesses, as measured above. TurboQuant (3-bit KV, matched fp16 in one test) can be re-checked when it is in mainline llama.cpp.
- **Where this stopped:** KV cache research done; nothing to build.

## 2026-11-10 (cont.) — Antigravity CLI on the PC: works end to end
- With Roee's approval, Antigravity CLI was installed through KesherAI's terminal button (Google's installer) at `%LOCALAPPDATA%\agy\bin\agy.exe`, the path KesherAI already looks in. The Antigravity desktop app (`Programs\antigravity`) does not include the CLI.
- **The CLI used the existing Google sign-in with no new login**, apparently the one Roee already had in the desktop app; no `agy` login step was needed.
- **The test chat, in the KesherAI repo:** a one-line answer came back correct. Then `git status --short` produced an approval card in 🔔, was approved from the notifications page, ran, and was answered correctly ("one untracked file, electron.exe"). Both test chats were deleted.
- **Fixed:** the approval card's "why" showed the previous turn's answer; it now shows what the agent said in this turn.

- **0.6.64 on the PC:** a real Antigravity session lists Roee's account models: Gemini 3.8 Flash (the default), Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking) and GPT-OSS 120B (Medium). Thinking levels are Low, Medium and High; modes are Default, Accept edits, Auto and Plan. The session started in 1.4 s. **So Claude models are available through Antigravity on the Google subscription, inside Google's own CLI**, which is not the forbidden pattern of KesherAI using a subscription sign-in itself. The mode is no longer repeated in the chip; KesherAI's "auto" now maps to Antigravity's Auto.

## 2026-11-10 (cont.) — Antigravity: what is allowed, and its quotas (decides the next step)
- **Allowed** (Google AI forum, Oct 26, 2026; the answerer's staff status is not shown): personal, single-user, **interactive** use of the official ACP agent from an ACP client, signed in through its own OAuth. **Still banned** under clause 6 of the Antigravity Additional Terms: extracting or proxying OAuth tokens, **wrapping `agy -p` in third-party agent loops**, and automating multi-account rotation. Bans have come without warning, and reach both Antigravity and Gemini CLI accounts (zentor.ai; the clause was narrowed on Sept 3).
- **Decision: no Antigravity in self-work, routines or any unattended loop.** KesherAI keeps Antigravity to chats the user drives, one message at a time. This is what the code already does: only code chats, started by the user's own message, with no `-p` and no automatic follow-up messages. A guard that keeps self-work from ever choosing `agent/*` was added below.
- **Models:** the Oct 26 reply said ACP clients only get the plan's Gemini models, but Antigravity CLI 1.5.1 (Nov 5, Google's own release notes) "makes every model on your account available to any ACP client". Roee's session does list Claude Sonnet and Opus 4.6. The newer, official note wins, so they are offered, and the risk is stated to Roee.
- **Quotas on Pro** (agentpedia): a 5-hour meter under a weekly ceiling, tracked per model group (Claude and GPT have their own group). An empty weekly meter locks that group for 5–7 days (forum reports). `/usage` in agy shows the meters. Switching to a group that has room is the way around it.
- **Where this stopped:** the plan "Antigravity in self-work" is dropped; next is resuming a chat's session after a restart.
- **0.6.67 on the PC (resume, done):** after an update, "Restart" from the interface came back in 12 s, with the new exit fix. The Antigravity chat then answered the code word it was given before the restart ("ענבר-ירוק"), using its saved session `1a5c5b45…`. The first attempt on 0.6.65 had failed because the id was saved only on edits; that is fixed and tested. The test chat was deleted.

## 2026-11-10: Submenus on a phone (done)
- **NN/g, Mobile Subnavigation:**
  - An accordion (expand in place) is fine for fewer than 6 items.
  - A drill-down (replace, with Back) fits more on a small screen, but people lose their place, and an in-menu Back is confused with the phone's Back. Naming the current level helps.
- **Apple HIG, Menus:** a submenu opens in place of its parent and shows its title as the way back.
- **Done:** on a computer, open in place. At 700px or narrower, the open flyout replaces the menu, and its row (sticky, bold, back chevron) names it and goes back.
- **Found:** in a capped flex menu, the flyout (overflow:auto) shrank to 0 height. Fixed with flex-shrink 0.
- **Stopped at:** nothing open. Maybe later: the phone's own Back closes a flyout first (history entry).

## 2026-11-10: Approvals and notifications for agent chats (done, first round)
- **Sources:**
  - Claude Code Remote Control: push when an action is needed; prompts stay open until answered.
  - Happy: the push opens the same chat with the exact command, approved there.
  - Greenlight and Pushary: Approve/Deny on the notification itself, in one queue across agents.
  - Open WebUI Computer: Allow/Deny inline on the tool's card, per mode.
- **Rules taken:**
  - The approval lives on the step's card in the chat. Notifications are a doorway to it, so they open the chat, not a separate page.
  - Answered anywhere means gone everywhere. A "waiting" note that was answered is marked with how it ended and is no longer counted.
  - The end of a run says how it ended: Done, Stopped by you (no "Done" note), or an error with the error itself.
  - A run's state on the phone must not depend on one live stream: catch up when it stalls.
- **Found on the PC:**
  - A start-up routine ran on every restart (15 in a day, each "No answer" because LM Studio was not running).
  - A stopped run was announced as "Done".
  - Waiting notes linked to #/watch and stayed "new" after being answered.
  - The phone kept "Working…" after Stop.
- **Stopped at:** maybe later:
  - Withdraw the phone's push itself when answered elsewhere (ntfy supports deleting a message by id).
  - Group several notes from one chat.

## 2026-11-10: How settings are arranged (done) and the app's structure compared (first pass)
- **Sources:**
  - Open WebUI 0.11 ("the interface reorganized"): one Settings with personal and admin sections, one search over all, Notifications as its own section.
  - LM Studio 0.4: Settings tabs Developer / Server / Chat; Hardware is its own page; per-model load settings stay in the loader, not in Settings; one "Developer mode" switch shows advanced options.
  - Msty Studio: General (appearance, app info, reset), Local AI service, Remote service and data (backups), Shortcuts, Notifications and logs.
  - Settings UX guides (setproduct, uxcel): side navigation for many categories, a search at the top, risky actions (reset) confirmed and kept apart, one subject per group.
- **Done (KesherAI):**
  - "General" was a drawer of five subjects. Notifications and Privacy & permissions now have their own categories.
  - Appearance and accessibility are merged.
  - Import and Reset moved to "Accounts, backup and data".
  - Computer control moved to Privacy.
  - A search over every category (Hebrew and English words).
  - Old links work (#/settings/accessibility → appearance).
  - The load panel links to the "unload after" setting.
- **App structure compared:**
  - Others keep 4–6 top areas: LM Studio has Chat, Developer, My models, Discover; Open WebUI has Chats and Workspace (models, knowledge, prompts, tools); LobeHub has Chat, Market, Settings.
  - KesherAI has 27 pages in 4 groups plus pins. Its grouping is sound; ideas for later are in the Drive summary.
- **Stopped at:** these ideas are not built yet:
  - A "game development" group: Unity, Unreal and their flows, now under Create.
  - The duplicate 📦 icon (Models and Libraries).
  - "Watch" duplicates the 🔔 inbox.
  - A developer-mode switch that hides advanced pages (LM Studio).

## 2026-11-11: Calibrating to Roee's PC (RTX 3090 24 GB, Ryzen 9 9950X3D, 94 GB) — measured
- **llama-bench (b12110), Qwen3.8-27B UD-Q4_K_XL, all on the GPU, no MTP**, in tokens per second:

| Setup | Reading 2K | Writing | Reading at 16K | Writing at 16K | Reading at 49K | Writing at 49K |
| --- | --- | --- | --- | --- | --- | --- |
| FA off, f16 KV | 1,502 | 41.0 | 1,035 | 33.2 | – | – |
| FA on, f16 KV | 1,521 | 41.0 | 1,253 | 38.9 | – | – |
| FA on, q8_0 KV (ours) | 1,499 | 40.6 | 1,236 | 36.9 | 913 | 31.0 |

- **FA:** helps from 16K on (+21% reading, +17% writing). It is on in our server, because a q8_0 V cache needs it.
- **q8_0 KV:** costs about 5% writing at 16K and halves the context memory. Kept.
- **Our server, live:**
  - 2 slots × 49,152 context.
  - MTP gives 60.8 tok/s writing (66% of guesses accepted), about 1.5× the 40.6 without it.
  - The prompt cache works: the next message re-read 30 tokens of 9,155 (f_keep 0.996).
- **A plain chat's instructions and tools are 9,058 tokens:** 6.7 s before the first word of a new chat. Slimming them is the next real gain.
- **Bug found and fixed:** after 20+ idle minutes, loading a model by hand was stopped by the idle unloader while still loading.
- **Research:**
  - ik_llama.cpp: about 73 tok/s at 156K on one 3090 with MTP; techyon.pages.dev.
  - DFlash: about 2×, but Linux, greedy decoding and its own fork only.
- **Stopped at:** these are not built yet:
  - A calibration screen that runs this matrix on any computer.
  - Slimming the plain chat's tools.
  - Trying ik_llama.cpp as a second engine.

## 2026-11-11: A calibration screen in KesherAI (research, stopped before building)
- **Others:**
  - LM Studio has no built-in benchmark or auto-tune: users read the live tok/s or time API calls. Measured 31–52% slower than tuned llama.cpp (older bundled build, cautious context and offload, FA sometimes off); insiderllm.com.
  - Ollama has none either.
  - Outside tools (llmspeed, benchmarkLLM) only measure. They do not choose settings.
  - So choosing settings from measurements on the user's own computer would set KesherAI apart.
- **Ours already:**
  - `/api/models/benchmark`: one 200-token run, speed kept next to the model.
  - `llama-bench.exe` ships in the engine folder (b12110).
  - The engine starts with fit, FA, q8_0 KV, MTP, and the model card's sampling.
- **Design (to build):**
  - Models → a model's ⋯ → "Calibrate for this computer".
  - Runs llama-bench in the background with the chat model unloaded: FA on, KV f16/q8_0, depth 0/16K/48K, chats at once 1/2. About 5 minutes, with progress and Stop.
  - Shows a table: reading and writing speed per setup, plus memory.
  - Recommends three: "longest context", "fastest", "balanced". One tap applies (chats at once, KV type).
  - Results are kept per model and graphics card, and shown on the phone too.
  - Guard: refuse while a chat or self-work is running; touch the guard during the run.
- **Stopped at:** design only. Next: an API (`POST /api/models/calibrate`, a background job), parsing `-o json` from llama-bench, then the screen.
- **Open for Roee:**
  - A Q5/Q6 download for accuracy.
  - ik_llama.cpp as a second engine; techyon measured about 73 tok/s at 156K on one 3090.

## 2026-11-11: One menu on the computer and the phone (done)
- **Material 3 adaptive navigation (developer.android.com):** destinations are defined once (`navigationSuiteItems`). The same items show as a bottom bar, a rail or a drawer, chosen by window size at run time.
- **Apple iPadOS 18 (WWDC24 10147):** tabs are declared once; the tab bar turns into a sidebar with the same items. People add, remove and reorder; the order and visibility are saved. Syncing across devices is not stated.
- **Notion:** sidebar shortcuts are personal.
- **Done (KesherAI 0.6.90):**
  - `useAppMenu()` is the one source: main actions, pinned tools, shortcuts. The sidebar (computer), the phone's menu drawer, the top bar's ☰ menu and the home screen all draw from it.
  - Pins and shortcuts are kept on the computer (/api/pins, /api/shortcuts), so every device shows the same ones in the same order. A device whose pins were changed earlier gives them to the computer once.
- **Stopped at:** the phone's bottom tabs (Chats, New, Tools, Settings) are still their own four. If wanted, they could come from useAppMenu too (Apple's "tab bar = sidebar" model).

## 2026-11-11: How other apps show a task list (the self-work board)
- **Question:** our board looked messy on a phone (a box around every row, a big pill at the end, rows overlapping). How do others do it?
- **Linear (desktop and mobile):** one row per issue with no box. A small status mark at the start (empty circle = open, half-filled = in progress, a mark for blocked), then the title, then quiet details. Groups by status fold and show a count. Sources: linear.app/changelog/2024-09-19-introducing-linear-mobile, screensdesign.com/apps/linear-mobile.
- **Material list items (two-line):** a leading icon, a primary line, a secondary line in a smaller muted style. Rows are at least 48px, and long text is cut with an ellipsis instead of pushing the layout. Sources: m2.material.io/go/design-lists, playbook.ebay.com/design-system/components/list-row.
- **List UI write-ups (eleken, saasframe):** keep one line of metadata, use dividers rather than cards, and put the status where the eye starts.
- **Taken here (0.6.95):** no box and no pill; a status mark (○ open, ◐ in progress, ⊘ blocked, ● done); the title cut at two lines (shown in full once opened); one quiet line: number, status, who. Categories fold and show a count; the explanation moved to a tooltip. The task in progress stays first.
- **Stopped at:** drag to reorder and swipe actions on the phone (Todoist-style) were not built; tap to open is enough for now.

## 2026-11-11: Phone notifications from the KesherAI app itself (like other phone apps)
- **Question:** Roee wants the phone app to notify "normally", like other phone apps, not only through the ntfy app. He chose both ways of delivering: KesherAI's own connection, and through ntfy.
- **Google's push service (Firebase/FCM):** needs a Firebase project (an account) and its server key. Not used (no accounts; it would also pass every notification through Google).
- **Home Assistant (Android "persistent connection" / local push):** the app holds a websocket in a foreground service. A permanent notification is required; users minimize its channel. It costs some battery, and Android can drop it when the phone sleeps (forum reports). No Firebase. Source: companion.home-assistant.io/docs/notifications/notification-local.
- **UnifiedPush (Element, Tusky, others):** an installed distributor app (ntfy) keeps one connection for all apps and hands each message to the app (KesherAI), which shows it as its own notification. The app registers and gets an endpoint, the server POSTs to it: 1–4096 bytes, no redirects, 2xx means accepted, 404/410 means stop using it, 429 means slow down. The spec asks servers to guard against SSRF: http/https only, no private addresses, checked when registered. The connector library (`org.unifiedpush.android:connector`) decrypts Web Push (RFC 8291, aes128gcm). Sources: unifiedpush.org/developers/spec/server, unifiedpush.org/@dev/kdoc/connector, rfc-editor.org/rfc/rfc8291.
- **How phone apps notify (Android guidelines):**
  - One channel per kind, so the user can mute each in Android settings. High (sound and pop-up) only for what needs you now.
  - Tapping opens the exact place.
  - Action buttons for things done without opening the app; sensitive ones only on an unlocked phone (`setAuthenticationRequired`).
  - Update one notification instead of stacking duplicates; group several under a summary.
  - Remove a notification once it no longer applies, the way messaging apps clear what was read on another device.
  - Badges on the icon. Android 15 softens rapid repeats.
  - Source: developer.android.com/develop/ui/compose/notifications.
- **Plan for KesherAI:**
  - **Channels:**
    - "Waiting for you": high, pops up, with Approve/Deny that need an unlocked phone.
    - "Finished": default.
    - "Downloads": low.
    - "Connection": minimal, for the live connection's permanent notification.
  - **One notification per chat:** it is updated, not stacked, and grouped under KesherAI. It is cleared on the phone as soon as the chat is answered anywhere.
  - **Delivery:**
    - Over the live connection when it is up.
    - Otherwise through UnifiedPush (ntfy), encrypted end to end so ntfy only sees ciphertext.
    - Otherwise the current ntfy topic.
  - **No duplicates:** the server sends each note one way only.
- **Stopped at:** iOS is not in scope (no iOS app).

## 2026-11-11: Engine memory, visible (t22): llama-fit-params
- **How llama.cpp fits** (discussion ggml-org/llama.cpp#18049):
  - `--fit` is on by default. It checks whether everything fits, then shrinks the context, then moves tensors to system memory (dense ones first, MoE experts last), using test allocations only.
  - `--fit-target` is the memory left free on each card (1 GB default; ours 2 GB, see the 2026-11-11 calibration).
  - `--fit-ctx` is the smallest context it may set.
  - Setting `-ngl`, `--tensor-split` or `-ot` by hand turns fitting off for all of them.
  - `llama-fit-params` runs the same fitting without loading the weights and prints the chosen arguments.
- **Measured on Roee's PC** (b12110, Qwen3.8-27B Q4_K_XL, with self-work's model already on the card):
  - stdout: `-c 49152 -ngl 60`.
  - The log's summary line: `- CUDA0 (NVIDIA GeForce RTX 3090): 60 layers, 16727 MiB used, 1237 MiB free`, then `successfully fit params`. With another model loaded, 60 of 65 layers fit.
  - It took about 1.5 s of fitting, and up to about 40 s in all while the card was busy.
- **Others:** LM Studio shows a "fits / partial offload" estimate from file size. Ollama shows nothing before loading. Neither uses llama.cpp's own fitting, so KesherAI's answer is the exact one.
- **Built (0.6.104):**
  - "What fits?" next to each GGUF on the Models page (`POST /api/models/fit`, kept a minute): fits entirely, partly, or does not fit now; per card: layers, GB used, GB left; context; and which model was loaded during the check.
  - "Leave free on the graphics card" (1–8 GB, default 2) in Settings → Computer, for a game or the Unreal/Unity editor on the same card. It is `--fit-target`; the model loads again.
- **Stopped at:** the calibration part of t22 (llama-bench matrix, three recommendations) is not built yet. Design: the 2026-11-11 entry above.
- **Calibration built (2026-11-11, 0.6.105), finishing t22:**
  - Models → a GGUF → **Calibrate**: llama-bench with the context memory at 8 and 16 bits, at 0, 16K and 48K tokens deep (48K dropped if it does not fit). The chat model is unloaded for it, about 5 minutes with progress and Stop, then loaded back.
  - The table shows reading and writing per setup. KesherAI recommends 16-bit only when it writes 10% or more faster deep into a chat. On Roee's PC it was +5% at 16K, so 8-bit stays.
  - **Use this** sets it (`engines.kvType`). Results are kept per model and card.
  - It is refused while a chat or self-work is answering.
  - llama-bench's `-o json` gives one row per test: `type_k`, `n_depth`, `n_prompt` or `n_gen`, `avg_ts`.
  - Left out: chats at once (llama-bench cannot measure slots); that stays the "Chats at once" setting.

## 2026-11-13: How an app like KesherAI should work (deep research)
- Written up in `docs/DESIGN_RESEARCH.md`: UI and UX, agent UX, accessibility, Hebrew and RTL, performance, developers, modders and plugins, modularity. Each part has what others do (sources), where KesherAI is (checked in the code), and what to do, with one prioritized list (board t39–t50).
- The core's structure is in `docs/ARCHITECTURE_REVIEW.md` (t18).
- **Fixed with it:** the chat was a live region, so a screen reader re-read the answer on every word. It is a log with one status line now. The import cycle through `conversations.ts` is gone.
- **Stopped at:** game-mod ecosystems (Factorio) could not be read; look again before designing the public plugin list. No NVDA pass yet (needs Roee's PC, t50).

## 2026-11-13: Plan — Antigravity through a list of board tasks, staying interactive (t19)
- **The limit:** Antigravity runs in KesherAI only in chats the user drives. Google's forum reply (2026-09-16, above) covers a single user running the unmodified `agy` under their own sign-in. A loop that sends follow-up messages by itself is outside that. So: every message to Antigravity is sent by a press from the user.
- **The idea:** a "work list" beside an Antigravity code chat. The user picks tasks from the board; KesherAI prepares the next message; the user presses **Next** to send it.
- **The screen (in the chat's side panel, phone: a sheet):**
  - The picked tasks in order, each with its board status.
  - When Antigravity's turn ends: a card "Next: t24 — Disk space in view" with the message KesherAI wrote (the task's title, details, "claim it on the board, mark it done with the commit"). Buttons: **Send**, **Edit**, **Skip**.
  - Nothing is sent without Send. If the user is away, it waits; the 🔔 inbox and the phone get "Antigravity finished t23. Next is ready to send."
- **What KesherAI does by itself (allowed, it is not talking to Antigravity):**
  - Marks the task claimed by "antigravity" when its message is sent, and reads the board when the turn ends.
  - Runs the project's check (`pnpm typecheck && pnpm test`) after a turn and puts the result in the next card: "the check failed: …" becomes the suggested message.
  - Saves a checkpoint before each message (already done for code chats).
- **Approvals:** Antigravity's own permission requests already arrive in 🔔 with a preview (0.6.9x). Mode mapping stays: ask → default, auto-edit → accept-edits, plan → plan.
- **What it must not have:** auto-send, "send all", a timer, or self-work using Antigravity. The Send button is not reachable by any agent tool or routine (same rule as approving danger-flagged requests).
- **Pieces to build:**
  1. `work-list.ts`: the list per conversation (task ids, position), kept with the chat.
  2. `GET/PUT /api/conversations/:id/work-list`, and `POST …/work-list/next` that only returns the prepared text (it does not send).
  3. `WorkListPanel.tsx` in the chat, with the Next card. Sending uses the normal message route, from the user's click.
  4. A notification when the turn ends and a next task is ready.
  5. Tests: the next message is built from the board; nothing in the server sends by itself (a test that no code path calls `send` for an outside agent without a request from the user).
- **Open question for Roee:** should a failed check block Next (must fix first) or only warn?

## 2026-11-13: Plan — fit across two graphics cards, and the DeepSeek V4-Flash experiment (t29)
### Part 1: two cards, end to end
- **What exists:** `gpus.ts` plans a split (`--tensor-split` by free memory, the fastest card as `--main-gpu`, one card alone when the model fits it). "What fits?" (`fit-preview.ts`) already reads one line per card from llama-fit-params.
- **A conflict found while planning:** llama.cpp turns its own fitting off when `-ngl`, `--tensor-split` or `-ot` is set by hand (discussion #18049, in the 2026-11-11 entry). So when `planGpus` passes `--tensor-split`, fitting no longer shrinks the context or moves experts to system memory. On one card this never shows; on two it would.
- **The plan:**
  1. With two cards and `mode: auto`, pass only `--device` (which cards) and `--main-gpu`, and let fitting split the layers. Keep `--tensor-split` only when the user set shares.
  2. "What fits?" runs with the same arguments, so it shows both cards (the parser already does).
  3. "Fits my computer" in the model list counts the free memory of the cards in use plus system memory, the way fitting will use them, not the largest card alone.
  4. `--fit-target` (memory to leave free) applies per card; the setting says so.
  5. Tests with fake `nvidia-smi` output for two cards (the existing `gpus.test.ts` pattern) and a fit log with two device lines.
- **Cannot be checked on Roee's PC today** (one RTX 3090). Steps 1–5 are built against tests; the real check waits for the second card.

### Part 2: DeepSeek V4-Flash on today's PC
- **The numbers:** the 3-bit GGUF is about 103 GB and needs about 110 GB. The PC has 24 GB on the card and 96 GB of system memory: 120 GB in all, of which Windows and other programs take 8–12 GB. It is tight. It can load only with almost everything else closed, and with `--fit-target` at its lowest (512 MB).
- **Before downloading (103 GB, needs Roee's yes):** free disk space on E: (needs about 110 GB), and whether the file is split into parts.
- **The test, in order. Stop at the first step that fails and write down where:**
  1. **Fit preview only:** "What fits?" on the file. Expected: all layers "on the card" with the experts in system memory (MoE), a context of 8–16K. If fitting fails, try `--moe-cache-mib` (experts cached in VRAM, 2026-11-10 entry) and note it.
  2. **Load:** time to ready, and memory left (Task Manager numbers go in the log).
  3. **Speed:** "Calibrate" on it (reading and writing at 0 and 16K). 13B active parameters with experts in system memory: expect a few tokens per second writing. Under 3 tok/s is not usable for chat; under 8 is not usable for self-work.
  4. **Tool calls:** a code chat with one small task (read a file, edit one line, run the check). Does it call tools in the right format, or does it need a chat template fix?
  5. **Self-work:** one small board task, 30 minutes, compared with Qwen3.8-27B on the same task (time, did the check pass, did the review find bugs).
- **What decides:** if step 5 is slower than Qwen and not clearly better, the 3-bit model is an experiment only, and the real question moves to the second 3090 + 128 GB (the 4-bit file, 155 GB).
- **Alternative with less risk first:** Qwen3.8-Flash-Next IQ3_XXS (85 GB, 2026-11-10 entry) fits with room and tests the same path (a big MoE with experts in system memory).

## 2026-11-13: Plan — instant phone notifications through Google's push, optional (t30)
- **The problem:** the live connection can be cut when the phone sleeps deeply, so a notification may arrive late. Google's push (FCM) wakes the phone for a high-priority message.
- **Found first: it may already work, with nothing to set up.** The ntfy app from Google Play uses Firebase for ntfy.sh ("uses Firebase only for the main host ntfy.sh, and only in the Google Play flavor", docs.ntfy.sh/subscribe/phone). KesherAI's backup path is UnifiedPush through ntfy, and its messages are already encrypted for the phone. So with ntfy from Google Play and the backup switch on, a sleeping phone should be woken by Google's push, and ntfy.sh sees only ciphertext.
  - **To check on Roee's phone before building anything:** ntfy from Google Play (not F-Droid), backup switch on, the direct connection off for the test, phone asleep 30+ minutes, then a test notification from the computer. If it arrives within seconds, this plan's own FCM path is not needed.
- **If KesherAI's own FCM is still wanted** (no ntfy app at all):
  - **Why it cannot ship ready-made:** sending through FCM needs a server key (a Firebase service account). The docs say server keys "must not be included in applications". An open-source app cannot carry one, and a shared relay server run by the project would see every user's traffic metadata and cost money. So each user brings their own Firebase project. It is free.
  - **What Roee sets up once (about 10 minutes):**
    1. console.firebase.google.com → a new project (no Analytics needed).
    2. Add an Android app with KesherAI's package name; download `google-services.json`.
    3. Project settings → Service accounts → "Generate new private key" (a JSON file).
    4. In KesherAI on the computer: Settings → Notifications → "Google push" → choose both files. They stay in the data folder on the computer, never in git, never sent anywhere else.
  - **How it works:**
    - The phone app does not need to be rebuilt: Firebase can be started in code from three values in `google-services.json` (project id, application id, API key: firebase.google.com/support/guides/init-options). They are identifiers, not secrets. The paired phone gets them from the computer over the existing connection.
    - The phone gets an FCM token and gives it to the computer (`PUT /api/phone-push/fcm`, paired devices only, like the UnifiedPush address).
    - The computer signs a short-lived Google token with the service account and POSTs to FCM's HTTP v1 API. The message carries the same encrypted body as today (RFC 8291, `phone-push.ts`), base64 in a `data` field, so Google sees only ciphertext. Limit: 4 KB, the same as now.
    - Priority: high for "Waiting for you", normal for the rest. FCM lowers the priority of high-priority messages that do not end as a visible notification (firebase.blog, 2025-04), so every high one must show a notification. Ours do.
    - Order of delivery: live connection (confirmed within 8 s) → FCM → UnifiedPush.
  - **Pieces to build:** `fcm.ts` (token signing with `node:crypto`, send, drop a token on 404/UNREGISTERED), the route, the settings card with the two files and a test button, the Android side (`firebase-messaging`, runtime init, a service that decrypts and calls the existing `Notes.handle`), tests with a fake FCM endpoint.
  - **Costs and risks:** one more Android library (Google Play services only; a phone without them keeps the other two paths). The service account file is a secret on the computer: stored like other tokens, shown as "set" only, never returned by the API.
- **Recommendation:** run the ntfy check first. Build the own-FCM path only if that check fails or Roee wants no ntfy app.

## 2026-11-13: UX — the notification panel, the design assistant, editing the menu (Roee's request)
- **Asked:** the bell opens a whole screen and should be a toggle; notifications from the app without ntfy (ntfy as an add-on); a 🎨 button next to the bell with a small model for the look and the side menu; a ✏ in the side menu to reorder it.
- **Notification centers (GitHub, Linear, Slack, Notion; the pattern write-up on saasui.design):**
  - The bell opens a **popover under it**, not a page. The full history is a separate page, linked from the popover's foot.
  - Things that **need an answer come first and are answered in place** (approve, deny) without leaving the screen.
  - The **badge counts only what is new**, is capped ("9+"), and **opening the panel clears it**. A count that never goes down (ours showed 50) teaches people to ignore it.
  - "Mark all read" and a link to the settings sit in the panel.
  - **Built:** `ui/BarPopover.tsx` (closes on outside click, Escape, and a page change; focus goes back to the button), `InboxBell` as a panel. The number shows only approvals waiting; other news is a dot that goes when the panel opens. On a phone the panel spans the screen under the bar.
- **Customizing a sidebar (Linear "Customize sidebar", Slack sidebar preferences, Notion, Discord):**
  - Editing is a **mode with a clear Done**; hiding **never deletes**, and hidden items stay one tap away.
  - Drag is the fast way, but **arrows are needed too** (keyboard, screen readers, small touch targets). Slack and Linear give both.
  - **Built:** `SidebarEdit.tsx`: pinned tools and shortcuts with ↑ ↓ ✕, "Add to the menu" with everything hidden, "Back to the default". ✏ in the sidebar's foot row on the computer; in the ≡ menu on the phone (as a dialog, since the phone has no sidebar on screen). Long press and drag in the sidebar still works.
- **A small assistant for the look (Arc's theme tools, Raycast, Notion's and Linear's "ask AI" panels):**
  - Small, next to what it changes; **examples to start from**; the change shows at once; **Undo next to each answer**.
  - It must not be a second chat: two tools only (`change_look`, `change_menu`), six steps at most, approvals refused.
  - **Built:** `design-assistant.ts` + `POST /api/design-assistant` + `DesignAssistant.tsx`. It uses the active chat model (a smaller dedicated model can come later: the request is short, so any small tool-calling model would do).
- **Notifications without ntfy:** the app's own path already existed (live connection, then UnifiedPush) but Roee's phone never called `/api/phone-push`, so it was never on. Now the phone app turns the live connection on by itself at first start and reports what happened (`POST /api/phone-push/hello`: plugin loaded, permission, error); the computer shows each phone's state in plain words (Settings → Notifications). ntfy moved to a folded "Add-on: ntfy" card.
- **Where this stopped / still open:**
  - Notification **titles are English** inside a Hebrew interface ("Self-work needs you"): they are made on the server, which does not know the language. Needs the title as a key + parameters, translated where shown.
  - Grouping notes by source in the panel (ten notes from one self-work run should be one line with a count).
  - The design assistant has no model picker and no streaming; fine for short requests.
  - General UX list from the competitor review stays in `docs/DESIGN_RESEARCH.md` (t39–t50): simple mode, command palette, run receipt with undo are the three biggest.

## 2026-11-13: Research — a working experience like Claude's (Steps, Browser, Code environments, git, memory)
- Full write-up and the six-stage plan: `docs/CLAUDE_PARITY_PLAN.md`.
- **Read:** Claude Code desktop docs (panes, environments, permission modes, git), the built-in browser docs (approvals, profile, what the agent can do), cloud environments, the memory help article.
- **Not read yet (where this stopped):** how Cursor, Windsurf and Codex lay out the same panes (only Claude was asked for); the second half of the desktop docs page (it is long: the first 100,000 characters were read); the Electron `WebContentsView` API details for stage 3.
- **Also found today:** Capacitor 8 gives its native bridge only to the app's own pages. The computer's pages in the phone app had no native plugin at all, which is why notifications were never set up from there. Fixed in the app (`RemoteBridge.java`, exact origins of paired computers, main frame only).

## 2026-11-13: Research — editing Blueprints and Unity Visual Scripting graphs
- Write-up and plan: `docs/GRAPH_EDITORS_PLAN.md`. Read: Epic's Blueprint cheat sheet, Unity's "Connect nodes" page, the 2026 Unreal MCP servers (forum listings only).
- Found in the code: a read-only canvas panned silently on a pin drag; Unity editing was off in the page though the package applies operations.
- **Where this stopped:** the MCP servers' source was not read (how they list actions and report compile errors); Unity's fuzzy finder API (`UnitOptionTree`) was not read; no check yet against Unreal 5.9.

## 2026-11-13 — Browser pane and per-site approvals (CLAUDE_PARITY_PLAN stage 3)
- **Claude in Chrome** (support.claude.com/en/articles/12902446): modes Manually approve / Automatically approve /
  Skip all approvals; per site: allow one action, always allow on this site, decline. Even with "always": downloads,
  sensitive information and authorizations still ask. Blocked: purchases, account creation, card/ID data,
  untrusted downloads, instructions found in web content. Approved sites listed in settings with revoke.
- **ChatGPT Atlas** agent mode: help page could not be fetched (client error); not used.
- Built (0.6.136–0.6.137): pane in the app window (WebContentsView, own storage, isolated-world helpers shared with
  the extension), phone view as refreshing pictures with taps, Allow once / Always on <site> / Deny, Settings list.
- Stopped at: pane not yet checked live on the PC (waiting for a chat to finish before installing); next: watch the
  model use it end to end, then "check my change" (open the dev server after an edit).

## 2026-11-14 — Environments and worktrees (CLAUDE_PARITY_PLAN stage 4)
- **Claude Code** (code.claude.com/docs/en/worktrees): `--worktree` / desktop worktree option; `.claude/worktrees/<name>`,
  branch `worktree-<name>`, from the default branch; `.worktreeinclude` (.gitignore syntax) copies ignored files such as
  `.env`; on exit a clean worktree is removed, one with work asks keep/remove.
- **Codex app** (learn.chatgpt.com/docs/environments/local-environment): local environments in `.codex/`; a setup script
  runs when a worktree is made for a new chat (per-OS variants); "actions" (dev server, tests) in the top bar run in the
  integrated terminal.
- Built for KesherAI: both ideas, keyed by the folder (Code sessions are started by folder), stored in KesherAI's
  settings rather than the repo. Stopped at: named environments menu; SSH/WSL left for when asked.

## 2026-11-14 — Git to the end (CLAUDE_PARITY_PLAN stage 5)
- **Claude Code desktop** (claude.com/blog/preview-review-and-merge-with-claude-code): PR status with CI checks (via
  GitHub CLI), auto-fix of failing checks, auto-merge when all pass, keeps watching in the background; "Review code"
  puts inline comments on the local diff. PR creation itself is not described there.
- Built: the same with the GitHub account KesherAI already connects (no gh needed). Stopped at: "Review code"
  (the model's own inline comments on the diff) not built yet.

## 2026-11-14 — Memory like Claude's (CLAUDE_PARITY_PLAN stage 6)
- **Claude** (support.claude.com/en/articles/11817273): memory builds automatically as topics; per-project memory that
  also uses non-project memory unless "Use account memory" is off; incognito chats (not saved to memory or history,
  not searched); view/edit/delete topics; pause keeps memories; reset deletes all, projects included.
- **ChatGPT** memory FAQ could not be fetched (client error); not used.
- Built for KesherAI as above. Stopped at: no import of memory from other assistants yet; incognito chats are kept in
  the chat list (only memory and search skip them).

## 2026-11-14 — Agents (CLAUDE_PARITY_PLAN stage 7)
- **Claude Code** (code.claude.com/docs/en/sub-agents): Markdown files with YAML frontmatter in `.claude/agents/`
  (project) and `~/.claude/agents/` (user); `name` and `description` required; `tools`/`disallowedTools`, `model`
  (or `inherit`), `isolation: worktree`, `background` and more optional; the body is the system prompt. The main
  agent picks one by its description, or the user names/@-mentions it. Own context; only a summary comes back;
  permissions are the parent's; background agents send their approval prompts to the main session. Built-ins:
  Explore (read-only search), Plan, general-purpose.
- **Codex** (codex.danielvaughan.com summary of the official docs): TOML files in `.codex/agents/` and
  `~/.codex/agents/` (`name`, `description`, `developer_instructions`; optional `model`, `sandbox_mode`…); spawned
  only when asked; max 6 at once, depth 1; inherit the parent's sandbox and approvals (approvals show which agent
  asks). Built-in roles: default, worker, explorer.
- **Cursor 2.4** (notes.dsebastien.net): subagents with own context, prompt, tools and model, in parallel, can nest.
  Forum reports show custom agents in `.cursor/agents/`; its docs pages were not reachable.
- KesherAI already had: `delegate` (read-only helpers, up to 4 at once, any model) and agent groups (personas via
  `ask_member`). Missing: named agents the model picks by description, project agent files, agents that change files.
- Plan: (1) named read-only agents: a persona with "when to use it" becomes an agent; project files in
  `.kesher/agents/` and `.claude/agents/` (the Claude Code format, so existing ones work); `delegate` takes `agent`.
  (2) later: worker agents that change files in their own worktree, the user approving in the chat.

## 2026-11-14 — PC Health and Phone Health, with AI (VISION, board t23)
- **Copilot PC Insights** (arynews.tv report): answers questions about CPU/RAM/GPU use, free storage and folder sizes,
  connected devices, Wi-Fi/Bluetooth, battery health; asks permission per check (or "always allow"); identifies
  problems but does not fix them or open files.
- **Microsoft PC Manager** (majorgeeks, betanews): one-click "boost" (temp files, memory), storage cleanup, startup
  apps, health check list with buttons per item.
- **Pixel AI battery summaries** (techrepublic, androidauthority teardown): the system writes in plain words what drains
  the battery; the article page itself could not be fetched.
- Plan: one Health page (computer and, in the phone app, the phone): numbers first, then the model's short list of
  what to do; fixes only on KesherAI's own files with a confirmation, everything else as steps; reads only.
- Stopped at: research enough to start; build t23 first, the phone part after (native plugin method).

## 2026-11-14 — Approvals with a time limit (asked for)
- **VS Code agents** (code.visualstudio.com/docs/agents/run/approvals): Allow once; scoped grants (command prefix, web
  host, file/folder) "in this Session"; Always Allow (kept across restarts); manage and reset from the command palette.
  No time limit.
- **Codex CLI**: "approve for this session" (smartscope.blog guide); no time limit either.
- The time limit is sudo's idea (a grant that runs out after N minutes). Plan: every "always" rule KesherAI keeps may
  carry an end time; the chat's approval card offers 15 min / 1 hour / until tonight beside once and always; the
  chat's rules list shows how long each has left and can shorten or remove it.

## 2026-11-14 — KesherAI looks into its own faults (asked for)
- From what is known of the tools (no new search, to save usage): Claude Code's `/doctor` checks the install and
  settings and prints problems; VS Code's "Report issue" gathers versions and logs; LM Studio shows a developer log.
  None lets the model itself read the app's faults.
- KesherAI had no fault log at all. Built: logs/faults.jsonl (server errors, failed chats; secrets and the home path
  removed; about 1 MB kept), a `kesher_doctor` tool (state now + faults, all or this chat's), "🔎 Investigate" on a
  failed chat and "Stop and investigate" on a stuck one, and the recent faults on the Health page.
- Stopped at: engines' own crashes (llama.cpp exits) are not logged yet; next when an engine fault is reported.

## 2026-11-14 — Several computers on the phone; controlling a computer from the phone (asked for)
- Already in KesherAI: the phone app keeps a list of computers and switches between them (the laptop icon at the
  top); "My devices" lets one computer use another's models. So "My day" per computer works by switching, once
  each computer allows the phone (0.6.149).
- **Chrome Remote Desktop / RustDesk** (rustdesk.com blog, alternativeto): the host streams the screen and takes
  the remote's mouse and keys; access needs a PIN set on the host (CRD) or a one-time password plus permission
  (RustDesk); the host shows that it is being controlled and can end it.
- Plan for KesherAI: "Control this computer from the phone": off by default, switched on and given a PIN on the
  computer only; a session needs the PIN (5 wrong tries lock it for 10 minutes), ends after 15 idle minutes or from
  the computer; the computer is told when it starts; the phone gets pictures of the screen and sends taps, keys and
  scrolls through KesherAI's existing screen and input code. Pictures, not video, at first (no new library).
- Stopped at: plan written; building now.
- Added (same day): CRD's two ways (pureinfotech, TechRepublic): Remote Access (your own computers, a PIN) and
  Remote Support (a code; the host approves each time). KesherAI: the PIN, or "ask the owner": the owner answers on
  the computer's bar or with the buttons on their phone (once / always / deny); "always" keeps that phone (a hash of
  its own id) until removed. Signing in with a Google account on the phone is left for later (needs a Google client
  set up for the app).

## 2026-11-14 — Firefox: the extension and the built-in AI sidebar
- Firefox MV3 runs `background.scripts` (not a service worker), needs `browser_specific_settings.gecko.id`, has a
  `sidebar_action` instead of Chrome's side panel, and grants host permissions only when the person allows them.
- Firefox's own AI chatbot sidebar with a custom provider sends its prompt to `/?q=<prompt>`
  (nilsheuman.github.io/TIL, 2025-04-17; prefs browser.ml.chat.provider / hideLocalhost / prompts.N).
- Built: extension 0.2.1 for Firefox; KesherAI answers `?q=` in an incognito, plan-mode chat (a link from any site
  could carry a question).

## Noctalia v5 plugins (2026-11-14)

- Problem: "Connect to Noctalia" copied the QML plugin, but the brother's Noctalia never listed it. His Noctalia is v5 (the `noctalia` program), and v5 only loads Luau plugins.
- v5 plugin layout: a folder with `plugin.toml` (`id = "author/plugin"`, name, version, `plugin_api`, author) and `.luau` entries (`[[widget]]`, `[[panel]]`, `[[service]]`).
- Where v5 plugins go and how they turn on:
  - Hand-placed plugins go in `$XDG_DATA_HOME/noctalia/plugins/<plugin>/`.
  - To enable: `noctalia msg plugins enable author/plugin`, or `[plugins] enabled` in config.toml.
- Config behavior:
  - Every `*.toml` file in the config folder is merged.
  - The GUI writes `~/.local/state/noctalia/settings.toml`, which wins over hand-written config.
  - Both are hot-reloaded.
- Bar placement: bar widgets are named `"author/plugin:entry"` in the `[bar.<name>]` `start`/`center`/`end` lanes. Arrays are replaced when files merge, not combined, so KesherAI doesn't write lanes; the person adds the widget from Settings → Bar.
- Luau API used:
  - `noctalia.http({url, method, headers}, cb)`
  - `noctalia.json.decode`
  - `noctalia.state.set/get/watch`
  - `noctalia.runAsync(argv)` (plugin_api 24)
  - `barWidget.setGlyph/setText/setTooltip`
  - `panel.render(ui.*)`
  - `ui.button {text, glyph, variant, enabled, onClick}`
- Not found in the docs, so left out: a text input for asking from the panel.
- Sources: docs.noctalia.dev (v5.4.0 plugins, manifest, entries, declarative UI, bar, configuration); github.com/OHMCFXG/noctalia-plugins (real v5 examples).
- Stopped at: v5 plugin shipped in 0.6.156. Not yet confirmed on a real v5 machine. Asking from the panel waits for a documented text input.

## PC Health: Fix it for me, and Storage (2026-11-14)

- Fix it for me, modeled on Windows Storage Sense "Cleanup recommendations", CCleaner Health Check ("Make it better") and Microsoft PC Manager:
  - A scan produces a list with sizes; the person can untick items; one button carries out the rest.
  - Only sure-safe items are ticked by default.
- Storage, modeled on Android's Storage settings and Files by Google:
  - Space shown by kind (videos, pictures, audio, documents, apps).
  - Cleaning cards: junk, old screenshots, large files, duplicates, old downloads.
  - Select all or pick single files; files move to the Trash, where they can be recovered.
- Choices:
  - Deleting moves files to the Recycle Bin/Trash (Electron shell.trashItem), never deletes them outright.
  - The page sends ids from the server's last scan only, never paths.
  - Only the person's own folders are scanned.
  - Uninstalling runs the program's own uninstaller, from the registry Uninstall keys (Windows) or Flatpak. dpkg packages are listed only, since removing them needs sudo.
  - Videos are compressed to H.265 at CRF 28 in a new `.compressed.mp4`; the original stays until the person moves it to the bin.
- Sources: Android Central, "Files by Google" guide; Pureinfotech, "What's taking up space on Windows 11"; Microsoft Support, "Storage settings in Windows".
- Stopped at: shipped in 0.6.158. Next ideas: blurry-photo and meme detection (Files by Google does these), and moving files to another drive or the cloud.

## Unreal Blueprint editor, control by control (2026-11-14)

- Sources: Epic's Blueprint Editor Cheat Sheet; Graph Editor docs; "Blueprint Editor Tips & Tricks" blog; uhiyama-lab's notes on organizing graphs (reroute by double-click, Straighten Connections, alignment).
- Already in KesherAI before this pass:
  - Right-drag pans, wheel zooms, Home fits.
  - Box-select by dragging; click, Shift+click and Ctrl+click select.
  - Drag nodes; Delete; C makes a comment; Ctrl+Z/Y; Ctrl+F.
  - Drag pin to pin connects; drag a pin to empty space opens the filtered menu; Alt+click breaks a pin's links.
  - Hold B/S/D/P/R and click to place a node.
- Added in this pass:
  - Space and right-click on empty space open "All Actions", in the C# script graph too (it used to say "use the side panel").
  - Pin menu: Break Pin Link(s), Promote to Variable.
  - Node menu: Delete, Cut, Copy, Duplicate, Break Node Links, Straighten Connections, Align Top/Left.
  - Ctrl+C/X/V/D use Unreal's own clipboard text (plugin 0.1.14: copy/paste ops via FEdGraphUtilities), so copied nodes paste into the real editor and back.
  - Ctrl+drag a pin moves its wires; double-click a wire adds a reroute; Q straightens; arrow keys nudge; F2 edits the comment.
  - Shift+box adds to the selection, Ctrl+box removes; the hovered node's wires are highlighted.
  - Hold G/F/M/N/O and click for Gate, ForEachLoop, MultiGate, DoN, DoOnce (standard macros).
- Not done yet:
  - LMB+RMB zoom, PageUp/PageDown between graphs, F9 breakpoints, F7 compile shortcut.
  - The "Context Sensitive" checkbox in the menu, which needs server-side filtering by pin type.
  - Dragging a variable from the variables panel onto a pin (Ctrl drops a Get, Alt drops a Set).
  - Collapse to Function.
  - Copy/paste in Unity graphs (the package has no copy op yet).
- Stopped at: the first list above is shipped (0.6.163). Next is the "Not done yet" list, with the variable drag first.

## 2026-11-14: The code editors on the computer (VS Code, Cursor, Antigravity, Rider, Visual Studio)
Asked for: "connect to the IDEs on my computer and see code their way in a small panel".
- Cursor's "Import from VS Code" brings extensions, themes, settings and keybindings: the VS Code family keeps
  them in the same shape (User/settings.json, themes as JSON with `include` and TextMate `tokenColors`).
- VS Code family: `workbench.colorTheme` names the theme; the theme file is found through the `contributes.themes`
  of an extension (~/.vscode/extensions, or the editor's built-in resources/app/extensions; built-in labels are
  "%…%" placeholders, so the id or file name is matched). Font: editor.fontFamily/fontSize/fontLigatures/lineHeight.
  Open at a line: `code -g file:line` (Cursor and Antigravity take the same).
- Rider: options/colors.scheme.xml names the scheme, colors/<name>.icls holds a user scheme's attributes
  (DEFAULT_KEYWORD, DEFAULT_STRING…); options/editor-font.xml the font. Open at a line: `rider64 --line N file`.
- Visual Studio: vswhere -latest -property productPath finds devenv; `devenv /Edit file` (no line from the command
  line). Its theme lives in the registry and .vstheme packages: KesherAI uses VS Dark's well-known colors.
Built (0.6.167): /api/ides, /api/ides/look, /api/ides/open; the code editor's toolbar picks a look and opens the file
at the cursor's line. Reads the editors' settings only; never changes them.
Stopped at: the touch editor (phone) keeps its own look; Visual Studio's real theme colors; extensions' semantic
token colors (semanticTokenColors) are not mapped.

### 2026-11-14 (later): checked on the PC (0.6.169)
- VS Code: its built-in "Default High Contrast" read whole (66 rules, hc-black) from the version folder.
- Antigravity: found, but its theme was not (no workbench.colorTheme set; its default may not be VS Code's "Default
  Dark Modern"): it gets a dark base. Stopped at: read Antigravity's own default theme name and folder.
- Wires: a click chooses them; a double-click reached the frame (pointer capture) and the reroute node's pins covered
  it: both fixed in 0.6.170.

## 2026-11-14: Dragging a variable onto the graph (Unreal's My Blueprint panel)
- Unreal: drag a variable from My Blueprint onto the graph → a small menu "Get X / Set X"; Ctrl while dropping = Get,
  Alt = Set; dropping it on a compatible pin makes the node and wires it (Get into an input, Set from an output).
- Built (0.6.172): the variables panel's rows drag onto the graph (Unreal Blueprints and C# scripts). In C#, a value is
  read where it is used, so Get is "drop it on a step's input" (the input becomes the variable); Set makes a Set step
  placed alone. On a phone, HTML drag does not work: the panel's "Set in the graph" button stays for that.
Stopped at: dragging onto a pin of the wrong type is not refused yet (Unreal shows a red "incompatible" tip).

## 2026-11-14: Command palette (board t41)
- Claude.ai and ChatGPT: Ctrl+K searches the chats. Linear and Raycast: Ctrl+K runs any action. Slack: Ctrl+K jumps to a
  conversation. VS Code: Ctrl+P files, ">" for commands. Shared: one box near the top, fuzzy match, groups (actions,
  places, recent), ↑↓ + Enter, Esc, a hint row; on phones a search button.
- Built: actions (new chat, new code session, updates, settings), every menu page (by its name in both languages and its
  address), the chats by title (the five latest when empty). The code editor keeps its own Ctrl+K. 🔍 in the top bar.
Stopped at: recent items first, plugin pages and settings sections as entries, a ">" commands-only mode.

## 2026-11-14: Context Sensitive (Unreal's action menu)
- Unreal: the "Context Sensitive" box (on by default) in the right-click menu; dragged from a pin, the menu lists only
  actions with a pin that can take that wire (same type, numbers convert, a child class into a parent), and the chosen
  node is wired at once. From an exec pin: impure functions, flow control, Set variables; events only from an exec input.
- Built (plugin 0.1.16): the menu sends the pin's type and direction; the plugin keeps only what fits (functions by
  their parameters and return value, Get/Set by the variable's type, Branch from exec or a bool output). The box is
  remembered. C# scripts: every step is a flow step, so their menu has no box.
Stopped at: a "wrong type" tip while dragging a wire onto a pin (Unreal's red "incompatible" note).
