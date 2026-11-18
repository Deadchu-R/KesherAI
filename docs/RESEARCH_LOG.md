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

## 2026-11-14: A receipt with "Undo all" after each agent run (board t42)
- Cursor: "Review changes" after an agent turn, accept/reject per file and Undo all; Copilot Edits: Keep / Undo per
  edit session; Windsurf: Revert to before a step; Claude Code: checkpoints (/rewind). Shared: the files and +/− lines
  right after the turn, one click back to before it, a warning when a file changed since.
- Built (0.6.174): a receipt event at the end of each run that changed files; "Undo all" puts them back as they were
  before the run, asking first about any file changed since; the earlier files are kept on disk (undo/<chat>/<run>)
  so it works after a restart (newest 30 runs, up to 20 MB each).
Stopped at: a diff view per file from the receipt, and undoing one file of a run.

## 2026-11-14: PC Health with AI (board t23): what was left
- Already built: the reading (drives, Windows.old, temp, KesherAI's folders, GPU, RAM, CPU, startup apps, a restart
  waiting), the rules' list, "Ask the AI" (the chat model rewrites it as a short plain-language list), Storage and
  "Fix it for me".
- Built now (0.6.175): the daily check from VISION: a fresh reading every 6 hours, a note only when something is bad
  or a warning is new, at most once a day, a bad thing again after 3 days; what was told is kept across restarts.
Stopped at: OneDrive's offline size; the note in the user's language (board t57).

## 2026-11-14: Collapse to Function; switching graphs by keyboard
- Unreal: select nodes → right-click → Collapse to Function: a new function graph holds them, a call node takes their
  place; each wire coming in becomes an input of the function. Switching graphs: the My Blueprint panel, tabs
  (Ctrl+Tab); Visual Studio and VS Code use Ctrl+PageUp/PageDown for tabs.
- Built (0.6.176) for C# scripts: steps one after another in the code become a private method; the method's
  parameters and earlier variables they read become its parameters; refused (with why) for steps apart, a return,
  yield, a variable made inside and used after, a "var" without a type, or a passed-in value the steps change.
  Ctrl+PageUp/PageDown switch the method's graph.
Stopped at: Collapse to Function for Unreal Blueprints (the editor's own command needs the open editor), and
Collapse Nodes (a collapsed graph, not a function).

## 2026-11-14: Vision for local models (mmproj)
- Found on the PC: the chat model (Qwen3.8-27B, unsloth GGUF) got the attached picture, but llama-server was never
  started with --mmproj, so no local model could see; the model tried to read pixels with Python for 16 steps.
- llama.cpp: a multimodal GGUF needs its projector (mmproj-*.gguf, in the same Hugging Face repository; LM Studio and
  Ollama load it automatically). Built (0.6.179): the engine passes an mmproj found beside the model; Models → 👁 checks
  the model's repository and downloads its mmproj (after a yes); a model without vision says so and points there.
Stopped at: offering 👁 at the moment a picture is attached to a model without vision.

## 2026-11-14: Plugins in their own process (board t39)
- From docs/DESIGN_RESEARCH.md §7 (VS Code extension host, ComfyUI's malicious nodes and registry rules, Open WebUI,
  Obsidian's move to automatic scans and declared access). Step 1 and 2 built (0.6.183).
- Node 20 (Electron 33) has --experimental-permission: fs read/write lists, child processes, workers, native addons;
  it has no network switch, so the runner replaces the network functions in Node's built-in modules (shared by
  require and import; syncBuiltinESMExports) and fetch/WebSocket before the plugin's code loads.
- The RPC: Node IPC with "advanced" serialization; tools, provider factories (a provider's optional methods learned
  from a sample instance; chat as a stream of events; chatWithTools' text as events; AbortSignal as a cancel).
Stopped at: steps 3–6 (declarative contributions loaded on first use, a scan on install, a public list, API promises);
the in-engine agents (Unreal/Unity, VISION) build on this sandbox.

## 2026-11-14: Pure nodes in the C# graph (VISION list item 4)
- Unreal: pure functions and getters have no exec pins and run when a value is pulled; a pure call's header is green.
  The Math Expression node (K2Node_MathExpression) turns typed text (`a + b * 2`) into a collapsed graph of pure
  nodes and keeps the text editable: the model taken here (the C# text stays the truth; the nodes are read from it).
- Unity Visual Scripting: every value is a data node; plain values sit inline on the ports (as defaults here).
- Built (0.6.184): csharp-expr.ts (parse/write, paths, Get/operator/call/Make nodes), "Values as nodes" toggle,
  connect/disconnect/delete/drop-a-variable on pure nodes rewrite the step's value.
Stopped at: typed pins (a type per member from the C# language server), splitting a pure node's output into
several uses (Unreal keeps one node per use too), and Unreal's own pure nodes in Collapse to Function.

## 2026-11-14: Resizing the Noctalia panel with the mouse (Roee's brother)
- Noctalia v4 (Quickshell, legacy-v4 branch): SmartPanel.qml recomputes the panel on onContentPreferredWidthChanged /
  HeightChanged, so a plugin panel can change its own size live. Built: corner grips (MouseArea, global pointer
  deltas), saved in pluginSettings, double-click for the default (plugin 0.1.1).
- Noctalia v5 (Luau, noctalia-docs declarative-ui.mdx): "Panel size is host-owned ... There is no setSize at runtime."
  Pointer down/move/up exist only on ui.pixelStream (needs a companion socket). A [[layer]] entry (plugin_api 36) can
  change width at runtime (noctalia.layer.configure), driven by a slider or buttons, not a drag.
Stopped at: which Noctalia the brother runs; for v5 the options are a layer with a width slider, or asking Noctalia
for resizable plugin panels.

## 2026-11-14: Controller and handheld gaming PCs (Roee's ROG Xbox Ally X)
- Steam Big Picture / Xbox app conventions: A choose, B back, X more, Y search, LB/RB tabs, Menu, View, right stick
  scrolls; a footer of button hints; bold focus. Spatial navigation (nearest control in the pressed direction), as
  TV and console web UIs. The browser's Gamepad API (standard mapping) reads XInput pads in Electron.
- Models: ROG Xbox Ally X RC73XA, ROG Xbox Ally RC73YA, ROG Ally X RC72LA, ROG Ally RC71L (rog.asus.com spec pages);
  Steam Deck Jupiter/Galileo; Legion Go 83E1. Read from the firmware's product name (registry / DMI).
- Built (0.6.185): gamepad.ts, PadHints.tsx, /api/system/device, the handheld look (bigger targets), 🎮 in the palette.
Stopped at: an on-screen keyboard for fields (Windows' touch keyboard opens on tap; with the controller only, Xbox
Game Bar's keyboard or Steam's), haptics on press (vibrationActuator), and per-page shortcuts (e.g. the graph editor).

## 2026-11-14: Game Helper (Roee: "a gaming AI helper; competitors surely did it")
- Xbox Gaming Copilot (Game Bar, Win+G; on ROG Xbox Ally): knows the game in front, voice mode, uses screenshots of
  the game so the player need not describe it, pinned widget, history and achievements, capture settings for privacy.
- NVIDIA Project G-Assist (Alt+G overlay, Llama-based 8B, RTX 12 GB+): system telemetry, FPS analysis, applies game
  settings, overclocks, plugins.
- Built (0.6.186): Ctrl+Shift+G takes one picture of the game in front and opens a window over it (one chat per game,
  so it remembers), questions on X / Y / RB, B closes; docs/GAME_HELPER.md (map an Ally back button to the key).
Stopped at: voice-only (push-to-talk) questions, the game's FPS/temperatures and recommended settings (G-Assist), a
controller combo read while the game has focus (XInput outside the browser), and achievements (Steam/Xbox APIs).

## 2026-11-14: IDE look, Antigravity and the phone editor (VISION list item 6)
- Antigravity (a VS Code fork) keeps its built-in extensions inside resources/app.asar (found on the PC: only
  app.asar.unpacked/node_modules is on disk), so the "Default Dark Modern" theme file was never found and the look had
  only a background. KesherAI runs in Electron, whose fs reads inside asar: that folder is searched too (0.6.189).
- The phone editor (CodeMirror) now wears the chosen IDE's colours (background, text, selection, cursor, line, gutter,
  font) from the same /api/ides/look, put on the open editor with a Compartment (undo history kept).
Stopped at: syntax colours on the phone need tags from @lezer/highlight (already in the tree under CodeMirror, but
not a declared dependency: asked Roee); Node's file sandbox for plugins is not available in Electron's Node
(plugins: process isolation and the network/program guards only).

## 2026-11-14: Controller navigation done right (Roee on the ROG Ally: "can't scroll, it chooses unrelated things")
- Norigin Spatial Navigation (concepts: focusable containers, saveLastFocusedChild, scoring along the direction plus
  the side offset, overlap preferred), "From TV to Touch" (input modes: 5-way vs pointer vs touch; the list scrolls to
  follow focus; restore focus to the opener and to the last place in a section).
- Built (0.6.190): areas (side menu, top bar, page, dialog) as boundaries with memory; edge-to-edge scoring with
  same-row/column preference; off-screen controls reachable and the view follows (smooth, centred when out of sight);
  long text without controls scrolls a page at a time; text boxes let the D-pad leave from their first/last line;
  regions that take focus (a whole list) are skipped; a real mouse move switches to pointer mode.
Stopped at: Roee checks it on the Ally another day.

## 2026-11-14: Phone Health with AI (VISION list item 7)
- Samsung Device Care (battery, storage, memory, security, one score, optimise), Pixel / Android 14 battery health
  (cycle count, state of health: the latter needs a system permission), AccuBattery (wear = what the battery holds
  now against its design capacity, from the charge counter; charging habits: heat near 100% wears it most).
- What a normal app can read: ACTION_BATTERY_CHANGED (level, temperature, health, voltage, cycle count on 14+),
  BATTERY_PROPERTY_CHARGE_COUNTER, the power profile's design capacity (reflection, most phones), thermal status
  (10+), battery saver, uptime, the security patch date.
- Built (0.6.191): those readings in the phone app; rules for wear (<88% / <80%), cycles (800+), hot full charge,
  phone heat, a week without restart, old security updates (90/180 days); the numbers shown; all sent to the
  plain-words AI list.
Stopped at: a history of readings (charging habits over days, as AccuBattery's), apps that use the most battery
(needs usage access), and a Phone Health page of its own on the phone's menu.

## 2026-11-14 (night): Muse-like tools and agents inside the engines (VISION items: Unity Muse's features, plugins as agents)
- Unity: Muse is deprecated; Unity AI (open beta, Unity 6.0+) has the Assistant with Ask / Plan / Agent modes (writes
  C#, changes scene components, makes prefabs; undo; permissions), Generators (sprites, textures, placeholder art,
  scene layouts from a reference, animation and sound from words; AI-generated metadata), an official MCP server
  (scenes, GameObjects, components, console, settings; no credits) and AI Gateway (the user's own Claude / GPT / Gemini
  subscriptions in the Editor). Whether AI Gateway takes a custom OpenAI-compatible address is not documented.
- Unreal: 5.8 ships an MCP plugin exposing Blueprints, assets, levels, materials and meshes to any model (Epic showed
  Claude driving a project); UE6 plans AI natively (lighting, rigging, skin weights, code). Third-party bridges abound
  (CodeFizz Editor Agent with 615 commands, VibeUE, Druids).
- KesherAI already has: both official MCP servers as presets (Unreal 127.0.0.1:8000, Unity's relay), its own bridges
  (graphs, play tests, builds), local image/sound/3D models.
Plan, in order (each needs the engine to compile and Roee to check):
1. An "Ask KesherAI" panel in each editor: Unreal: a Slate tab in the KesherAI Bridge plugin; Unity: an EditorWindow in
   the KesherAI package. It is a chat bound to a KesherAI chat with that project (the same agent and tools as the
   app), showing the steps, with the selection (actors, assets, nodes) sent as context. Plan / Agent modes = the
   chat's approval modes.
2. Generators from the panel with local models: sprites with a transparent background, tiling textures, sounds
   (ACE-Step), 3D from a picture (Hunyuan3D), imported into the project with an "AI-generated" tag.
3. Behavior trees / State Trees from words (Unreal), Behavior graphs (Unity) through the bridges.
4. KesherAI plugins can add panels and tools there (a plugin's "editorPanel" in its manifest).
Stopped at: building step 1 (needs compiling in Unreal and Unity on the PC, with Roee there).

## 2026-11-14 (night): Elegant icons and buttons, like Claude (Roee: "more elegant icons and buttons, like Claude")
- Claude.ai: flat, depth from contrast and hairline borders, not shadows; buttons 8 px radius, ~36–44 px tall, 500
  weight, a primary in one strong colour whose hover only shifts its shade; secondary is a transparent surface with a
  hairline border; a 2 px focus ring; icons are thin single-colour line drawings the colour of the text (the menu
  never mixes colourful emoji). Linear, VS Code and Notion's sidebars do the same (16–18 px, ~1.5 px strokes).
- KesherAI had colourful emoji for every page and menu action, buttons 40 px with a blue-tinted hover border and a
  glowing primary.
- Built (0.6.198): our own line icon set (57 drawings, 24 × 24, 1.6 stroke, round ends, ui/glyphs.ts) used everywhere
  an icon comes from a string (sidebar, menus, the palette, All tools, Appearance), mapped from the emoji we already
  had, so the user's own icons still win; Settings → Appearance → Icons: Line (default) / Emoji. Buttons: 36 px with a
  mouse (40 px for a finger), weight 500, a neutral hover, the primary's hover a brightness shift (any accent), no glow;
  icon buttons borderless as Claude's.
Stopped at: icons inside page bodies that are typed in place (status rows, cards with an emoji in their text).
Sources: webdesignhot.com design-md for claude.ai; Claude's own interface.

## 2026-11-15 (night): Fourth competitor review (Roee: "deep research on what the competitors have, add to the list")
- Read: LM Studio Bionic changelog (1.1.2–1.2.0), Open WebUI 0.11, Msty Studio 2.9, AnythingLLM 1.15, the new ChatGPT
  desktop app (GPT-5.6). Details and the 11 new items: docs/COMPETITORS.md "Fourth review".
- Strongest gaps: OS-wide helpers (dictation into any app, select text anywhere → action), file previews in chat,
  agent-sent notifications and timers.
Stopped at: Claude desktop, Cursor, Jan and LobeHub not re-read this round (reviewed in the third review).

## 2026-11-15 (night): DeepSeek V4 Flash on Roee's PC (board t59)
- Downloaded unsloth/DeepSeek-V4-Flash-0731-GGUF UD-IQ3_XXS (4 files, ~104 GB) to the models folder on E:.
- Step 1, the memory check (llama-fit-params via /api/models/fit): does not fit, twice (with Qwen3.8-27B loaded, and
  with nothing loaded). The PC has an RTX 3090 (24 GB) and 93.5 GB of RAM; with nothing loaded 21 GB of the card and
  ~55 GB of RAM were free (Unreal and other programs held ~35 GB), ~76 GB against ~104 GB. The plan puts 44 layers on the
  card and the experts of layers 6–43 in system memory, so most of the file would be read from disk on every token.
- Stopped there (loading it would page the disk and could freeze the PC overnight); Qwen3.8-27B loaded back.
- Fallback started (approved): unsloth/Qwen3.8-Flash-Next-GGUF UD-IQ3_XXS (125B MoE, 4 files, 83.6 GB).
Stopped at: the fallback's memory check, after its download. DeepSeek can be tried again with Unreal and other
heavy programs closed (it needs ~104 of the ~110 GB left after Windows).

## 2026-11-15 (night): Text Helper, select text in any app (COMPETITORS fourth review, item 2)
- AnythingLLM Magic Beacon (docs.anythingllm.com/pro/magic-beacon): a dot appears by any selection (macOS needs
  Accessibility and Input Monitoring); the panel has Edit actions in editable fields (fix grammar, simplify) and Static
  actions elsewhere (summarize, explain, translate, research), a custom prompt, Insert (replaces the selection) or Copy,
  Chat or Agent mode, a history of sessions, custom actions, and an "ignore this app" list. PopClip and Raycast: the
  same idea, a key or a selection gesture, actions, the result pasted back.
- Chosen for KesherAI: a key, not an always-on selection watcher (nothing is read until the user asks; no
  Input Monitoring). Ctrl+Alt+K (Control+Option+K on a Mac). Reading the selection = a Copy pressed after the user lets
  go of Ctrl/Alt, the clipboard put back (text, HTML, RTF, picture); Linux reads the PRIMARY selection with no key.
  The window opens by the mouse; actions: Summarize, Translate (Hebrew ↔ English), Fix mistakes, Simpler, Explain,
  Reply, and a free question; Copy, and Replace (pastes the answer in place, then the clipboard back). All questions
  go to one "✍ Text helper" chat. On the phone: "KesherAI" in Android's selection menu (PROCESS_TEXT) opens the same page.
Stopped at: custom actions, "ignore this app", and an Agent mode with tools (later items).
- Correction (0.6.201's new reason line): the empty memory check for Qwen3.8-Flash-Next was not the engine. KesherAI
  passed llama-server's `--checkpoint-min-step` to llama-fit-params, which refuses it, so the check failed at once for
  every Qwen 3.5+ model. Fixed in 0.6.202 (LlamaEngine.fitArgs). The engine (b12110) still needs checking for this model.

## 2026-11-15 (night): Agent notifications and chat timers (COMPETITORS fourth review, item 4)
- Open WebUI 0.11 (docs.openwebui.com timers and notifications): a `timer` tool with a prompt and a time (relative
  "in 2 hours" or an RFC 3339 time with a zone), one-shot, kept in the database (fires after a restart if it came due
  while down), waits while the chat is busy, runs with the settings captured when it was set; cancel only by
  `cancel_on` (the user reads or writes in the chat); no list of pending timers in the interface. A `notify` tool
  (message, title, target) to webhook targets; it ignores away-only delivery.
- Plan for KesherAI (better than theirs where they are thin):
  1. `notify_user` tool (title, message) through the existing Notifier (computer, phone, ntfy), opening the chat;
     at most one a minute per chat and 20 a day.
  2. `set_timer` tool (in: "45m" / "2h", or at: a local time; prompt; cancelOnReply default true) kept in
     timers.json; checked with Routines' 30 s clock; when due and the chat is idle, the prompt goes in as a
     "⏰ Timer" message and the chat answers; at most 10 waiting per chat, 30 days ahead.
  3. A visible list: waiting timers in the chat header with Cancel (Open WebUI has none), and on the Routines page.
Built (0.6.203): chat-timers.ts (set_timer, notify_user, timers.json, a 15 s clock), the clock button in the chat header with Cancel. Not yet: the Routines page list.

## 2026-11-15 (night): Dictation into any app (COMPETITORS fourth review, item 1)
- AnythingLLM Magic Echo (docs.useanything.com/pro/magic-echo): Alt+Z (Option+Z), quick mode sends after a pause,
  hold for long dictation with a Stop button, Esc cancels; a resizable widget; a local transcription model kept
  loaded a few minutes; text inserted at the cursor; Raw or Smart (the LLM fixes punctuation and grammar); custom
  vocabulary; voice-command snippets; optional screen awareness; history; macOS needs Accessibility.
- Chosen for KesherAI: Ctrl+Alt+D (Alt+Z opens the NVIDIA overlay, which Roee's PC has). A small bar at the bottom of
  the screen that never takes focus (so the text lands where the cursor was), a level meter and seconds; it stops on
  the key again, on 2 s of silence after speech, or at 2 minutes; Cancel. Whisper on this computer (the existing
  /api/speech/transcribe, language from Settings → Speech); pasted through the Text Helper's Paste, the clipboard put
  back. On the phone the keyboard's own voice typing already does this (not duplicated).
Stopped at: Smart cleanup with the chat model, vocabulary and voice-command snippets (later).
- Correction 2 (llama.cpp b12110's common/fit.cpp, read 2026-11-15): "successfully fit params" and each card's
  "N layers (M overflowing), X MiB used" line are trace-level now, so KesherAI read every plan as "does not fit".
  llama-fit-params prints the arguments only when it fits (otherwise "failed to fit CLI arguments … exiting").
  So DeepSeek V4 Flash and Qwen3.8-Flash-Next both DO fit the card (DeepSeek: 44 layers; Flash-Next: 49, experts
  in system memory). The real limit is system memory: ~104 GB and ~84 GB of files against ~55 GB of free RAM with
  Unreal and other programs open. Fixed in 0.6.206: the parser follows b12110, and "What fits?" adds the system
  memory the plan needs (`--fit-print on`, its Host line) next to the free RAM.
- Measured with 0.6.206 on the PC (Qwen3.8-27B loaded, Unreal open), system memory the plan needs vs free now:
  Qwen3.8-Flash-Next UD-IQ3_XXS 63.8 GB vs 38.7–39.1 GB; DeepSeek V4 Flash UD-IQ3_XXS 83.3 GB vs 38.7 GB (of 93.5).
  Flash-Next is realistic with Qwen unloaded and Unreal closed; DeepSeek only with almost everything closed.
  Not loaded tonight (it would page from the disk with Roee away). Next: Flash-Next's load and speed with Unreal closed.

## 2026-11-15 (night): Office files in the chat (COMPETITORS fourth review, item 3)
- LM Studio Bionic 1.1.8–1.1.9: previews of Word, spreadsheet, presentation, HTML, CSV and TSV files in the chat (and a
  draggable Canvas). Claude and ChatGPT: an attached file is a chip; the model reads xlsx/pptx/docx.
- Found in KesherAI: attachments (attachments.ts) read PDF, Word and text files for the model, but not Excel or
  PowerPoint (only the path reached the model); the user's bubble shows the raw "[Attached: …]" line.
- Plan, no new dependencies: (1) a small zip reader on Node's zlib (size limits against zip bombs) and readers for
  .xlsx (shared strings, sheets as tab-separated rows, capped) and .pptx (each slide's text), used by attachments and
  read_document; (2) attachment chips in the bubble that open a preview: table (xlsx/csv/tsv), slides (pptx), Word as a
  page (mammoth's HTML in a sandboxed frame), HTML in a sandboxed frame without scripts, pictures, PDF.
Built (0.6.207): office.ts (zip reader with limits, xlsxSheets, pptxSlides, docxHtml, csvRows), the preview route, and chips in the message with a preview dialog. Not yet: PDF as pages (shown as text), editing a sheet in place.

## 2026-11-15 (night): Routines on an event (COMPETITORS fourth review, item 8)
- ChatGPT's scheduled tasks (itbrief.co.uk, 2026): one-off, recurring and "monitoring" tasks, at most once an hour,
  that notify only when there is something to report; a Scheduled page to pause, edit, delete; no webhooks or real
  event triggers. KesherAI already had "quiet" heartbeats (the same idea as monitoring).
- Built (0.6.208), beyond it: "when a web page changes" (its text is read every N ≥ 15 minutes with no model; the
  routine runs only when it changed, with the lines added and removed), "when files change in a folder" (a watcher,
  20 s to gather, the names go with the routine), "when a download finishes" (optionally by name).
Stopped at: a timers list on the Routines page (the chat header shows them), and a run history per routine.

## 2026-11-15 (night): Remappable keyboard shortcuts (COMPETITORS fourth review, item 6)
- Open WebUI 0.11: Settings → Keyboard, click a shortcut and press the new keys, a warning on a clash, saved to the
  account, one-click reset, a master switch for when keys clash with the browser or the system. VS Code: the same, with
  a recorded key and conflicts listed.
- Built (0.6.209): shared/shortcuts.ts (the list, one spelling, the key's place so a Hebrew layout records "K",
  Electron's form, conflicts, cleaning), config.keyboardShortcuts, /api/settings/keyboard, the desktop app registers
  the global keys from it and reports a key another program holds; Settings → Keyboard with Change / Off / Default /
  "Everything back", a master switch for the in-app ones. A global key must have Ctrl, Cmd or Alt.
Stopped at: more in-app shortcuts (new chat, settings) to remap; they are added to SHORTCUTS when made.

## 2026-11-15 (night): Pictures in Knowledge (COMPETITORS fourth review, item 7)
- Msty Studio 2.9's Context Studio describes pictures and videos by visual analysis, tags them, and reads those first.
  KesherAI's Knowledge already searches every passage by meaning, but skipped pictures entirely (and Excel/PowerPoint).
- Built (0.6.210): pictures (png, jpg, webp, up to 8 MB) in a knowledge folder are described once by the chat model
  when it is local and has its vision file (mmproj), never a cloud model; 12 per pass, waiting while a chat works, the
  rest ten minutes later; "Picture <file>: <description>" is indexed and found like text, with the file as its source.
  .xlsx and .pptx are indexed too.
Stopped at: videos (a few frames each), and showing the picture itself in the search result.

## 2026-11-15 (night): A shared Canvas (COMPETITORS fourth review, item 9; board t73)
- LM Studio Bionic 1.1.6–1.1.7 (alphasignal.ai; lmstudio.ai changelog): an Excalidraw-based infinite board inside a
  project; shapes, arrows, text, freehand; stored as JSON so the agent creates, reads and changes single elements and
  their links; the user and the agent edit the same diagram live; export to PNG, SVG and editable .excalidraw; uses:
  mockups, architecture diagrams, process maps, a codebase drawn out, then "turn it into a plan or code".
- Two ways for KesherAI, a decision for Roee:
  A. Excalidraw itself (@excalidraw/excalidraw, MIT, ~2 MB, a new dependency: needs Roee's OK): the full editor at once;
     the agent's tool writes Excalidraw elements.
  B. Our own board on the BlueprintCanvas base (pan, zoom, drag, select already exist): rectangles, ellipses,
     diamonds, notes, text, arrows tied to elements; a `canvas` tool (add / move / change / link / delete / read, with
     an automatic layout so a small model need not place things); export SVG, PNG and .excalidraw JSON. No new package.
Stopped at: the decision (A is faster and fuller; B keeps the app small and matches KesherAI's look).
- 2026-11-15 morning: Roee chose A (Excalidraw). Technical research:
  - @excalidraw/excalidraw 0.18.1 (official, MIT, published 2026-04-20; peers React 17–19, we use 19). Fonts load from
    a CDN by default; KesherAI's CSP allows only its own files, so they are copied into the web build and
    `window.EXCALIDRAW_ASSET_PATH` points there. Loaded only on the Canvas page (lazy), so the app's start stays small.
  - Its Element Skeleton API (`convertToExcalidrawElements`): a shape needs only type, x, y; `label.text` puts text in
    it; an arrow's `start`/`end` take a shape's id and bind to it; `regenerateIds: false` keeps our ids. It runs in the
    browser, so the server keeps the model's additions as skeletons until the open page turns them into elements.
  - yctimlin/mcp_excalidraw (the best-known Excalidraw MCP): create/batch_create/update/delete/query elements, group,
    align, distribute, lock; a canvas server pushes changes to browsers over WebSocket, so the agent's drawing shows
    live. debu-sinha/excalidraw-mcp-server: batch_create_elements too.
- Design for KesherAI: a canvas belongs to a chat (and is listed on a Canvas page). One `canvas` tool for the model:
  read (shapes with their ids, text and links), add (shapes and arrows by id, text; positions optional, KesherAI
  places them in rows so a small model need not), change (text, colour), delete. The open canvas follows the chat
  live and saves the user's edits; export PNG, SVG and .excalidraw. Steps: server store + tool + tests; the page;
  the chat's Canvas button; phone check.
Stopped at: building step 1 (server store and tool).

## 2026-11-15 (night): server.ts split, first step (board t49)
- The training routes (routes/training.ts) and the reset routes (routes/reset.ts) moved out of createKesherServer,
  unchanged; server.ts 1,402 → 1,342 lines. The rest of t49 (remote/device keys, self-work wiring, the many service
  constructions) needs a context object passed to each area; next steps: remote and device keys, then self-work.
- 2026-11-15 morning (Roee approved continuing): B1 done — `server/options.ts` holds `KesherServerOptions`,
  `KesherServer` and `WEB_CSP` (re-exported from server.ts, so no other file changed); server.ts 1,279 → 1,205.
  B2 done too: `server/data-dir.ts` (`openDataDir`: "start over", the config, the paths, worker mode); 1,191 lines.
  B3, first part: `server/build-engines.ts` (nvidiaGpus, buildLlamaEngine, buildSdEngine, modelSize, amdCardOnLinux),
  same construction order; 1,139 lines.
  Stopped at: the rest of B3 — ComfyUI and the GPU guard need the notifier, runtimes and registry, so they move once
  B4/B5 give those a home; then B4 (`server/build-chat.ts`).
  B4, first part: `server/build-chat.ts` `addProviders` (the settings' providers, then auto-detected local servers);
  1,123 lines. Personas and skills moved too (`openPersonasAndSkills`); 1,115 lines.
  Stopped at: the conversation manager takes ~30 local services (search, Google, browser, speech, knowledge,
  computer control, Unreal…), so the next step is a typed context object built once and passed to the area
  builders (B4 rest, B5, B6) — design it first, then move the areas one by one.
  2026-11-15 late morning: the conversation manager moved to `server/build-conversations.ts` (`buildConversations`
  with a typed `ConversationParts`: 35 services, found with the TypeScript checker, the body unchanged; `mainSlot`,
  which a timer updates, passes as a function). server.ts 1,115 → 989 lines.
  B5, first part: `server/build-remote.ts` (`buildTunnel`: Tailscale or the Cloudflare tunnel; `watchDisk`: the
  full-drive warning); 968 lines. Stopped at: the notifier, Telegram, device keys and the access log need the
  conversation manager (late-bound through `services`): move them with a small `late` object next.
  Done the same day: `setupRemoteAccess` (access log, device keys, the auth hook, at its old place), `buildNotifier`
  and `buildTelegram` (they get the chats as a function, `() => services.conversations`, read when used); 927 lines.
  Stopped at: B6 (`server/build-extras.ts`: journal, computer control, Unreal, Unity, self-work, routines).
- Text Helper, later the same night: the user's own quick actions (as Magic Beacon's custom actions): Settings →
  Keyboard and helpers, a name and an instruction, up to 12, shown after the built-in ones. Still not built: "ignore
  this app" and an agent mode with tools.

## 2026-11-15 (night): As-you-type suggestions in any app (COMPETITORS fourth review, item 11)
- AnythingLLM Magic Tab (docs.anythingllm.com/pro/magic-tab): after a typing pause (750 ms recommended) a ghost
  suggestion appears by the cursor in any app; Tab accepts, typing on dismisses; "chaining" offers the next one; a
  model tier (default, lightweight, balanced, intelligent) downloaded in the background; ignored apps (terminal,
  games); macOS needs Accessibility and Input Monitoring (Screen Recording for on-focus suggestions); Windows needs no
  permission.
- What KesherAI would need: a low-level keyboard hook in every app (on Windows a resident helper with
  SetWindowsHookEx or UI Automation to read the text around the caret), a caret-anchored overlay window, and a small
  fast model always loaded next to the chat model (on the 3090 that takes card memory from Qwen). It reads everything
  the user types everywhere, so it needs its own clear on/off, ignored apps, and never a cloud model.
Stopped at: this assessment. Proposed order for Roee: (1) a small fast model's speed on the 3090 next to Qwen,
(2) UI Automation around the caret in Notepad, Word and Chrome, (3) only then the overlay. Not before the Canvas
and share-link decisions.

## 2026-11-15: closing the engine from KesherAI (save / don't save)

Asked by Roee after closing Unreal by hand. Looked at how others do it:
- ChiR24/Unreal_mcp: `unreal.SystemLibrary.quit_editor()` over Python; saves nothing first and answers "Quit command
  sent" before Unreal has closed.
- The `ue` editor tool (listed on policylayer): separate `save_dirty` and `stop_editor` ("gracefully") actions.
- Unity: `EditorApplication.Exit` quits at once and asks nothing, so the docs' own example saves the scene first.

What KesherAI does: one "Close Unreal/Unity" menu on the engine page with **Save and close** and **Close without
saving**. The choice is made in KesherAI, so the editor never shows a dialog (that dialog would be unreachable from
the phone). Saving stops if the game is playing in the editor or a file cannot be saved (the editor stays open). The
answer comes only once the editor process has really gone. Needs plugin 0.1.18 / Unity package 0.2.7; older ones say so.
Stopped at: done; nothing open.

## 2026-11-15: Share links (COMPETITORS item 10; board t74), Roee approved building it
- ChatGPT (help.openai.com 7943621): a personal account's link is a snapshot of the chat when made; later messages
  join only after "Update link" (same URL); links are anonymous; supported images and files can appear; all links are
  listed in Settings → Data controls → Shared links, deleted one by one or all at once; deleting the chat deletes the link.
- LibreChat (librechat.ai shareable links): a read-only snapshot up to the latest message; "Update link" republishes to
  the same URL; the user's name and custom instructions are left out; files only with a switch; visitors cannot reply.
- Open WebUI (docs chatshare): "Clone only" snapshot by default, sign-in required unless the admin allows "Open"
  sharing; a Shared Chats dashboard lists, re-copies and revokes links.
- KesherAI (designed earlier, COMPETITORS item 10, now confirmed): the user shares from the chat's ⋯ menu (never the
  model); a snapshot of the chat's messages (user and answers only: no tool steps, approvals or system text, files by
  name only, no paths) at `/s/<128-bit token>`, served as plain HTML with no app script, a strict CSP and noindex,
  reachable over "Access from anywhere"; 7 days by default (1, 7, 30 days or until revoked), "Update" refreshes the
  same link, a view count, and the list with revoke in Settings → Phone (remote).
Stopped at: building (store and public page first, then the chat menu and the settings list).

## Music in the chat: ACE-Step 1.5 (2026-11-15)

- **Gemini (Lyria 3, Feb 2026):** "Create music" in the chat: a prompt (genre, era, instruments, vocals), optional
  photo or video for the mood, lyrics of your own ("Lyrics:") or written for you; a 30-second track to play, download
  (MP3/MP4) and share. Lyria 3.5 later made full-length songs. Takeaway: one request in the chat, lyrics written by
  the model when not given, a player and a download; no separate music screen needed.
- **ACE-Step 1.5 (StepFun/ACE Studio, Jan 2026, MIT):** built into ComfyUI (`TextEncodeAceStepAudio1.5`,
  `EmptyAceStep1.5LatentAudio`); the turbo model in one file (`Comfy-Org/ace_step_1.5_ComfyUI_files`,
  `checkpoints/ace_step_1.5_turbo_aio.safetensors`), 8 steps, cfg 1, AuraFlow shift 3 (ComfyUI's template
  `audio_ace_step_1_5_checkpoint`); 10 s to 10 min; under 4 GB of VRAM; lyrics in 50+ languages in their own
  letters, Hebrew included (`he` in the node's list); bpm, key and time signature are inputs.
- **What KesherAI had:** make_music with the first ACE-Step (v1 3.5B, 2025): up to 4 minutes, 50 steps, lyrics only
  in Latin letters.
- **Built (0.6.231):** a ready-made ACE-Step 1.5 flow (first on the Nodes page); make_music uses it (language, length
  up to 10 min, optional bpm and key), and falls back to v1 only when v1 is already downloaded and 1.5 is not.
- **Tried on the PC (0.6.231):** a 40-second Hebrew pop song from a chat, about a minute including loading; the
  model wrote the lyrics in Hebrew and set language, tempo and length itself; the player works at phone width.
- **Cover art (0.6.232):** Gemini's songs come with AI cover art (Nano Banana), and so do Suno's. make_music now makes
  a square cover with the active image model (no words on it: image models misspell them), shown with the song;
  without a usable image model, or if it fails, the song comes alone.
- **XL + 4B planner (0.6.233), compared on the PC:** the same song, lyrics and seed with 1.5 turbo (21 s) and XL with
  the planner (18 s): no time cost. Roee's verdict on Hebrew, both versions: recognizably Hebrew, but it still sounds
  artificial (stress, vowels, the Israeli accent); he expects no music model to get those nuances yet. Kept XL as
  the default (no cost).
- **Stopped at:** Hebrew singing quality is the models' limit, not KesherAI's; revisit when a model with real Hebrew
  training appears (check ACE-Step releases and Lyria's API). Lyrics guidance in make_music stays (it helps any
  language).

## Graph wires like Electronic Nodes (2026-11-15)

- **Electronic Nodes (Unreal plugin, hugoattal, 3.24):** wire styles Default (bezier), Manhattan (right angles) and
  Subway (45°); a separate style for execution wires; rounded corners; a horizontal lead out of each pin; wire
  alignment left/right; ribbon (overlapping wires offset, not split when from the same node); bubbles (moving dots
  showing flow, on selection, with speed/size); per-graph activation and a master toggle shortcut.
- **UltraWire (StraySpark, UE 5.7):** the same styles plus chamfered corners, A* routing around node bodies,
  crossing markers, neon glow, an execution heatmap from the profiler, presets, per-graph profiles, a minimap.
- **Built (0.6.238):** `wire-style.ts` (curve / right angles / 45°, rounded corners, lead, behind-routing, ribbon
  lanes per wired output), bubbles on the chosen node's wires (off with reduced motion), a separate style for exec
  wires; a toolbar menu in every graph (Unreal Blueprints, Unity graphs, C# as nodes), saved in the look so the phone
  matches. Tests in `wire-style.test.ts`.
- **Stopped at / later:** routing around node bodies (UltraWire's A*), crossing markers, a minimap.

## Night of the redesign (2026-11-15)

- **@ menu (F17):** Claude, Cursor and Open WebUI open one list on `@` (models, files, knowledge). Built (0.6.239):
  models, knowledge bases and pages, 4 per group, keys at the bottom; a model pick switches the chat (one-turn
  model is later: the server's `send` has no per-message model yet).
- **Side chat (F3):** Claude's `/btw`, Open WebUI's `/side`: an aside that never enters the chat. Built (0.6.240):
  `/side` or `/btw`, or the chat's menu; read-only context, no tools, kept in memory only.
- **Model test (F11):** PocketPal and Locally Uncensored show speed and a small quality test. Built: 10 fixed
  questions at temperature 0 after the speed test ("8 of 10 right"). Not kept yet: shown once on the button.
- **Usage picture (F21):** Open WebUI 0.11 and GitHub: a grid of days. Built: 12 weeks, streak, days used.
- **Settings from the chat (F12):** Locally Uncensored 3.0.8 changes its settings from the chat with a confirmation.
  Built: `change_setting`, a short allow-list (meetings, notifications, dictation language, active models), always a
  card with old → new; remote access, keys and permissions never.
- **Updates without GitHub (asked 2026-11-15):** electron-builder's "generic" provider is a plain folder (or any web
  server) with `latest.yml`, the installer and its sha512; KesherAI's updater already reads exactly that from
  GitHub. Plan: a computer that builds (`pnpm dist` in the repo) serves that folder read-only at
  `/api/updates/feed/*` (latest.yml, the installer, the phone's APK; fixed names, no paths from a request), and other
  computers and the phone get a "where updates come from" setting (GitHub, or that computer through the existing
  device link). The sha512 check stays as it is.
- **Stopped at:** the local update source was planned; Roee said yes (2026-11-15 20:03, "keep GitHub too").
- **Built (0.6.245):** every computer keeps the last installer it downloaded and checked (`update-feed/`), and can
  also serve a build made on it (a folder with `latest.yml`, set on the updates screen, this computer only). It serves
  them read-only at `/api/updates/feed/<file>` (only names its feed lists, with ranges for the parallel download).
  Checking for updates asks GitHub and my other online computers (with their device token) and takes the newest; the
  sha512 check is the same. "Install when the computer is free" (Windows' active hours, VS Code's "update on
  restart"; here the signal is KesherAI's own work: chats, self-work, downloads) waits and installs by itself.
- **Not yet:** the phone app from a computer (its APK is built only on GitHub; a local Android build needs the SDK on
  the PC). Next: serve the APK through the same feed when a computer has one.

## Smart auto approvals, F10 (2026-11-15, evening)
- **Claude Code auto mode** (Anthropic engineering post): reads and in-project edits skip the classifier; everything
  else goes to it. It sees only the user's messages and the call, never tool output ("reasoning-blind"), so planted
  text cannot argue with it; it errs toward blocking; 3 denials in a row or 20 in total hand back to the person.
- **Codex auto-review (guardian subagent):** low and medium risk run, high needs the user's authorisation, critical is
  always denied; 3 denials in a row trip a breaker; denials go back to the agent with an anti-circumvention note.
- **Built (0.6.247):** in "auto-edit" chats, a plain command that would ask goes to the chat's own model first
  (ALLOW/ASK, 30 s, temperature as the chat). It sees the person's last three messages (without attachments) and the
  command, never tool output. Our reviewer never denies: its "no", an error or a timeout just asks the person as
  before, so no breaker is needed. Commands on the always-ask list never reach it. Each yes is a note in the chat.
  Off by default; turned on only from the computer (Settings → Privacy); off from anywhere; not settable from a chat.
- **Stopped at:** done. Possible later: a second, smaller model as the reviewer when F19's "beside" model is loaded.

## A model on the phone itself, F1 (2026-11-15, evening)
- **PocketPal AI** (open source): React Native, llama.cpp through `llama.rn`; any GGUF from Hugging Face, Q4_K_M
  advised for phones; per-model settings; benchmark screen. The common path for "any model" apps.
- **Google LiteRT-LM** (Google AI Edge, used by AI Edge Gallery): Kotlin/C++, `.litertlm` models from Hugging Face's
  `litert-community`; Gemma 4 E2B about 52 tokens/s on a Galaxy S26 Ultra GPU, NPU on Android; fast but few models.
- **For our app (Capacitor):** `llama-cpp-capacitor` (MIT): GGUF, streaming completion, embeddings, Android
  arm64/x86 `.so`; young package, no tested-model list. `@capgo/capacitor-llm`: LiteRT/MediaPipe and Gemini Nano
  where available, with download and progress events.
- **Recommendation:** llama.cpp (GGUF), the same model files as the computer, so a model can be copied from the PC
  over the device link instead of downloaded again; LiteRT-LM later as a "fast Gemma" option. Phone side: a small
  model (1–4B, Q4) chosen by the phone's RAM; the computer/phone switch's "on the phone" side turns on when one is loaded.
- **Found after:** the phone app already has it (`apps/android/www/local.html`, "On this phone"): GGUF models through wllama, Gemma 4 E2B/E4B through LiteRT on the GPU (`plugins/llm`), and models copied from the computer (`/api/models/phone`). No new dependency is needed; the audit's F1 note was out of date.
- **Stopped at:** done; nothing to build.

## Persona builder with web research (2026-11-15, evening; asked by Roee)
- **LobeHub** (agent market, "generate assistant"): a description becomes a system prompt, avatar and opening
  questions. **Character.AI / SillyTavern** card generators: name, persona, greeting, examples. None of them search the
  web first; for a real person, a game or a field, that is where the facts come from.
- **Built (0.6.248):** the builder already wrote name, icon, instructions, model and knowledge base. Now it can search
  first (on by default): the chat model picks up to three searches, KesherAI runs them with the user's web filter and
  reads the two best pages (3,000 characters each), and the notes go to the writer as data in a tag. It also writes a
  temperature and three opening suggestions. The draft shows the sources; nothing is saved until the user saves.
- **Stopped at:** done.


## Charts inside the answer, F18 (2026-11-15, night)
- **Claude (Mar 2026) and ChatGPT** draw charts inline from numbers in the conversation; **Open WebUI** renders
  Mermaid. A charting library or Mermaid is large; the audit's plan was a small JSON block drawn as SVG.
- **Built:** a ```chart block (`{type: bar|line|pie, title, labels, series, unit}`) is drawn as SVG by RichText,
  with a legend, hover values and "The numbers" as a table; while it is still being written, or if it is not a valid
  chart, it shows as code. One line in the system prompt tells every model about it. No new dependency.
- **Stopped at:** done; Mermaid only if Roee asks.

## LoRA browser, F5 (2026-11-15, night)
- **Locally Uncensored** has a LoRA browser; **ComfyUI-Lora-Auto-Trigger-Words** reads trigger words from CivitAI and
  the file's own metadata; LoRA stacks chain several with a strength each. CivitAI's public API: `/api/v1/models`
  (types=LORA, query, baseModels, nsfw, sort) and `/api/v1/model-versions/{id}` (files with SHA-256, `trainedWords`);
  some downloads need the user's key (`Authorization: Bearer`).
- **Built (0.6.252):** Images → Find LoRAs has a CivitAI tab (default) beside Hugging Face: search, base model, adult
  content off by default (and its pictures never shown), cards with a preview (through KesherAI, only from
  image.civitai.com), base model, size and trigger words. Download looks the version up again on CivitAI (never the
  page's address), checks the SHA-256, and keeps the trigger words beside the file; choosing the LoRA puts them in
  the prompt. Stacking with a strength per LoRA already existed. An optional CivitAI key (set on the computer only,
  stored encrypted) is used when a LoRA needs it.
- **Stopped at:** done; a key field in Settings is still to add (the route exists).

## PC health: every program and game, and speed up (2026-11-15, night; asked by Roee)
- **Android cleaners / CCleaner / Windows Storage Sense:** temporary files (older than a day), browser caches,
  graphics-card shader caches, crash dumps; browsers must be closed for their cache. **Playnite / GOG Galaxy** find
  games from each store's own files: Steam `libraryfolders.vdf` + `appmanifest_*.acf` (SizeOnDisk, LastPlayed), Epic
  `ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item` (InstallSize), Store/Xbox `Get-AppxPackage` (Xbox PC games
  in `XboxGames` measured on disk; WindowsApps cannot be read).
- **Built:** Programs shows games and Store apps with Windows' list (filters: all, games, programs, Store; last
  played); removing a game opens the store's own removal (steam://uninstall/<id>, Epic, Windows settings; fixed links
  only). "Speed up" measures temp files (older than a day), Chrome/Edge caches (only when closed), shader caches
  (NVIDIA, AMD, D3D, Steam), crash reports; cleans only what is ticked, skips files in use, keeps the folders.
- **Then built (Roee asked, 23:06):** emptying the Recycle Bin (size first), Windows Update's download cache
  (Windows' own administrator prompt; services stopped and started again), free memory (KesherAI's models; programs
  by memory, grouped, Windows parts and KesherAI never listed; Close asks the program first, force only after a
  second yes), and startup programs (listed; changed in Windows' own settings page).
- **Stopped at:** done; checked by tests, to be checked on the PC after the release.

## Phone health on the phone itself (2026-11-15, night; asked by Roee)
- **What Android allows an app:** list installed apps (QUERY_ALL_PACKAGES, a side-loaded app), games by
  `ApplicationInfo.category`, sizes and last use with StorageStatsManager / UsageStatsManager after the person turns
  on "Usage access"; uninstall only through Android's own window (ACTION_DELETE); other apps' caches only through
  Android's own "clear all caches" window (StorageManager.ACTION_CLEAR_APP_CACHE, Android 11+, needs "All files
  access"); ending only background apps (killBackgroundProcesses); the trash through MediaStore (Android 11+), emptied
  with Android's own confirmation (createDeleteRequest). Startup apps cannot be read.
- **Built:** a 🩺 Health tab on the phone's own screen (no computer needed): the numbers, Speed up (free memory, all
  apps' cache, KesherAI's cache, trash) and every app and game with size, cache and last use, Info and Remove. From the
  computer's PC health on the phone, "Apps and cleaning" opens it.
- **Stopped at:** written; checked with a mock at 390 px; the APK builds on GitHub; Roee installs it.

## Picture lanes and video from a picture, F4 (2026-11-15, night; Roee approved the download)
- **Locally Uncensored (Create)** puts actions on each picture: inpaint, remove background, upscale, to video.
  **ComfyUI's template** `video_wan2_2_5B_ti2v`: UNETLoader (wan2.2_ti2v_5B), CLIPLoader umt5 (type wan), Wan 2.2 VAE,
  Wan22ImageToVideoLatent (1280x704, 121 frames), ModelSamplingSD3 shift 8, KSampler uni_pc 20 steps cfg 5,
  CreateVideo 24 fps, SaveVideo. The 14B I2V needs two 14 GB models (high and low noise): too big for one 24 GB card
  without offload; the 5B does picture-to-video and text-to-video in one.
- **Built:** under every result on the Pictures page: Remove background, Make 4x larger (the batch tools, ready to
  run) and Animate (the Nodes page opens the Wan 2.2 5B flow with the picture already in it). The flow is also in the
  Nodes page's ready-made list. Downloaded tonight: the 5B model (10 GB) and the Wan 2.2 VAE (1.4 GB); the text
  encoder was already there.
- **Stopped at:** built; to check on the PC once the download ends (one short video at a smaller size first).

## F23: phone "Tasks" view of what runs on the computer (2026-11-16)

- AgentsRoom (mobile companion) and amux (mobile PWA): one list of all agent sessions, a live status dot each,
  a peek at the output, approve / stop / continue from the phone, real-time sync.
- Built: `#/tasks` (menu → Work → Tasks): chats answering or waiting, approvals (once, not twice), self-work, active
  downloads with progress and Pause, running routines, long builds, an update in progress. Green dot = running,
  amber = waiting for you. Polls every 4 s while visible; each part read on its own so an older computer still shows
  the rest. Works the same in remote (the phone shows the computer's pages).
- Stopped at: no peek at the output inside the list (Open goes to the chat); no push of the list itself.

## C5: an on-screen keyboard for the controller (2026-11-16)

- Windows 11's gamepad keyboard (Insider 22635.4145, rolled out 2025): keys realigned for the D-pad; X backspace,
  Y space, Menu enter. Steam Big Picture: its own keyboard over the field, B closes.
- Built (`pad-keyboard.ts`): A on a field other than the chat box opens it (the chat box keeps A = send, R3 = mic).
  D-pad moves (wraps, keeps the column; in Hebrew left and right follow the reading side), A types, X deletes, Y space,
  Menu = Enter (a form is sent), B closes, LB Hebrew/English, RB capitals → symbols. Types through the field's value
  setter + input event so React sees it. Phone width: keys share the row.
- Stopped at: no caret moving with the triggers; no word suggestions.

## Students: AI study helpers on a modest laptop (2026-11-16)

- Lecture apps students rate (scholarly.so review, 2026): Scholarly (live transcript, notes, flashcards, quizzes,
  chat over the recording, timestamps), Knowt, StudyFetch, Turbo AI, NotebookLM / Gemini Notebook (cited Q&A over
  uploads), Otter (transcript, summary, chat), Genio (slides beside the audio, Quiz Me). Valued: live notes,
  timestamps to jump back, flashcards/quizzes, slide capture, Q&A grounded in the lecture.
- Speech on a weak laptop (openwhispr model sizes): tiny ~0.27 GB, base ~0.39 GB, small ~0.85 GB RAM; on a laptop
  i7 small runs about 0.4× real time (fast enough live), medium is slower than real time. Hebrew accuracy must be
  tested on our own audio.
- Avatar in Zoom: Pickle (5-minute training video, avatar lip-syncs live to your voice, replaces the camera);
  HeyGen / Akool live cameras; Zoom's own avatars. Open question: shown as present while not there.
- Stopped at: no hands-on test yet; next is a 30-minute Hebrew lecture through whisper small int8 on CPU.

### Students, part 2: how the leaders build it (2026-11-16)

- **Glean (lecture notes, used by disability services at many universities):** text notes timestamped to the audio
  (click a note → jump to that second); slides/PDF imported beside the recording, text pulled from slides into notes;
  one-key labels during the lecture ("Important", "Review") and headings; live captions while recording; playback
  highlights the current word; AI Outline splits the transcript into themes; "Quiz Me" multiple choice; works offline
  (records offline, syncs later); focus timer and reading view. → For KesherAI: the label keys and note↔audio sync
  are the core; everything runs locally anyway.
- **NotebookLM / Gemini Notebook:** everything grounded in the user's sources with inline citations; Audio Overviews
  (two hosts discuss the material), Video Overviews, mind maps, flashcards and quizzes only from the sources, study
  guide (key terms, sample quiz with answers, essay questions), "Guided Learning" mode; free tier 50 sources per
  notebook, 10 quiz/flashcard sets a day. → KesherAI has knowledge bases and TTS already: a per-course notebook with
  cited answers (lecture minute or PDF page), flashcards/quiz/mind map from it, and a two-voice audio recap.
- **Khanmigo and university tutors:** ask what the student already knows first; one step at a time, never the whole
  solution; may confirm whether an answer is right without giving it; short replies (~100 words); the tutor's
  instructions hidden and fixed; a study found unrestricted ChatGPT raised practice scores but lowered closed-book
  results. → A "Tutor" persona with these rules, switchable per course.
- **Spaced repetition: FSRS (Anki's default scheduler since 23.10):** per card stability, difficulty and
  retrievability; schedules for a target retention (e.g. 90%); about 25% fewer reviews than SM-2 for the same
  retention; open-source implementations exist (open-spaced-repetition). → Use FSRS for KesherAI's flashcards and keep
  Anki export (.apkg or CSV).
- **Modest laptops:** whisper small int8 on CPU for live captions; summaries/flashcards with a 1–4 B model in Q4 in
  the background after the lecture (not live), or a cloud key when the user has one; nothing needs a graphics card.
- Stopped at: Hebrew accuracy of whisper small/base on a real lecture; which 1–4 B model writes good Hebrew
  flashcards; FSRS library licence check before adding a dependency (ask Roee).

## F15: MCP Apps — a tool's own view in the chat (2026-11-16)

- Spec (extension "io.modelcontextprotocol/ui", protocol 2026-01-26; hosts: Claude, Claude Desktop, VS Code Copilot,
  M365 Copilot, Goose, Postman, MCPJam): a tool names a `ui://` resource in `_meta.ui.resourceUri`
  (`visibility: ["app"]` keeps a tool for the view only); the resource is `text/html;profile=mcp-app` with optional
  `_meta.ui.csp` (connectDomains, resourceDomains) and `prefersBorder`. The host shows it in a sandboxed iframe and
  talks JSON-RPC over postMessage: the view sends `ui/initialize` → host answers hostInfo/hostCapabilities/
  hostContext → view sends `ui/notifications/initialized` → host sends `ui/notifications/tool-input` then
  `tool-result`; the view may send `tools/call`, `ui/open-link`, `ui/message`, `ui/update-model-context`,
  `ui/request-display-mode`, `ui/notifications/size-changed`; teardown is `ui/resource-teardown`. Default CSP: nothing
  from outside; no blob:.
- Built: the client declares the extension at `initialize`; tools with `visibility: ["app"]` are hidden from the
  model; an MCP tool with a view returns it with its input and result (≤ 512 KB) on the step; the chat shows
  `<McpAppView>` under the step: `sandbox="allow-scripts"` only (opaque origin), a CSP meta put first in the head
  with only the server's named https domains, messages accepted only from that frame's window, height from
  size-changed (60–800 px). The view can call only its own server's tools (`/api/mcp/servers/:id/app-call`); a tool
  not marked read-only needs the person's yes in the chat; links: https only, opened in the browser; `ui/message`
  puts text in the message box (the person sends it).
- Stopped at: no fullscreen/pip display modes; `ui/update-model-context` is acknowledged but not given to the model;
  not tried with a real MCP App server on the PC yet.

### Students, part 3: a nursing student (2026-11-16)

- Who: Roee's friend, first year of nursing (Israel); laptop + Android phone; lectures in Hebrew, terms and drug
  names in English.
- What nursing students use (scholarly.so 2026 review): UWorld / Kaplan for NGN-style case questions and
  prioritisation; Picmonic visual mnemonics for drug side effects and lab values; Quizlet for quick normal ranges
  (community decks vary in accuracy); Anki for spaced repetition; course-specific tools built from her own lectures
  (Scholarly). Gaps the review names: dosage calculations, care plans, clinical notes, terminology.
- Plan for KesherAI: phone records in class → laptop transcribes and summarises; glossary Hebrew–English; drug cards;
  medication calculations computed by code with steps (safety: the model never does the arithmetic); lab values;
  nursing-process notes without identifiers; licensing-exam practice.
- Hebrew speech: ivrit-ai publishes Hebrew-tuned Whisper models (turbo, CTranslate2/ggml); to test on a real
  lecture against whisper small. Stopped at: no test yet.

### Students, part 4: everything on the phone, no computer (2026-11-16)

- Already on the phone app: on-device chat models through MediaPipe LLM Inference and LiteRT-LM (Gemma-class), the
  system speech recognizer (short phrases only: not for a 90-minute lecture), local web pages (local.html).
- Speech on the phone: Qualcomm's Whisper-Small on the NPU (QNN): encoder 65–86 ms and 8–10 ms per token on
  Snapdragon 8 Elite / 8 Gen 3 per 30-second piece, about 1.5–2.5 s per piece → a 90-minute lecture in roughly 5–8
  minutes. 8 Gen 1: encoder 176 ms, 14.5 ms per token. Only on Snapdragon; other phones need whisper.cpp on the CPU
  (much slower; fine while charging). Hebrew: ivrit-ai publishes Hebrew Whisper large-v3 and turbo (0.8 B; ggml,
  ONNX, CT2), too heavy for live use on a phone; community Hebrew-tuned small models exist (quality unknown).
- Summaries, flashcards, quizzes: a 2–4 B model on the phone (chunked: a lecture is ~15k tokens); medication
  calculations and FSRS are code; "ask the course" by word search (BM25) on the phone.
- Plan: phone-first study mode with three levels — (1) phone only, (2) with a laptop for better Hebrew and faster
  work, (3) a cloud key when she has one. Needs a native speech engine in the app (whisper.cpp or Qualcomm's
  runtime): a new dependency, to ask Roee. Test phone: Roee's OnePlus 13 (Snapdragon 8 Elite, 16 GB).
- Stopped at: no hands-on test; Hebrew accuracy of small vs turbo on a real lecture is the open question.
- Update (2026-11-17): settled in practice: Hebrew uses ivrit-ai's large-v3-turbo (whisper.ts) where it runs well, the general turbo elsewhere; the first setup offers it with its size. A side-by-side on a real lecture is still not done.

### Students, part 5: "how do I learn best?" and how the competitors personalise (2026-11-16)

- Learning styles (VARK and the like): people do have preferences, but the "meshing" claim — teach each person in
  their preferred style and they learn more — has failed every proper test since Pashler et al. 2008. Reviews:
  Frontiers in Psychology 2018 (fpsyg.2018.01538), Frontiers in Education 2023 (feduc.2023.1147498), Frontiers in
  Psychology 2024 (fpsyg.2024.1428732). So a quiz that labels her "visual" and then shows only pictures would not
  help, and could make her skip what works.
- What does work for everyone (Dunlosky et al. 2013, Psychological Science in the Public Interest): practice testing
  and distributed (spaced) practice rate high; elaborative questioning, self-explanation and mixing topics rate
  moderate; highlighting, rereading and summarising alone rate low. Mayer's multimedia principles: words + a matching
  picture beat words alone (dual coding), for everyone.
- What the competitors personalise (none of them sorts people by style; all measure answers):
  - Duolingo Birdbrain: predicts whether this learner gets this exercise right, from everyone's answers; the
    session generator picks exercises at the right difficulty; A/B tests showed more learning and engagement.
  - Quizlet Learn: a memory model (logistic regression → "recurrent power law") over answer history and time
    between answers decides what comes next; works offline.
  - Anki (FSRS) and Brainscape (self-rated confidence 1–5): scheduling by how well each card is remembered.
  - NotebookLM (now Gemini Notebook): many formats from the same sources — audio and video overviews, mind maps,
    flashcards with "got it / missed it" reruns, quizzes (multiple choice, short answer, fill in), infographics,
    slides, study guides; the learner chooses the format, nothing measures which works.
  - YouLearn: weak spots from quiz and test results; StudyFetch: live lecture notes, a tutor (Spark.E) from her
    material, an AI study calendar; Mindgrasp: live lecture recording, flashcards, quizzes; Khanmigo: Socratic
    tutoring; Osmosis (nursing/medicine): videos + flashcards + question bank.
  - Gap nobody fills: measuring, for this student, which format (diagram, text, audio, worked example, explaining
    back in her own words) leads to better recall on the later quiz — and doing it on her own devices.
- Our design ("what works for me", evidence-based): every topic is offered in several formats; each card and quiz
  question remembers which format she studied it from; FSRS recall later (1, 3, 7… days) is compared per format and
  per kind of material (anatomy, drugs, processes, calculations), with enough answers before saying anything (at
  least ~20 per format, shown with how sure it is). It suggests a mix ("for drug mechanisms, diagrams + explaining
  back helped you most") but never drops retrieval practice, spacing or words-plus-picture. A short start-up
  questionnaire records what she prefers — used only for the first suggestion, then replaced by her own results.
- Stopped at: design only; the format comparison needs weeks of her real answers before it says anything.

### Students, part 6: every field of study (2026-11-16)

- What exists: general AI study apps (StudyFetch, Knowt, Quizlet, NotebookLM, YouLearn) treat every subject the same;
  subject tools are separate apps — Wolfram Alpha computes math, physics and chemistry step by step ("doesn't guess —
  it computes"); Anki is the usual pick for content-heavy medicine, law and languages. None of the reviews found an
  app that recognises the field by itself and changes its tools.
- Ours: KesherAI recognises the course's field from its name, lecture titles and the start of each lecture (Hebrew
  and English words, Hebrew one-letter prefixes allowed); the student can choose it instead. The field steers every
  summary, card and quiz (law: exact section and case names; engineering and math: formulas with units, worked steps;
  CS: code and complexity; psychology: theory, researcher, study), and only nursing and medicine get the drug cards,
  lab values and medication calculations.
- Stopped at: keyword recognition and prompt hints are in; field-specific tools beyond nursing (a computed math
  checker like Wolfram's, statute look-up for law) are not built.

### Students, part 7: the avatar camera (2026-11-16)

- Pickle (YC): a "body double" that replaces the Zoom camera; lip sync from the live voice in under 0.3 s; a short
  training video of the person; cloud.
- Open models: MuseTalk (Tencent, MIT; ~4 GB VRAM fp16; 30 fps+ on a V100, far slower on a laptop GPU: an 8 s clip
  took ~5 min on an RTX 3050 Ti), LivePortrait (portrait animation, near real time on a strong NVIDIA card; its face
  detector's weights carry their own licence), Duix-Avatar (RTX 4070-class, 12 GB), daVinci-MagiHuman (15 B, H100).
  None is real time on a modest laptop without a graphics card.
- Virtual camera on Windows: softcam (MIT, a DirectShow filter DLL: `scCreateCamera`, `scSendFrame`; Zoom and Teams
  read DirectShow cameras) or Windows 11's Media Foundation virtual camera (`MFCreateVirtualCamera`, needs a signed
  media source). Either is a native piece in the desktop app: a new dependency to ask Roee about.
- Design (most realistic, and it runs on any laptop): the student records a few minutes of herself sitting and
  listening; KesherAI loops it seamlessly (cross-fades at matching frames, small natural movement) as the virtual
  camera; when she unmutes to speak, it switches to her real camera (or, on a computer with a strong NVIDIA card,
  lip-syncs the loop to her live voice with MuseTalk/LivePortrait). A warning before first use: if the course or
  university finds out, it may be treated as breaking its rules.
- Stopped at: research only; waiting on Roee for the virtual-camera dependency.

## Students, part 8: lip sync for the avatar when the student is not in front of the camera (2026-11-16, started)

- Candidates found: MuseTalk (TMElyralab, MIT, real-time 30 fps+ on a V100-class card, latent-space inpainting of the
  mouth area from audio, 256×256 face region), LiveTalking (lipku; wraps MuseTalk / Wav2Lip / ER-NeRF with WebRTC
  and a virtual camera output), LatentSync (ByteDance, higher quality, not real time).
- MuseTalk details: works from a reference video of the person (an "avatar" is prepared once from it: face crops,
  latents, masks), then streams: audio in, mouth region repainted per frame; no training per person. ~4 GB VRAM in
  fp16; 30 fps+ on a V100 (an RTX 3090 is similar), but an RTX 3050 Ti laptop took ~5 minutes for an 8 s clip
  (far from real time). Code MIT; it also needs Whisper (MIT), sd-vae-ft-mse (CreativeML OpenRAIL-M: commercial
  use allowed with use restrictions), DWPose and a face parser, and Python with PyTorch + CUDA (several GB).
- When it would run for us: the student is away from the camera, so she is usually silent; lips matter only when she
  answers by voice from elsewhere (the phone's microphone while the laptop shows the avatar). Real time needs an
  NVIDIA card of RTX 3060 class or better; most students' laptops (Intel, small GPUs) cannot.
- Conclusion: worth it only as an optional download on strong NVIDIA computers, and it adds a Python + PyTorch
  runtime (a new dependency: needs Roee's yes). Without it, the avatar stays the recorded idle loop (already built).
- Roee chose both: the light look-alive layer for every laptop (done: uneven jumps, breathing, sway, grain) and
  MuseTalk as an option on strong NVIDIA cards.
- MuseTalk 1.5 measured on Roee's RTX 3090 (2026-11-16, Windows, Python 3.10 venv, torch 2.0.1+cu118, with
  KesherAI's chat model holding ~15 GB of the card): avatar preparation from a 268-frame video ~1.5 min (once);
  first clip 200 frames in 8.7 s (23 fps, with warm-up), then 1500 frames in 35.6 s = 42 fps; audio features 40 ms
  per clip once warm. Real time (25 fps) holds with room to spare.
- Windows setup pitfalls found: mmpose needs chumpy built with --no-build-isolation; setuptools < 70 (pkg_resources);
  the s3fd face detector's own site did not answer (an identical copy, sha256 619a316812…, is on HuggingFace
  chunyu-li/face-alignment); PYTHONIOENCODING=utf-8 (it prints Chinese characters); the realtime script asks y/n.
- ScrumSurvivor end to end: the microphone goes through a speech detector; silent → an idle compositor (recorded
  clips + breathing, sway, blinking, sensor noise); speaking → Wav2Lip on a fixed 96×96 face crop over a still
  background photo, smoothstep cross-fades between the two; video 1280×720 at 25 fps to OBS Virtual Camera; the voice
  goes through VB-Audio Virtual Cable, held back in a ring buffer by the video's processing time (265 ms), and Teams
  listens to the cable, so lips and voice arrive together.
- Stopped at: design written (docs/REDESIGN_PLAN.md, "Avatar lip sync"); one choice is Roee's: hold the voice back
  through a virtual audio cable (VB-Cable: another install and Windows prompt, lips exactly in time) or not (nothing
  more to install, lips ~0.3 s behind the voice).

## Students, part 9: what competitors give students that KesherAI does not yet (2026-11-16)

- Sources: fast.io "Best AI study tools 2026" (Anki, Knowt, Gemini Notebook, RemNote, Quizlet, ChatGPT Study Mode,
  Studdy, Speechify…), YouLearn and Dupple round-ups.
- Already in KesherAI: flashcards from her material on FSRS, auto-graded practice tests (licensing style), a tutor
  answering only from her lectures, summaries, terms, a diagram, camera/photo input, PDF/PowerPoint/Word, an exam
  plan, "what works for me" by format.
- Gaps, by value for a nursing student who commutes:
  1. Audio overviews (Gemini Notebook, Speechify): a short spoken review of a lecture, to listen to on the bus.
  2. Sharing with classmates (Quizlet sets, Knowt imports): send a course or its cards as one file; open it on her
     phone or another student's KesherAI.
  3. Study mode / Socratic questioning (ChatGPT Study Mode, Khanmigo): the tutor asks her, waits, then corrects.
  4. Explanations for missed cards (RemNote): after "again", a one-line why.
- Decided: build 1 and 2 now (both work on the computer, in remote and in the phone app), then 3 and 4.
- Stopped at: built (0.6.301), on the computer, in remote and on the phone; sessions sync with Study.

## Students, part 10: studying on the phone with no computer (2026-11-16)

- Sources: App Store listings for offline flashcard apps (Qsets, QuickStudy, Studycards AI, Mnemesia) and RemNote's
  offline mode page. The offline apps review cards with no internet, but making cards from a PDF or slides needs
  their cloud AI; RemNote works offline but imports and AI need a connection.
- KesherAI's phone app already makes cards, summaries, terms, quizzes and tutor answers with a model on the phone.
  The gap was reading the material: slides, PDFs, Word and photos went to the computer.
- Built: slides, Word and PDF with text are read on the phone itself (the computer's reader, bundled); a photo of
  the board is read by the phone's own model when it sees pictures (Gemma 4, or her internet model). Only scans with
  a text-blind model still need the computer.
- Stopped at: built (0.6.290); next on the student list: study mode and explanations for missed cards.

## Phone app, part 11: the chat screen and the chat list in competitors' phone apps (2026-11-16)

- Sources: AI UX Playground's composer comparison (ChatGPT, Claude, Perplexity, Gemini), Pratt IXD's critique of
  the Claude phone app, Setproduct's AI chat anatomy.
- Top bar: menu at the start, the model picker in the middle (Claude, ChatGPT), new chat at the end.
- Composer: a calm card; one + holds attach, camera, tools and modes (ChatGPT, Claude, Gemini); web search as a
  chip only in Perplexity. Mic sits beside send; the critique faults Claude for two mic icons and a vague waveform
  icon, so one dictation mic plus one clearly different live-voice button.
- Messages: her messages in a bubble, the model's as plain full-width text with copy, listen, retry and more under
  it; stop replaces send while answering.
- Chat list: search on top, pinned first, grouped by day; long press for pin, rename, share, delete and selecting
  several.
- Ours adds: where it runs (phone, computer, internet) under the model name and on each chat, "continue on the
  computer", and "from Study" in the + sheet.
- Designed (5 boards in the design doc, row "מסך הצ׳אט ורשימת הצ׳אטים"); waiting for Roee's review before building.
- Stopped at: designed; not built.

## Students, part 11: a focus timer with study streaks (2026-11-16)

- Sources: CrocLab's 2026 study-timer comparison (Forest, Focus Keeper, Tide, FocusCroc), Toolfinder and Habi
  round-ups.
- Forest: a tree grows while you focus, an app blocklist; no day streak. Focus Keeper: Pomodoro with custom
  lengths, daily/weekly/monthly charts, badges, no streaks. Tide: timer with calm sounds. FocusCroc: day streaks
  with "streak shields" that protect the chain on a missed day, a calendar of check-ins, evening reminders.
- Complaints: streaks without a safety net feel punishing; subscriptions; no link to what was studied.
- Ours: Pomodoro presets (25/5, 50/10) and a custom length, tied to a course (optional); a day counts when she
  focused or reviewed cards; one free missed day a week keeps the streak (a shield, no guilt); this week's minutes
  per day; a notification when the time is up. Works on the phone with no computer and on the computer; sessions
  sync with the rest of Study.
- Stopped at: built (0.6.301), on the computer, in remote and on the phone; sessions sync with Study.

## Students, part 12: homework help step by step (2026-11-16)

- Sources: FutureEd and KQED MindShift on a Khanmigo study, Hechinger Report, Campus Technology on ChatGPT's study
  mode.
- Khanmigo never gives the answer, only questions and hints; in the study most students tried to get the answer,
  and when it held back they mostly stopped using it. Khan now offers help right after a wrong answer and lets
  assisted redos count. ChatGPT's study mode guides with questions but can be switched off at any time.
- Ours: a third tutor tab, "Homework: step by step": she pastes the exercise; the tutor says what it asks and asks
  what she tried (or gives the first step), checks each step she writes, gives one hint at a time ("Hint"), and the
  full worked solution whenever she asks ("Full solution"), so she is never stuck behind a wall. Her lectures are
  used when they help. Computer, remote and phone.
- Stopped at: built (0.6.302).

## Students, part 13: "explain this" in a lecture (2026-11-16)

- Sources: Adobe's Acrobat AI Assistant (answers from the PDF with citations, summaries, education help pages),
  Macro's AI PDF reader round-up, Wondershare's student summarizers.
- PDF readers answer about the whole file; the step students use most in reading apps is selecting a hard sentence
  and asking what it means, simpler, or for an example, then keeping it.
- Ours: select words in a lecture's summary or full text; a box offers Explain, Simpler and Example (the lecture
  is given as context), and To a card keeps the selection and its explanation as a flashcard. Computer, remote and
  phone (the phone's own model).
- Stopped at: built (0.6.303).

## Students, part 14: live captions and translation during a lecture (2026-11-16)

- Sources: Soniox's Hebrew lecture captions page, Microsoft's live captions in OneNote, Sonix and X-Doc round-ups,
  SyncWords for education.
- Others caption live and translate into many languages, mostly in the cloud and by subscription.
- KesherAI already captions every half minute while recording (on the computer's speech engine or the phone's own).
  Added: "Live translation: off / to English / to Hebrew" in the lecture recorder; each piece is translated by the
  chat model (the computer's, or the phone's own) and shown under the transcript, a few seconds behind; the lecture
  keeps the original. Computer, remote and phone.
- Stopped at: built (0.6.304).

## Students, part 15: practice from past exams (2026-11-16)

- Sources: YouLearn's 2026 round-ups (practice exams from uploaded material, scored, weak spots), StudyFetch and
  Knowt reviews.
- Others make practice tests from course material; none we found takes the course's own past exams as the model
  for style and difficulty.
- Ours: "Past exams" under the quiz: add one from a PDF, Word file or photo (read once; on the phone itself when it
  can); "Like the past exams" writes a timed 20-question test from her lectures in their style, length and
  difficulty (not copying their questions). Synced between phone and computer.
- Stopped at: built (0.6.305).

## Students, part 16: the syllabus (2026-11-16)

- Sources: DormWay's syllabus-to-calendar guide and planner round-up; App Store syllabus scanners (Sylly, Semora,
  SyllySync, CourseLink).
- They read exams, assignments and recurring items from the syllabus (OCR for scans), show a review screen before
  saving, and sync a calendar; a one-time import goes stale when dates move (re-import).
- Ours: "Syllabus" on the course: from a PDF, Word file or photo; the model finds exams, assignments and each
  week's topic; she sees them and can remove wrong ones before saving; the next exam becomes the course's exam
  date when none is set; the course then shows this week's topic, the next exam and what is due in three weeks.
  A new syllabus replaces the old one. Computer, remote and phone.
- Stopped at: built (0.6.308). Next: phone reminders the day before an assignment or exam.

## Students, part 17: the night's extras, compared (2026-11-16)

A 2026 round-up of study tools ([Dupple, "The 9 best AI study tools in 2026"](https://dupple.com/learn/best-ai-study-tools)) and the
tools' own pages, against what was added tonight:

- **A summary of the whole course.** NotebookLM writes study guides across a notebook's sources; StudyFetch writes notes
  per lecture. Ours grows one summary by topic as lectures are summarized, each line naming its lecture, and works on the
  phone's own model too.
- **Questions in her own words.** Quizlet's Test mode and most tools grade multiple choice; ChatGPT's study mode checks
  understanding in a conversation. Ours adds open and case questions graded against a model answer and her lecture,
  with a plain verdict line written by KesherAI (right, partly, wrong) and what was missing; difficulty easy, medium, hard.
- **Citing the page.** NotebookLM cites the exact passage; page numbers are not shown in the round-up. Ours keeps the
  page or slide of a PDF or presentation and the tutor cites "p. 12" next to the lecture.
- **Notes and search.** RemNote links notes to cards; Quizlet's Magic Notes start from typed notes. Ours keeps her own
  notes beside each lecture and searches every course at once (lectures, summaries, notes, cards, terms).
- **Pictures.** RemNote has image occlusion on her own pictures. Ours finds free diagrams on Wikimedia Commons for the
  lecture's terms, with author and licence (no unlicensed web images).
- **Field tools.** No tool in the round-up has per-field tools. Ours: case brief (IRAC) and a section's elements for
  law, code trace for computer science, a formula sheet for engineering and maths, paper analysis and APA 7 for the
  social sciences, a lesson plan for education, and for clinical placement a care plan, a Gibbs reflection and an SBAR
  handoff (identifying details removed).
- **Slides during a recording.** StudyFetch and Otter take uploaded slides or transcribe; ours reads a photo of the
  slide on the screen into the transcript at its minute, while the recording goes on.

## Godot support: the competitors (2026-11-16, paused)
- Editor plugins (Ziva, AI Assistant Hub, Godot AI Suite, AI Autonomous Agent): a dock in the editor; local models through Ollama in some.
- MCP servers: an addon in `addons/` talks to a server over WebSocket (godot-ai: plugin ↔ Python server on 9500, clients on HTTP 8000/mcp; 120+ tools: scene/nodes, scripts/signals, resources, UI, animation, run/stop, screenshots, logs, tests; every write undoable in the editor). GDAI MCP: scene/node CRUD, properties, debugger output and script errors, screenshots of editor and game.
- Plan for KesherAI: the same shape as the Unreal bridge (the editor connects to KesherAI at /api/godot/ws, this computer only), a GDScript EditorPlugin in integrations/godot, every write through EditorUndoRedoManager, chat tools godot_* (tree, node add/set/remove, script read/write, run/stop, errors, screenshot).
- **Stopped here**: research done, design board and code not started. Paused for a full check of the student features (Roee, 22:58).

## Guiding questions in the chat (2026-11-17)
- Claude's own question tool (Claude Code / Claude apps): 1–4 questions in one card, a short header chip each, 2–4 options with a line of description, the recommended option first, multi-select, and an always-there "Other" answer; asked before a costly, unclear task, not for things the model can check. ChatGPT deep research asks a few clarifying questions as text before it starts; Cursor's plan mode asks with options.
- Built: ask_user takes `questions` (same shape), one card with "Send" and "Skip, you decide"; the system prompt says when to ask; Telegram writes them out; the phone's own models (no tool calls) ask with a ```questions block the phone shows as a card.
- Checked on the PC (0.6.314, Qwen3-Coder): "build me a whole portfolio site" in Hebrew got one card of 4 questions (technology, features, contact page…), each option with a line, the recommended one marked; it renders at 390 px in remote. Godot (same night): the chat connected the editor, made a scene, added a node, saved and showed the tree.

## A voice of her own (2026-11-17)
- Zero-shot cloning beats training here: Chatterbox Multilingual (Resemble AI, MIT) speaks 23 languages including Hebrew (`he`) from a short reference clip (`ChatterboxMultilingualTTS.generate(text, language_id, audio_prompt_path)`); Voicebox/Qwen3-TTS bundles do the same on Windows. Training a voice (XTTS fine-tune, RVC) needs minutes of clean audio and hours.
- Built: Models → Training → "A voice of your own": one-time setup in its own Python (PyTorch cu124 + chatterbox-tts), record 20 s or a WAV, kept only with a "my voice / I have permission" tick, speak text in it (GPU, or the processor when the card is full).
- Stopped at: built (0.6.316); the install and a Hebrew sentence on the PC are the check (the card is full while the big model is loaded, so the first try runs on the processor).

## Fab, Magic Tab, UEFN (2026-11-17, night)
- **Fab**: no public search API (the site's JSON search refuses plain requests); claiming and installing go through the Epic launcher or the Fab plugin inside Unreal 5.x with the user's sign-in. Plan: a chat tool that opens a Fab search in the browser and, for assets already in the library, Unreal's Fab plugin; nothing bought or claimed by KesherAI. Not built.
- **Magic Tab** (suggestions while typing in any app): the apps that do it (Cotypist, Typeahead, Windows' own text suggestions) read the text around the caret through the accessibility API (UI Automation on Windows, AX on macOS), draw a small overlay at the caret and take a global key hook so Tab accepts only while a suggestion shows. In KesherAI that is a native piece (a key hook and UI Automation, a new dependency) plus a small model always loaded (~1 GB, e.g. Qwen 2.5 0.5B). Designed, not built tonight: it needs testing at the keyboard.
- **UEFN/Verse**: Verse files live in Documents\Fortnite Projects\<P>\Plugins\<P>\Content and only UEFN compiles them (Verse → Build Verse Code). Built: list projects, read and write .verse devices from the chat.

## Fab through KesherAI's browser pane (2026-11-17, morning; Roee's idea)
- Roee: "open a channel behind the scenes and mirror its screen". Fab still has no public API; its site searches through
  an undocumented JSON route, `/i/listings/search` (`q`, `is_free=1`, repeated `channels` / `listing_types` /
  `categories`, `sort_by` such as `-relevance` or `-ratings.averageRating`, `count`, `currency`, `cursor`), which
  Cloudflare answers for a real browser and refuses to plain requests.
- Compared: threenative-asset-mcp (MIT, jonit-dev/fab-mcp) drives its own headless browser profile for the same route and
  falls back to clicking; Epic's Fab plugin inside Unreal 5.4+ lists and adds owned assets.
- Plan built: KesherAI's own browser pane (a real Chromium with his Fab sign-in) keeps a fab.com tab; `fab_search` runs
  that search inside the tab (same site, his cookies) and returns titles, sellers, prices, ratings and links;
  `fab_open` shows a listing in the pane beside the chat. He clicks "Add to my library" himself; KesherAI never adds,
  claims or buys. In Unreal, Window → Fab adds library assets to the project.
- Stopped at: built; to check on the PC (the route may change; the tool says so when Fab answers with a challenge).

## SSH targets (2026-11-17, morning)
- VS Code Remote-SSH: installs a VS Code server on the remote over SSH, files and terminals through it (heavy, its own
  protocol). Zed: a small remote server binary, same idea. JetBrains Gateway: a full backend on the remote.
- KesherAI already does WSL the light way: files through Windows' own path to them, commands in the distribution. The
  same works for SSH with SSHFS-Win (WinFsp + SSHFS, GPL/open source, `winget install WinFsp.WinFsp SSHFS-Win.SSHFS-Win`):
  `\\sshfs\user@host[!port]\path` (home), `\\sshfs.r\…` (root), `.k` / `.kr` with the key in `%USERPROFILE%\.ssh\id_rsa`.
  Commands go through Windows' built-in `ssh` with BatchMode (never asks for a password) into the project's folder.
- Built: shell commands for such a path run on the remote; a "Another computer (SSH)" part in the new project dialog
  that checks SSHFS-Win, the key and the connection, makes the key once and shows the line to add on the server.
  Optional: nothing changes for anyone who never opens such a project.
- Stopped at: built; to check on the PC against a real SSH server (Roee's Windows OpenSSH server or WSL's sshd).

## Chat reports like What Brandon Thinks (2026-11-17, morning; Roee: "a page that really gives a useful report", unlike the personas)
- **What Brandon Thinks** (whatbrandonthinks.org and look-alikes): upload a WhatsApp zip / iMessage txt / Instagram or
  Messenger JSON → "Brandon", an opinionated narrator, writes: a verdict, a five-part scorecard, six findings each tied
  to message excerpts, "lines from your chat", who carries the conversation, a turning point, what to say next, and a
  custom deep question. Media stripped on the device; interpretations, not proof; not therapy. 14 languages.
- **WhatBrendonThinks** (open-source recreation): the statistics are computed exactly in code, never by the model
  (who talks and who starts, terms of address, "love you" counts, busiest day, streaks, silences, active hours,
  longest messages, first and latest message, laughs, top words and emojis), then the model gets the figures plus the
  chat; long chats: an agent with read-only tools (read_messages, search_messages, person_profile, messages_on_date),
  or, for a local model, chunked summaries merged up. Fixed format: headline, cast, sections; Hebrew renders RTL.
- **LoveGraft**: Gottman's positivity ratio, reply times, initiation balance, interest over time, conflict patterns,
  red-flag checklist with exact quotes, each reading marked *measured* or *AI*, quotes checked against the messages.
- **Textopsy**: verdict, "the receipts", effort check, red and green flags with the messages behind them, a grade,
  two personality roasts, next move, awards, anonymous share cards.
- **Mosaic**: sentiment timeline, activity heatmap, response patterns, word cloud, memorable moments; the coach's voice
  is chosen (coach / caring friend / roaster).
- **For KesherAI** (all local, nothing leaves the computer; the WhatsApp and Instagram import already exists):
  exact numbers in code; the local model writes in a chosen voice from the numbers plus the messages (chunked for
  long chats); every quote checked against the chat and dropped when it is not there; each finding marked measured or
  read; follow-up questions answered with search over the chat; a not-therapy line and no "will it last"
  percentages (made-up precision); an optional part (Settings → parts), off for anyone who does not want it.
- Stopped at: research done; design next, then build.
- **Brandon's whole path** (the open-source recreation's notes on the original, whatbrandonthinks.com): a 7-step setup, one question
  per screen with "3 of 7": the context (what chat it is) → the app → the evidence (upload, opened on the device, media
  dropped) → the people (tap which one is you; optional in groups) → the names (nicknames and emojis to plain first names)
  → the report's language (can differ from the chat's) → the backstory ("a little context goes a long way", optional).
  The report: verdict with a kinder second reading and one fix; conversation facts; a five-part read with "chat moments
  behind this score"; six findings, each with a "messages behind this" panel; "your next move" as keep / stop / try saying;
  follow-up questions answered from the report plus the relevant messages, citing them, saying when evidence is thin.
- **Roee asked (08:25)**: like Brandon, after the report it asks whether you want to know more and suggests what to give,
  from what you gave before, the whole process; and importing a Brandon report (PDF or the site).
- **Import options**: (1) the report's private link opened in KesherAI's own browser pane (renders their page with the
  user's own sign-in; a plain fetch gets only an empty app shell), its text read and mapped to our report; (2) a PDF saved
  from the report page (Print → Save as PDF), its text extracted; (3) pasted text. All three end in the same mapping by
  the model into our report form, marked "from Brandon"; adding the chat itself then allows follow-ups and an update.
- Stopped at: research done for the whole path and import; design v2 next.

## How open-source projects feel to contributors, and KesherAI (2026-11-17, part 1; Roee asked)
- **VS Code**: `yo code` makes a working extension; F5 opens an Extension Development Host; edit, "Reload Window", breakpoints
  in the editor. One command to a running example, and a separate window so nothing of yours breaks.
- **Obsidian**: clone the sample plugin into a test vault's plugins folder, `npm run dev` rebuilds on save; turn it on in
  Settings; a community "Hot Reload" plugin reloads it on each build. A separate test vault keeps real notes safe.
- **Contributor-friendly repos** (Callstack, OpenTelemetry 2026): a short README that says the problem, the answer and how
  to install; a CONTRIBUTING that is a copy-paste step list with zero-config defaults; scoped "good first issue"
  issues with context; human examples; quick, kind reviews.
- **KesherAI today**: `pnpm create-plugin` scaffolds a plugin in a blink (like `yo code`); CONTRIBUTING has the setup in six
  commands; issue and PR templates; TSDoc enforced by lint; CODE_GUIDE (every file, Hebrew lines too), FORKING, PLUGINS.
- **Gaps found** (to the future list): (1) no plugin dev loop: a plugin reloads only when toggled; wanted a "develop this
  plugin" mode that rebuilds and reloads it on save and shows its errors and logs in place (VS Code / Obsidian);
  (2) no public "good first issue" list: the shared task board's small tasks could be published as issues;
  (3) no one-click environment (a devcontainer / Codespaces) and a big build: the web build needs 6 GB of Node memory,
  which CONTRIBUTING does not say; (4) no separate safe profile for development (Obsidian's test vault): a
  `--data-dir` exists but is not in CONTRIBUTING; (5) no hosted API docs (typedoc builds them locally only).
- Stopped at: part 1 done; part 2 below.

## Editing code inside KesherAI, against Zed and Cursor (2026-11-17, part 2)
- **Zed**: the agent panel says which files changed and by how many lines; "Review Changes" opens one tab with every
  change, each hunk kept or rejected (or all at once); an option shows the same inside each file; "follow the agent"
  moves the editor to each file it touches.
- **Cursor**: users loved per-change Keep / Undo with red-green inline diffs ("file by file, chunk by chunk", it made
  letting the agent work feel safe); 2026 versions moved to auto-apply with one bulk "Review +1181 -413" and drew a
  long complaint thread; per-change review is still there, off by default.
- **KesherAI today**: in plan and ask modes each edit waits for approval with its diff; after a run a receipt lists the
  files with lines added and removed and "Undo all" for the run (asks before undoing files changed since).
- **Gaps** (future list): ⬜ keep / undo per file and per hunk in the receipt (not only the whole run); ⬜ one review view of
  all of a run's changes (Zed's multibuffer); ⬜ "follow the agent" in the editor pane. Keep per-change review the
  default (Cursor's users show why).
- Stopped at: research done (parts 1 and 2); the changes are in FUTURE_FEATURES.

## Hebrew answers while coding, without losing coding ability (2026-11-17)
Roee: in code sessions the model should answer in Hebrew like he writes, and stay a strong coder. Found on the PC: Qwen3-Coder-Next writes Hebrew with Arabic and Chinese letters and English words mixed in ("language confusion").
- **What other tools do**: Cursor, JetBrains AI Assistant, Bito and Autohand have a "response language" setting (a line in the system prompt); Claude Code users ask for separate languages for chat and for code (comments, names). None does more than the prompt; all rely on a model that writes the language well.
- **Research on language confusion** (Marchisio et al. 2024, arXiv 2406.20052): a few short examples in the target language raise "right language on every line" from 86% to 99%; low temperature helps (greedy 97% vs 87% at T=1); multilingual tuning fixes it at training time (about 10% of the data).
- **Language-Aware Token Boosting** (arXiv 2606.08994): add a constant to the logits of the target script's tokens (plus digits and symbols); confusion falls to near zero with no loss in task quality and no slowdown. A static version is a logit bias, which llama.cpp's server supports: KesherAI can lower the tokens of other alphabets (Arabic, Chinese, Japanese, Korean, Cyrillic) when the answer is in Hebrew, leaving Latin (code) and Hebrew alone. The token list comes from the model's own vocabulary once per model (llama-server's /detokenize), cached.
- **Two models** (a coder in English and a small Hebrew model translating its messages, e.g. DictaLM 3.0 1.7B): no loss in coding, but slower, and technical translation can go wrong. Kept as a fallback.
- **Training (LoRA)**: teaching a language is continued pre-training on ~100B tokens (Dicta-LM 3.0), not possible on one GPU; a LoRA on Hebrew coding chats could fix the mixing but risks coding ability and needs a dataset. Last resort.
- **The model itself**: a 24 GB card runs a 27–31B model fully (Qwen 3.6/3.8 27B: SWE-bench Verified ~77, ~42 tok/s on a 3090; Gemma 4 31B: likely better Hebrew, weaker code). No public Hebrew benchmark for these yet: test on our own Hebrew tasks.
- **Plan**: (1) a reply-language setting, separate for chat and for code (comments and names stay English unless asked); (2) two short Hebrew examples of a coding answer in the code prompt; (3) the other-alphabets logit bias on local models when the answer is Hebrew; (4) a model test (Hebrew report, a coding task with tools, Hebrew chat) between Qwen 3.8 27B and Gemma 4 31B, with Roee's OK for the downloads.
- Built (2026-11-18): (2) the code prompt's Hebrew rule with one short Hebrew example (code, names and paths stay as they are); (3) on a local llama.cpp model, when her message is Hebrew, 492 letters of other alphabets (Arabic, Cyrillic, kana, the most common Chinese characters and Korean syllables) get a logit bias of −10 (very unlikely, not forbidden). Left: (1) a separate reply-language setting, (4) the model comparison.
- Checked on the PC (0.6.361): a Hebrew question to Gemma 4 31B through KesherAI; llama.cpp took the bias and the answer was clean Hebrew. Qwen3-Coder-Next (where the mixing was seen) still to test when the card is free.
- Stopped at: (2) and (3) built and checked on Gemma; Qwen3-Coder-Next to test.

## A Claude/Gemini-level main chat, a model team for Hebrew + code, a design canvas (2026-11-17, Roee asked)
Roee: the main chat should show everything a model can make (images, video, music, links, code, files) like Claude and Gemini; a design canvas like the design doc; "+" for every kind of file; and models that work together so answers are Hebrew and the code stays strong.
- **Gemini**: "+" takes PDFs, images, documents, spreadsheets, slides, video (it watches, timestamps, summarizes), code folders (up to 1,000 files), Drive and Photos; in the chat it shows generated images (editable), Veo video, Lyria music, Deep Research reports, Canvas (a side editor for writing and for small apps and games) and downloadable files.
- **Claude**: artifacts (HTML, React, SVG, Mermaid, documents) in a side panel with preview/code and versions; a design canvas of frames with comments; files and images in; no media generation of its own.
- **Open WebUI**: images made and edited inline, code run in the browser, two models side by side, functions that filter or route messages; no video in the chat.
- **Talking between models**: forcing hand-offs through English costs accuracy (arXiv 2609.15079: 13–31 points, more for languages far from English); translate only at the edges, give each model the user's own words. So: the coding model gets Roee's Hebrew as is and works in English inside; a Hebrew model rewrites only the answer's prose when needed (and only then), never the code; the other-alphabets bias (see "Hebrew answers while coding") cleans what is left.
- **KesherAI today** (audit): attachments: images go to the model as images, documents as text; audio, video, code files and folders reach it only as a path; no OCR. Answer text: headings, lists, bold, links, tables, coloured code, charts; missing math, Mermaid, inline images, quotes, copy/run on code, link cards, file cards. Made images, video and music show only in the tool-step panel, not in the answer. Planner/worker/reviewer, ask_member and delegate exist; no per-message routing, no language layer. The canvas tool draws on an Excalidraw whiteboard page, not a design canvas.
- **Designs** (design doc, 2026-11-17 11:40): RichChatDesktop, RichChatPhone, PlusMenu, ArtifactPanel, DesignCanvasChat, ModelTeam.
- **Build order**: (1) the answer shows what the model made inline (images, video, music, file cards) and the missing Markdown (math, Mermaid, quotes, inline images, copy/run on code, link cards); (2) "+" reads audio and video (Whisper transcript + a few frames) and code files; (3) the model team (Hebrew voice, other-alphabets bias, reply-language settings); (4) artifacts in a side panel (sandboxed); (5) the design canvas (frames made as HTML, comments, export).
- Stopped at: research and designs done; building (1).

## Students, part 18: what is still missing (2026-11-17, Roee asked)
Sources: NotebookLM's 2026 features (Glasp round-up: Video Overviews, Cinematic video, mind map, reports, flashcards and quizzes with progress, infographics, slide decks exportable to PPTX, data tables, Deep Research, Drive sync, Literature Insights), Rework's "12 AI tools for college students 2026" (Perplexity Study Mode, Zotero, Grammarly, Notion, Otter, Quizlet, Motion, Todoist, Speechify), against parts 1–17.
Already in KesherAI: flashcards (FSRS), practice and open questions, audio overviews, a tutor from her lectures with page citations, summaries per lecture and per course, terms, recording with captions and translation, slides read during a recording, past exams, the syllabus, a focus timer with streaks, homework step by step, Socratic study, field tools, sharing a course, notes and search, licensed diagrams.
Missing (by value, Israeli university student):
1. **Moodle** (most Israeli universities): bring a course's files and assignment dates in on her sign-in (through KesherAI's browser pane, like Fab), so lectures and deadlines arrive by themselves.
2. **Deadlines and a plan** (Motion, Todoist Assist): assignments with due dates, broken into steps, placed in the week around her timetable, on Google Calendar when connected.
3. **Video overview** (NotebookLM): a narrated slide video of a lecture (slides from the summary, her chosen voice), to watch on the bus.
4. **Slide deck from her material** (NotebookLM, exportable PPTX): for a seminar or a presentation she gives.
5. **Writing coach on her own draft** (Claude, Grammarly): structure, argument, Hebrew and English language, citations missing; never writes the work for her.
6. **Sources library** (Zotero): papers she reads, with APA 7 / Chicago references from the right fields, cited in her drafts; import a Zotero library.
7. **Mind map** of a course (NotebookLM): the course's topics as a map she can open and collapse, each node opening its lecture.
8. **Oral exam and presentation practice by voice**: KesherAI asks like an examiner (from her material), listens, and gives feedback on content, pace and filler words.
9. **Read any PDF aloud with OCR** (Speechify): textbook chapters and scanned articles, in Hebrew too, with the place kept.
10. **Comparison tables** (NotebookLM data tables): e.g. drugs, theories, cases side by side, exportable to Sheets.
- Stopped at: research done; designs and building not started (after the chat stages 1–5, or when Roee picks).

## Students, part 19: Moodle (2026-11-17, first on the students list)
- Israeli universities run Moodle (TAU, HUJI, Technion, BGU, BIU, Open University…), each on its own address, mostly with university sign-in (SSO), so a password or a token from login/token.php is not the way (and KesherAI never types passwords).
- The Moodle web page itself calls its own AJAX endpoint with the signed-in session: `POST {wwwroot}/lib/ajax/service.php?sesskey={M.cfg.sesskey}` with `[{index, methodname, args}]`. The dashboard uses `core_course_get_enrolled_courses_by_timeline_classification` (classification inprogress/all, sort fullname) and the timeline block `core_calendar_get_action_events_by_timesort` (timesortfrom, limittonumber) for what is due. `core_course_get_contents` is usually not open to AJAX, so a course's files come from its page (`course/view.php?id=`: links to `mod/resource/view.php`, `mod/folder`, `mod/url`, `pluginfile.php`), downloaded with the same session.
- Others: Moodle MCP servers (e.g. moodle-mcp-sernobre, 44 tools) use a web-service token, aimed at teachers; the Moodle app uses login/token.php or SSO with a launch URL.
- Plan: the same path as Fab. KesherAI's browser pane opens the student's Moodle (she signs in there once, as on any site); a "Moodle" card in Study lists her current courses and what is due; she ticks which course goes to which KesherAI course; lecture files (PDF, PPTX, DOCX) come in as lectures (deduplicated by file), assignments as deadlines. Runs on her click, and again when she opens Study (no background crawling); read-only: KesherAI never submits, posts or changes anything in Moodle.
- Stopped at: research done; design next, then building.

## Students, part 20: a second, wider look for gaps (2026-11-17, Roee asked)
Sources: YouLearn's "Best AI study tools 2026" (YouLearn, NoteGPT, Otter, NotebookLM, Quizlet, Anki, Khanmigo, Wolfram Alpha, Photomath, Brainly, ChatGPT, Perplexity), Feynman AI, SaveMyGPA, against parts 1–19 and the code.
New gaps (not in part 18's list):
1. **A YouTube lecture as a lecture** (YouLearn, NoteGPT, Feynman AI, SaveMyGPA): paste a link; its transcript (with times) becomes a lecture, each summary line linking back to its minute. KesherAI has no YouTube import in Study.
2. **Teach-back (the Feynman technique)** (Feynman AI): she explains a topic in her own words, by voice or text; KesherAI checks it against her lecture, names what was missing or wrong, and turns the gaps into cards.
3. **Mastery per topic and weak-spot alerts** (SaveMyGPA, Quizlet Learn): a score per topic from her cards and quizzes, and a nudge when one drops; today Study shows "weak lectures" only.
4. **Graphs and calculation** (Wolfram Alpha, Photomath): draw a function or data she gives (the chat's charts and math are there; a plotted function y = f(x) is not), and show more than one way to solve.
5. **Save from the web to a course** (SaveMyGPA, NoteGPT extensions): KesherAI's browser extension and pane could send a page or a selection to a course as a lecture.
6. **A study game** (Quizlet Match): match terms to meanings against the clock, from her terms and cards.
Already covered (checked): notes and summaries, flashcards with spaced repetition, quizzes and open questions, audio overviews, a tutor from her lectures with citations, Socratic study, step-by-step homework, focus hours and streaks, sharing a course, camera input, captions and translation in class.
- Stopped at: list made; added to the future list after part 18's items.

## Students, part 21: video lectures from any system, split into chapters with questions (2026-11-17, Roee asked)
- Where lectures are: Tel Aviv University records in Panopto, inside each course's Moodle site (published by the lecturer); Zoom cloud recordings are kept 14 days only. Panopto or Kaltura is what most Israeli universities use. yt-dlp has extractors for Panopto, Kaltura, Vimeo and Zoom and accepts a cookies file, so her own sign-in in KesherAI's browser is enough.
- In-video questions: Panopto and Kaltura both offer in-video quizzes (multiple choice only, placed by the lecturer); Edpuzzle pauses the video at a question. Coursera does the same.
- Built: a lecture from her MP4 (streamed to disk, transcribed with minute marks) or from a Panopto/Kaltura/Vimeo link (video at most 720p and captions via yt-dlp with that site's cookies only); 3–10 chapters by topic from the transcript, each with a summary and a multiple-choice question; a player that pauses at each chapter's end to ask and offers to go back on a wrong answer (YouTube's privacy-enhanced player, or the kept video).
- Stopped at: built; to check on the PC with a real YouTube lecture and, with Roee, a Panopto one.

## Students, part 22: mastery per topic and function graphs (2026-11-17)
- Mastery: Quizlet Learn and SaveMyGPA show a level per topic; Anki shows retention only. Built: a 0–100 score per lecture from her card reviews (good/easy count, hard half, again none) and her quiz answers, recent ones weigh more (half after 30 days); compared with a week ago, a drop of 10+ points shows a nudge with a short quiz on that lecture. "On weak topics" quizzes now use it.
- Graphs: Desmos and GeoGebra are the reference; ChatGPT added interactive math visuals with sliders in March 2026. Built: a ```graph block in any answer (chat and the course tutor): up to 8 functions, x/y ranges, a slider per parameter, drag, wheel and pinch zoom, tap to read a value. Expressions are parsed into closures, never run as code.
- Stopped at: built; next is "save from the browser to a course".

## Students, part 23: save from the browser to a course (2026-11-17)
- Competitors: SaveMyGPA and NoteGPT extensions send a page to a notebook; NotebookLM adds a web page as a source by address; Notion Web Clipper saves to a chosen page.
- Built: "🎓 To course" in KesherAI's browser bar and "Save to course" in the extension's side panel: the page, or only what is selected on it, as a new lecture that keeps the page's address (shown on the lecture), or added to the end of a lecture she picks. The last course is remembered. Extension 0.2.2.
- Stopped at: built; next is the study game (match terms against the clock).

## Ideas, part 1: "Open mind" — record a brain dump, sorted into ideas, with research (2026-11-17, Roee asked)
- Competitors: AudioPen, Voicenotes, Cleft Notes, TalkNotes, Voicethoughts and Spokenly turn rambling voice notes into clean notes, lists or tasks; none sorts ideas by value, checks whether you already tried them, matches them to your own projects, or researches each. Idea-scoring tools (Ideanote, Ezassi, IdeaFlow, startup validators) score typed ideas against criteria but start from one written idea, not a recording.
- Built (#/ideas, under Work): a recorder with a chosen length (5/10/15/30 minutes or until stopped), pause, a level meter; the audio streams to disk without a length cap and is deleted once transcribed. The chat model pulls out every idea as a ready prompt, with good/maybe/weak and why, her projects it fits (only from her real project list), audience and category. "Tried before" comes from searching her past chats (incognito left out) and the model judging the matches, with links to those chats. Research: one idea, or all in a row (good ones first, one at a time, stoppable), each as a chat with the web and a deep-research request ending in go / change / drop. Text can be pasted instead of recording.
- Stopped at: built; to check on the PC with a real recording.

## Students, part 24: a study game (2026-11-17)
- Quizlet Match (tap a term and its meaning against the clock, a wrong pair adds a second, best time kept) is the reference; Kahoot and Blooket are for groups.
- Built: "🎯 Game" in the course: six of her terms (from summarized lectures) and their meanings shuffled; tap one then its pair; a wrong pair shakes and adds a second; her best time per course on this device.
- Stopped at: built; next is the slide deck from a lecture.

## Students, part 25: what Duolingo and other learning apps have that Study lacks (2026-11-17, Roee asked)
- Duolingo: streaks with freezes and weekend protection, a daily XP goal, leagues and leaderboards, levels and badges, reminders at the right hour (and a "red dot"), instant feedback with a sound, easy early wins, adaptive difficulty, bite-sized lessons on a path of units, a practice hub of past mistakes, Max's "Explain my answer", Roleplay and Video Call (speaking practice). Brilliant: interactive problems you solve step by step. Khanmigo: Socratic tutor. Forest: focus timer with a reward. Quizlet: Learn mode (adaptive), Match. Brainscape: confidence-based repetition.
- Study already has: streak with one free day a week, focus timer, "what to study now", spaced cards (FSRS ratings), quizzes with explanations, open and case questions, a tutor from her lectures (ask, Socratic, homework), teach-back, mastery per topic, Match, video lectures with questions.
- Missing, by value: (1) a daily goal (minutes or cards) with a progress ring, and a reminder at her hour only on days she has not studied, with the one next thing; (2) "My mistakes": one session of the cards and quiz questions she got wrong lately, until each is right twice; (3) the course as a path: each lecture a step (summary → cards → quiz → mastery 80+ = a crown), so progress is visible; (4) a 5-minute lesson: a short mix (a few due cards, two quiz questions, one match) for small gaps in the day; (5) feedback that feels good: a soft sound and a small celebration on a right answer, a finished goal or a new best (off with reduced motion or a mute switch); (6) a weekly recap: minutes, cards, topics that rose or dropped, the streak; (7) adaptive quizzes: the next question harder or easier by her answers; (8) speaking practice (oral exam) — already on the list; (9) badges for milestones (a first course mastered, a 30-day streak). Leagues and friends fit a single-user app badly; left out unless she studies with friends (shared courses).
- Stopped at: list given to Roee; building from (1).

## Students, part 26: ready for a student who finds studying hard (2026-11-17, Roee: "ready as a whole package", for a friend)
- What helps (ADHD and dyslexia study tools, procrastination research): procrastination and overwhelm are the biggest problems students report; what helps is a one-button start (Forest), breaking a big task into tiny steps (Goblin.tools), visual timers against time blindness (Tiimo), listening instead of reading with the words highlighted (NaturalReader, Speechify), readable fonts and spacing, focus sounds, gentle few notifications, simple setup with nothing to configure first, visible progress and small rewards, body doubling (studying "with" someone), and mood/energy check-ins that make a light day OK.
- Study has: read-aloud, focus timer and streak, "what to study now", my week (assignments into dated steps), explain simply, recordings and transcripts, the phone app and widgets.
- Missing for her, by value: (1) a first visit to Study that sets her up in three steps (first course, how lectures come in: record / upload / Moodle / link, the daily goal on or off) with nothing else to read; (2) simple mode: the course shows the few everyday tabs (lectures, review, quiz, ask, game, progress), the rest behind "more tools"; on for a new student; (3) "I'm stuck": one button that picks the next thing, makes it a 2-minute first step and starts a short timer; (4) easier reading: larger text, more line and letter spacing, a readable font, and read-aloud that highlights the sentence being read; (5) focus sounds in the timer (brown noise, rain), made in the browser, nothing downloaded; (6) "how am I today": low energy turns today into a light plan, without guilt; (7) a study buddy: the timer can say "I'm here with you" check-ins, and a course shared with a friend shows when the friend is studying too. Plus the Duolingo list (part 25).
- Stopped at: list given to Roee; building (1) and (2) first.
- Built (part 26 #3–#6): "Hard to start", easy reading and read-along, focus sounds (brown noise, rain, waves made with Web Audio while the timer runs, volume), the study buddy (a kind line every 10 minutes while focusing), and "how are you today" (a tired day halves the goal so the streak survives). Next: the Duolingo list from "My mistakes".
- Built (part 25 #2–#7, #9): My mistakes, the course as a path, a 5-minute lesson, soft sounds and a small celebration, your week, quizzes adapted to her mastery by default, badges. Left from the lists: speaking practice / oral exam (on the future list), friends studying together (shared courses already exist).

## Canvas documents, part 2: Docs and Sheets (2026-11-17)
- Docs: Claude Docs, Notion and Google Docs edit blocks in place with AI on a selection; KesherAI's older "Pages" had Markdown with writing buttons. Built: one documents page (Pages joined in), blocks over Markdown, writing buttons, versions, live edits from the chat's "document" tool, PDF / Markdown / copy for Word or Google Docs.
- Sheets: Claude Sheets, Google Sheets with Gemini, Excel with Copilot: a grid with formulas, the AI fills or changes ranges and explains; files are XLSX/CSV. React grids (react-spreadsheet, GridSheet, RevoGrid, Kendo, SheetXL) are either heavy or bring their own formula engines that evaluate strings; KesherAI already parses expressions into closures (the graphs' compileExpr), never running them as code.
- Plan for Sheets: our own light grid (columns A…, rows 1…), formulas parsed by our own engine (+ − × ÷ ^, A1 and A1:B9, SUM AVERAGE MIN MAX COUNT ROUND ABS IF, comparisons, text), cycles shown as #CYCLE, errors as #ERR; a store with versions and a live stream like decks and docs; a "sheet" chat tool (read, set cells or a range, add rows); CSV in and out, XLSX out optional; 390px: the grid scrolls inside its card.
- Stopped at: research done; design next.

## Students, part 27: what is still missing after parts 1–26 (2026-11-17, Roee asked "is there anything we didn't put in for studying? research and check")
Sources: NotebookLM's 2026 updates (TeacherCast, April 2026), fast.io's "Best AI study tools 2026" (Anki, Knowt, NotebookLM, RemNote, Quizlet, ChatGPT Study Mode, Studdy, Grammarly, Goblin.tools, Speechify), tl;dv's StudyFetch review (2026), checked against the code.
Already there (checked in the code): flashcards with FSRS, import and export for Anki/Quizlet, quizzes (multiple choice, open, case) by level and adapted to mastery, past exams shaping practice tests, a timed exam only for the licensing exam, the tutor from her lectures, teach-back, oral exam, writing coach with levels per dimension, APA, formula sheet, comparison table, mind map, slides, audio overview, live translation in class, Match, path, badges, goal, mistakes.
Missing, by value:
1. **A full mock exam for any course** (Quizlet practice tests, Knowt, StudyFetch): exam conditions — her exam's length and question mix, a countdown (with extra time for accommodations, 25%), no hints or answers until she submits, then a grade estimate, the topics to go back to, and the wrong ones into My mistakes. Today only the licensing exam is timed.
2. **Grades and the weighted average** (Israeli students live by the ממוצע משוקלל and נק"ז): each course's credits, its grade parts (exam, assignments, Moed A/B), the weighted average, and "what do I need in the exam to get X". Not in Study.
3. **The weekly timetable** (MyStudyLife): her classes by day and hour and room, so "what now" knows she is in class, a reminder to start recording when a lecture begins, and the lecture filed under the right course by itself.
4. **Fill-in-the-blank and "how sure are you"** (NotebookLM quizzes, RemNote cloze, StudyFetch and Brainscape confidence): cloze cards from her summary; rating confidence before seeing the answer, so a confident wrong answer gets extra review (it sticks best when corrected).
5. **Reading articles and PDFs with highlights** (LiquidText, RemNote, NotebookLM sources): read a PDF in Study, highlight, turn highlights into cards or notes with the page number.
6. **A one-page visual summary / infographic** (NotebookLM infographics): a printable page per lecture or topic, from the summary and the diagrams.
7. **A short video overview** (NotebookLM video overviews): the lecture's slides read aloud in order, as a video she can play on the bus; Study has slides and audio separately.
8. **Ask during the recording** (StudyFetch LiveLecture): while a lecture is being recorded, ask "what did he just say about X" from the transcript so far.
- Stopped at: list given to Roee; building (1) first, then (2) and (3).
- Built (2026-11-17, Roee: "add everything missing"): (1) mock exam, (2) grades and weighted average, (3) timetable with "now" and a record reminder, (4) fill-in-the-blank cards and confidence, (5) reading with highlights into cards, (6) a one-page sheet per lecture, (8) questions during a recording. (7) was already there: the lecture's "🎬 Video" view makes narrated slides (design VideoOverview) — the list missed it. Students part 27 done.

## Students, part 28: a wider sweep beyond AI study apps (2026-11-17, Roee: "deep research on all competing and learning-focused apps, check what we lack")
Sources: Genio Notes (formerly Glean; disability-services note-taking), Notability and Goodnotes (AI notes, audio sync), RemNote vs Anki (PDF highlights to cards, exam scheduler, image occlusion, knowledge graph), math solvers (Wolfram, Symbolab, Photomath, GeoGebra, Khanmigo, Microsoft Math Solver), StudyStream and Focusmate (body doubling with people), research tools (Semantic Scholar, Consensus, Elicit, SciSpace, Scite, ResearchRabbit, Zotero), group quiz games (Quizizz, Knowt live, Gimkit, Kahoot), Israeli: Open Student (Open University degree manager), Learnet, Afeka's app; against parts 1–27 and the code.
Already there: everything in parts 1–27 (recording with marks and slide photos, transcripts, summaries, FSRS cards with an exam plan, quizzes and a mock exam, tutor and Socratic mode, homework steps, graphs, focus timer with sounds and an AI buddy, grades, timetable, highlights to cards, sharing a course, APA, sources).
Missing, by value:
1. **Lecture slides synced with the recording** (Genio, Notability): add the lecture's PowerPoint/PDF; each slide is matched to the minutes of the transcript where it is discussed; tap a slide to hear that part. Today only slide photos taken during the recording.
2. **Image occlusion cards** (Anki, RemNote): on a picture (anatomy, a diagram), hide labels with boxes; each box becomes a card. Big for nursing and medicine.
3. **Listening controls for recordings** (Genio, Notability): speed 0.75–2×, 10-second back/forward, and the transcript line follows the sound. The player is the browser's bare one.
4. **A live quiz with classmates** (Kahoot, Quizizz, Knowt live): she hosts a quiz from her course; friends join by a link or QR on their phones (no install), answer against the clock; a scoreboard.
5. **Study together** (StudyStream, Focusmate, Open Student's study groups): a shared focus room with friends (who is studying now, the shared timer, no camera), and each course's study-group links (WhatsApp).
6. **Find papers and check claims** (Semantic Scholar, Consensus, Elicit, Zotero): search real papers on a topic, "what do the studies say" with links, save to the course's sources, export BibTeX/RIS for Zotero.
7. **Degree progress** (Open Student, Israeli degree planners): the degree's required credits by kind (required, elective, general), done / in progress / left, per semester.
8. **"A similar problem"** (Symbolab, Microsoft Math Solver): after a solved homework step-by-step, one more of the same kind to try alone, checked.
9. **Where else a term appears** (RemNote's links): from a term, the other lectures and courses that mention it.
- Not taken: handwriting notes on a tablet (Goodnotes territory), speaker labels (needs diarization; later), proctoring.
- Built (2026-11-17): all nine. (1) slides lined up with the recording (SlidesSync); (2) image occlusion cards (ImageOcclusion); (3) ±10 s, the line being heard, and every player 0.25×–4× (ListenSpeed, Roee); (4) live quiz with friends, /q/ link and QR (LiveQuiz); (5) a shared focus room /f/ and study group links (StudyTogether); (6) papers from OpenAlex or a DOI, "what the studies say", sources with APA 7, BibTeX and RIS (Papers); (7) degree progress by kind of credits (DegreeProgress); (8) "a similar problem" in homework mode; (9) where else a term appears, with page and minute (SimilarAndWhere). Also (Roee): notes on moments of a recording or video and the course's "My notes" tab (TimeNotes).
- Stopped at: built; tested at 390 px with mocks; on the PC after 0.6.340/341 (papers need the PC's network).

## Students, part 29: another sweep after part 28 (2026-11-17, Roee: "research again until nothing is missing")
Sources: Gemini Notebook (NotebookLM) 2026 updates (TeacherCast round-up: EPUB sources, voice conversations, quiz/flashcard results chat, short video overviews, infographics, slide revisions), Quizlet's Feb 2026 AI tools and Coconote (podcasts, Memory Palace game, card match, mind map), Toolfinder and Toolradar "best AI study apps 2026" (Photomath, Studdy, Glasp, Structured, Grammarly), Glasp's study-modes comparison (ChatGPT Study mode, Gemini Guided Learning with YouTube, Claude learning mode); each checked against the code.
Missing (checked in the code):
1. **A photo of the problem** (Photomath, Studdy, Gemini): in homework and "ask the course", snap or choose a photo; the vision model writes the exercise out and help starts from it. Today homework takes typed text only.
2. **A two-voice podcast** (NotebookLM Audio Overview, Coconote): the audio review as a talk between two hosts with two voices. Today it is one voice.
3. **EPUB and ODT books** (Gemini Notebook EPUB): a textbook chapter from an ebook or a LibreOffice file as a lecture. Today: PDF, PowerPoint, Word, text, photos.
4. **Talk to the course by voice** (Gemini Notebook voice conversations): ask by voice and hear the answer in every mode; today only the study mode's oral exam.
5. **Talk about a quiz result** (Gemini Notebook, Sept): after a quiz, "what should I learn from this?" from the questions she missed.
6. **Memory palace** (Coconote): her own familiar place, a vivid picture tying each term to a spot, then a walk to recall them.
7. **Videos on a topic** (Gemini Guided Learning): a few YouTube lectures on a lecture's topic, one tap to add one as a lecture.
8. **Scanned PDFs** (Speechify, part 18 #9): a PDF with no text is read page by page (Windows renders the pages; Windows OCR or the vision model reads them). Today it asks for photos.
- Not taken: an "AI-written?" detector (unreliable, and her writing is hers), OpenStax books (English; OpenAlex covers books), a spoken day into a schedule (the timetable and plans cover it).
- Built (2026-11-17): all eight (designs ProblemPhoto, Podcast, QuizTalkPalace, TopicVideos; EPUB/ODT and scanned PDFs need no new screen). Checked on the PC in 0.6.340: papers search (12 results, DOI lookup), the live quiz end to end, the focus room page.
- Stopped at: built; 0.6.341 building.

## Students, part 30: flashcard power tools and reading differences (2026-11-17, Roee: "keep looping until we have everything")
Sources: a 2026 deep-dive of spaced-repetition apps (Anki and its add-ons, AnkiHub, RemNote, SuperMemo, Quizlet, Mochi, Brainscape, Memrise), StudyCardsAI's med-school Anki add-ons (Image Occlusion, Speed Focus Mode, Advanced Browser for leeches), Genio's "accessible learning apps 2026" (Genio Notes, Tiimo, NaturalReader, Forest, Goblin.tools, Habitica); checked against the code.
Missing:
1. **Hard cards (leeches)** (Anki): cards she keeps forgetting are found and offered a fix: rewrite simpler, split in two, or an explanation; today a forgotten card just comes back.
2. **Cards typed in notes** (RemNote's "term :: meaning"): lines with "::" in her lecture notes become cards.
3. **A timer per card** (Speed Focus Mode): an optional few seconds per card, then the answer shows by itself.
4. **Incremental reading** (SuperMemo): a long chapter or article read in daily portions, the place kept, cards from each portion.
5. **A reading font for dyslexia** (NaturalReader and dyslexia apps): an easier font choice with the easy reading.
- Not taken: blocking sites (Forest; outside KesherAI's reach), a visual day timeline (the timetable and "now" cover it), shared decks with live updates (shared courses cover sharing).
- Built (2026-11-17): all five (designs HardCards with the card timer and note cards, Portions with the reading font).
- Stopped at: built; next research round (31).

## Students, part 31: Israeli university life around the studying (2026-11-17, the loop)
Sources: Israeli student apps ("מועד ב׳ – מחשבון ציונים אקדמאי", UniTask, Open Student, Learnet), Israeli institutions' 2026 reserve-duty accommodation notices (Technion, Levinsky-Wingate), MyStudyLife's "AI school planners 2026" (MyStudyLife, Reclaim, Structured, Todoist, Eduplanner); checked against the code.
Missing:
1. **Should I take Moed B?** ("מועד ב׳" app): from her Moed A score and a guess for Moed B, the course grade and the average either way, under her institution's rule (the last grade counts, or the higher).
2. **Pass/fail and year-long courses** in grades: credits that count toward the degree but not the average.
3. **Timetable from a photo** (MyStudyLife's schedule scan): a photo or screenshot of her weekly schedule becomes the timetable.
4. **Letters to the lecturer or the secretariat** (Eduplanner's emails, Israeli reserve-duty accommodations): an extension, accommodations after reserve duty (מילואים), a grade appeal or a special exam date, drafted politely in Hebrew from what she fills in, for her to send herself.
- Not taken: lecturer reviews (community data KesherAI does not have), syncing a university's messages (Moodle covers it once its address is set), dual degrees (a course list per degree is a later step if asked).
- Built (2026-11-17): all four (design IsraeliStudent). Checked on the PC in 0.6.341: topic videos (6 found, Hebrew ones first for a Hebrew topic), where a term appears.
- Stopped at: built; next research round (32).

## Students, part 32: the days before the exam, presenting, formulas (2026-11-17, the loop)
Sources: exam-countdown and last-minute revision apps 2026 (Exam Countdown, Exanix, iatroX's last-minute medical revision list), AI speech coaches (Yoodli, Orai, Prezi's round-up: pace, filler words, length), math flashcards (Anki with MathJax, RemNote's LaTeX); checked against the code.
Missing:
1. **Presentation rehearsal** (Yoodli, Orai): she says her talk; KesherAI measures words per minute, filler words (אממ, כאילו, בעצם… and English ones) and length against her time, and the model comments on structure and clarity against her material. The oral exam covers answering, not presenting.
2. **The last days before an exam** (exam countdown and last-minute revision apps): from two days before the exam date, a "toward the exam" card: the countdown, her hard cards and mistakes first, the one-page sheets, a short practice test, and a small checklist for the day.
3. **Formulas in a card's question** (Anki MathJax, RemNote LaTeX): the answer showed formulas, the question did not.
- Not taken: GCSE-style marking boards (Israeli universities differ by course; open questions are already graded against her material).
- Built (2026-11-17): all three (design ExamEveRehearse). Also found on the PC: the two-voice podcast came out in English for a Hebrew lecture with Gemma; the Hebrew rule now goes in both turns with a Hebrew first line to follow.
- Stopped at: built; next research round (33).

## Students, part 33: English for the degree, the course as a web, group projects (2026-11-17, the loop)
Sources: NITE's AMIRNET tips and FAQ and the universities' English requirements (TAU, BIU, HUJI, Haifa: every Israeli student must reach exemption, mostly by reading academic texts), knowledge-graph note apps (Obsidian's graph view, RemNote, the 2026 PKM round-ups), group-project tools for students (Wrike for students, Taskphase, Superthread, Pronto); checked against the code.
Missing:
1. **Academic English practice** (AMIRNET / exemption courses): from a text she brings (an article, a paper's abstract from her sources) reading-comprehension questions in the exam's style and its hard words with their Hebrew meaning, the words into cards.
2. **The course as a web** (Obsidian's graph view): lectures as points joined by the terms they share, a tap opens a lecture or shows the shared terms.
3. **A group project board** (Taskphase, Wrike for students): a course project's tasks with who does what and by when, and a link teammates open (no account) to take a task and mark it done.
- Not taken: a full notes app with backlinks (KesherAI's documents and "where else a term appears" cover it).
- Built (2026-11-17): all three (design Part33).
- Stopped at: built; next research round (34).

## Students, part 34: what is left in the AI study-app field (2026-11-17, the loop)
Sources: Lynote's "Gizmo AI alternatives" (Gizmo, Lynote, Knowt, RemNote, Quizlet, NotebookLM, Anki, StudyFetch, Turbo AI) and Mindomax's "Turbolearn alternatives" (Laxu, Jungle AI, Scholarly, Voovo, Notability, Goodnotes, Otter, Coconote, Genio, NoteGPT, Mindgrasp, Studley, ScrollToStudy, Algor, Studocu, Mochi); every feature checked against parts 1–33 and the code.
Missing:
1. **A study feed** (ScrollToStudy): her material as a social-media-style vertical feed of short bites (a term, a card to flip, a question, a line of the summary), swiped on the phone.
- Not taken: Anki .apkg import/export (a SQLite reader would be a new dependency, and the desktop's Node has none built in; the text export/import covers decks), Gizmo's "hearts" that stop practice (the opposite of KesherAI's kind approach), Studocu's shared-notes library (community content KesherAI does not have), handwriting notes (Goodnotes and Notability territory).
- Already there (checked): podcasts, audio overviews, lecture recording with live transcript, YouTube and browser capture, concept maps, case questions, image occlusion, notes into cards, exam-date scheduling, Quizlet/Anki text import, an AI tutor.
- Built (2026-11-17): the study feed (design StudyFeed).
- Stopped at: built; the AI study-app field is covered as far as this sweep finds; next: test everything on the PC and one more sweep from a different angle (35).

## Students, part 35: one more sweep, from new angles (2026-11-18, the loop)
Sources: Fora Soft's "Best AI study tools 2026" (Gemini Notebook, ChatGPT Study Mode, Quizlet, Knowt, StudyFetch, Brainscape, Anki + FSRS, Khanmigo, Microsoft Study and Learn, StudyGlen, Laxu, Scholarly), QANDA (photo solution search, study timer, micro-videos), Hebrew-language reviews of AI study tools (Notelyn's Hebrew blog, Speak AI's student page), the accommodations angle (extra time on exams, already in the mock exam); each checked against parts 1–34 and the code.
- Found nothing new that KesherAI lacks: recall stopwatch (the card timer), Socratic walkthroughs (study mode and homework), confidence-based repetition ("how sure are you"), tutors limited to her material (ask the course), photo problem solving (part 29), micro-videos (topic videos and video overviews), cited chat (sources by lecture and page), practice exams (mock exams with extra time), study timers (focus with sounds and rooms).
- Not taken (as before): Anki .apkg, shared public libraries, QTI export (a teacher's format), handwriting.
- Stopped at: the sweep finds 0 missing; next: release, a full check on the PC, then sweeps only when something new appears.

## Screen lens, part 1: capture part of the screen and hand it to the AI (2026-11-17, Roee asked)
- Google: Circle to Search on Android (hold home, circle anything; search, translate in place, AI overview); Lens in desktop Chrome (a region on the page → search, "translate" puts the translation over the picture, text selection by OCR, AI Mode follow-ups). Microsoft: Click to Do on Windows 11 (Win+click or Win+Q; local OCR, text actions — summarize, rewrite, search — run on the PC with Phi Silica on Copilot+ PCs; image actions: visual search, erase, remove background; nothing kept after the action), Copilot Vision (shares a window with Copilot), Edge Lens (experimental). Snipping Lens (open source): Snipping Tool region → uploaded to an image host → Google image search (cloud, privacy cost). ChatGPT/Claude desktop apps: a hotkey to attach a screenshot or a window to a chat.
- What makes them good: one global shortcut, the screen frozen and dimmed with a free drag (or circle) to select, actions right next to the selection, results shown over the screen (translation in place), the text in the picture selectable, follow-up questions, nothing stored after the action.
- KesherAI has: global shortcuts (Settings → Keyboard, overlay windows like the text helper), screen capture (Electron), "mark up the screen" in the chat's "+", the browser extension (side panel, the page's text) and its own browser pane, vision models (Qwen3.8 27B with mmproj; Gemma 4 31B downloading).
- Plan: (1) a global shortcut (set in Settings → Keyboard) freezes the screen under the cursor; drag a rectangle or circle; an action bar beside it: Ask, Search (web), Translate, Summarize, Copy text; results in a small card over the screen, "continue in chat"; (2) text by Windows' own OCR on the PC first (fast, private, Hebrew with the language pack), a vision model when it is a picture; (3) translate shows the translation over the selection; (4) the browser extension and KesherAI's browser: the same from a shortcut or right-click, the selection drawn on the page; (5) the phone later (Android screen capture permission). Nothing is kept after the action unless she continues in a chat.
- Stopped at: research done; design next.
- Built (2026-11-17, design ScreenLens): (1) Ctrl+Alt+L, frozen screen, drag a rectangle (a tap = all), action bar beside it, the answer in a card, "continue in chat"; (2) "copy text" uses Windows' own OCR first, the vision chat model otherwise and for the rest; the phone: #/lens with a chosen screenshot. Left for later: translation drawn over the picture in place, a circle selection, the browser extension's right-click, more than the primary display.

## Canvas documents, part 1: Slides (2026-11-17, Roee: our own alternatives at the canvas level, others as options)
- Claude Slides (2026, grew out of Claude Design): asked for in any chat or started from a template; an editable slide canvas, edit any slide directly, comment on an element or ask in chat and the change appears live, a version picker, present from the app, export PowerPoint / PDF / HTML. Weak: default style marketing-heavy, beta.
- Gamma: a deck from one prompt or pasted notes; content in "cards" with themes; the AI edits one card or the whole deck; export PDF/PPTX; strong default design, weak fine control.
- Google Slides / PowerPoint: full manual control, AI as a side panel (Gemini, Copilot), files the standard.
- NotebookLM: a deck from sources, each slide exported as one picture (not editable).
- KesherAI already has: an Excalidraw canvas the model draws on live (canvas.ts: a JSON store, model tools, a live stream), HTML artifacts with versions, lecture slides (video overview), a PPTX writer and PDF printing.
- Plan: a Deck document like the canvas: JSON slides (layouts: title, bullets, two columns, quote, picture; speaker notes; a theme), a store with versions and a live stream, model tools (deck_create, deck_update_slide, deck_add_slide…), an editor where she clicks any text to edit it, adds, removes and reorders slides, picks a theme, asks the AI to change one slide; present full screen with notes for the presenter; export PDF (no other program), PPTX optional; import a PPTX's text. A lecture's slides open as a deck. Docs and Sheets follow the same way.
- Built (2026-11-17, design DeckEditor, DocEditor, SheetEditor): decks.ts, docs.ts, sheets.ts with the chat's tools, the editors, present mode, PDF/PPTX (see part 2).
- Stopped at: done.

## Students, part 36: the phone alone (2026-11-17, Roee: "everything that can work alone on the phone should")
- Checked each study feature from parts 25-34 against what the phone has by itself: the shared code (study-core), its own model (chat and vision), speech to text, the phone's voice (pitch and rate), the internet.
- Runs alone on the phone: the feed, the course web, the memory palace, papers (OpenAlex straight from the phone), letters, presentation rehearsal, grades with the degree and Moed B, academic English, the days before the exam, hard cards with a model fix, the card timer, "::" note cards, reading in portions, a two-voice podcast, where a term appears, quiz talk, a similar problem and a photo of the exercise, and the timetable (by hand or from a photo) with the class now on the home page.
- Not alone: the live quiz, the focus room and the group-project link (others need a server to reach), a scanned PDF (Windows' PDF renderer and OCR), and YouTube search (the phone has web search for videos and articles).
- Built (2026-11-17, design PhoneAlone): apps/android/www/phone-study-plus.js, with sources and the palace syncing with the computer; checked at 390 px (study-check.mjs, 22 checks).
- Found on the PC while testing: photos went to a model with no vision → 0.6.344 reads photos with a vision model.
- Stopped at: done; next, the timetable photo is tested again on the PC with 0.6.344.

## Open source for users and developers (2026-11-17, t134, Roee: "how open-source projects feel to users and developers")
- Obsidian: a GitHub template (obsidian-sample-plugin) cloned into a test vault's plugins folder, `npm install`, `npm run dev` rebuilds on save, enable in Settings, a Hot-Reload plugin; five steps, one page. Publishing: a PR to a community list, reviewed once. The SDK (`obsidian`) is on npm, so a plugin lives in its own repo.
- Zed: an `extension.toml` in any repo; most extensions need no code; "Install Dev Extension" from the running app (overrides the published one, with a note); logs with `zed --foreground`. Friction: Rust/WASM targets, publishing rules on other pages.
- VS Code: `npx yo code` makes a ready project; F5 opens a second window running the extension; `vsce package/publish`; the API is typed and on npm.
- Blender: `blender_manifest.toml`, `blender --command extension build`/`validate`, "Install from Disk" in Preferences, the Text editor runs scripts in the app; extensions.blender.org reviews uploads.
- ComfyUI: a custom node is a folder in custom_nodes; `comfy node init` writes pyproject.toml, `comfy node publish` (or a GitHub Action on a version bump) puts it in the Registry, which ComfyUI-Manager installs from.
- Open WebUI: tools/functions are single Python files pasted in the admin UI or imported from its community site; developing the app itself needs Python + Node, two terminals, the `dev` branch.
- LobeHub / Godot: LobeHub plugins are a manifest + an API (plugin SDK on npm) and an index PR; Godot has the in-editor Asset Library and GDExtension templates; both have "good first issue" labels and a contributing guide.
- What makes them easy: (1) a template outside the main repo with the SDK from npm; (2) load a plugin from a folder in the running app with reload on save; (3) one command that checks a plugin before publishing; (4) logs a click away; (5) a gallery inside the app; (6) labelled first issues and a short contributing path.
- KesherAI now: `pnpm create-plugin` makes a plugin inside the monorepo (needs the whole repo built); the installed app loads `~/.kesher/plugins/` and installs any GitHub repo (topic `kesherai-plugin` lists it in Community); plugins reload when turned on or off; PLUGINS.md, CODE_GUIDE.md, AGENTS.md, CONTRIBUTING.md, issue and PR templates; tests are node:test. Missing: the SDK is not on npm (a plugin cannot live in its own repo without the monorepo), no "load from folder" or watch-reload in the installed app, no `plugin check`, no first-issue labels.
- Plan (FUTURE_FEATURES "Open source"): publish @kesher/plugin-sdk to npm with a template repo; Settings → Plugins → "Load a folder (development)" with reload on save and its log; `pnpm plugin:check` (manifest, permissions, size, a test run); "good first issue" labels on small board tasks; a 10-minute "first change" walk-through in CONTRIBUTING.
- Stopped at: research done; the plan is in FUTURE_FEATURES; building the "load a folder" and "plugin check" pieces next.

## Screen lens, part 2: on the phone's own screen (2026-11-17)
- Google Circle to Search: long-press home or the navigation bar (system-level, Pixel/Samsung only); draw around anything; results in a sheet over the app.
- Open-source alternatives (CircleToSearch on F-Droid/IzzyOnDroid, QuickLens): set as the default assistant (home long-press) or a floating bubble / status-bar double tap; capture through MediaProjection or an accessibility service; draw a circle; only the marked part is processed (on-device Tesseract OCR in CircleToSearch).
- A floating OCR-translator bubble (dev.to write-up): SYSTEM_ALERT_WINDOW through Settings → "display over other apps", a not-focusable bubble that switches to a focusable window while marking, MediaProjection capture cropped to the selection (800 ms → 200 ms), Xiaomi/OPPO add their own overlay limits, users need a first-run guide for the permission.
- KesherAI has: the phone plugin KesherScreen (MediaProjection start/frame/stop), Share → KesherAI into the phone's chat with the lens's four actions (built today), the computer's lens with a circle.
- Plan: (1) "KesherAI as the default assistant" (an ASSIST intent: home long-press opens the phone's lens on a fresh screen capture), no overlay permission needed; (2) an optional bubble later. Both need native Android code tested on a real phone.
- Stopped at: research done; waiting for a phone test session (the code cannot be checked without a device).

## Students, part 37: the first day of the semester (2026-11-17)
- MyStudyLife (10M+ students): add classes by hand (days, times, rotation weeks), then exams and tasks; its 2026 "AI Schedule Scan" turns a photo of the timetable into the schedule. Eduplanner: a syllabus file becomes a board of deadlines and topics. Reclaim.ai puts study goals into free calendar slots.
- KesherAI has: a timetable from a photo (computer and phone), a syllabus reader (exams, assignments, weekly topics), Moodle, "My week", goals; but the first visit asked for one course by name.
- Built (2026-11-17, design StudyWelcomePhoto): the first visit offers "all my courses from a photo of the timetable": each course is opened and every class goes into the timetable, then the goal step as before.
- Built too: "My week" suggests a time for each step in the free hours around her classes (after 16:00, 15 minutes after a class, not on top of another step).
- Stopped at: done.

## Students, part 38: a guided first setup for Study (2026-11-17, Roee: "the first setup of Study should be the easiest and most comfortable there is, really guided and explained")
- What others do: Duolingo asks the language and level, then a 2-minute first lesson (value before anything else); Quizlet asks what you study, the school and a course, then shows material for that course; Knowt walks through a sample PDF becoming notes, cards and a quiz before asking anything; StudySmarter and Seneca ask subjects and exam dates first. The common thread: the first questions are about what she studies, and the setup ends inside the product with something already made, not on an empty page.
- Wizard rules from onboarding research (Appcues, Kompassify, UX pattern guides): 2–4 steps (completion falls after 5), one question per screen, an honest "step 2 of 4", every step skippable with the skipped items kept in a checklist (deferred, not lost), progress saved so leaving and coming back resumes, sensible defaults, permissions (microphone, camera) asked only at the step that needs them, and finish inside the work.
- KesherAI had: three steps (first course or all from a timetable photo, a daily goal, simple view), then "add a first lecture". Nothing about her field, whether a model can actually do the work, the phone, or what each step is for; skipped items were gone.
- Plan (designs StudySetupWizard + StudySetupChecklist, computer, remote and phone alone):
  1. "What do you study?" field chips (nursing, medicine, law, engineering, psychology, other) and year: picks the field tools and the words the model uses.
  2. "Your courses": all from a timetable photo, or the first course by name with its exam date.
  3. "Will it work on this computer?": checks the chat model (Hebrew, enough memory) and speech-to-text for recordings; when missing, names the suggested model, its size and time, and downloads only when she taps. On the phone alone: the phone's own model.
  4. "Your first lecture": record now, upload a file, or later; ends inside the course with a three-point tour (summary, cards, quiz).
  - Each step says in one line why it is asked. A "Getting set up" checklist on Study's home keeps what was skipped plus the extras (connect the phone with a QR code, a daily goal and reminder, simple or all tools), each with its reason; it goes away when done or dismissed.
- Built (2026-11-17): the computer wizard and list (design StudySetupWizard / StudySetupChecklist) and the phone-alone wizard and list (StudySetupWizardPhone). Tested end to end at 1280 and 390 and in study-check.
- Stopped at: built; left to do: a pass on Roee's PC in a separate test profile after the 06:00 release, and on his phone in the morning.

## Students, part 39: coming back after a few days off (2026-11-18)
- Why people leave spaced repetition: after 4–5 days away they come back to hundreds of due cards with no idea when it ends, and some quit (Anki forum "Backlog Recovery Planner" proposal; medical-school backlog guides). What helps: a chosen pace (about +20% or +50% a day over the usual reviews), a date when the backlog ends, a cap per session, the young cards (learned lately, few reviews) and those due most recently first, new cards going on as usual. Duolingo keeps habits with visible progress and commitment, not with bigger piles.
- KesherAI had: FSRS due cards per course, oldest first, up to 50 a session; the home said "Review 240 cards" with nothing else.
- Plan (design BackOnTrack, computer and phone): when a course's due cards pass twice her usual day (and at least 40), a card "Back on track": her usual day (reviews a day over the last two weeks), a pace (gentle +20% / steady +50%), "N a day, back on track by <day>", and "Today's N" that reviews only today's portion, young and recent cards first. The rest waits without a red number.
- Built (2026-11-18): computer and phone (designs BackOnTrack / BackOnTrackPhone).
- Stopped at: built.

## Chat reports: importing with feedback, and chats already uploaded (2026-11-18, Roee from the phone)
- Roee: importing a Brandon report by link showed only "Importing…" for a long time and no tab opened; he wants a lot of feedback while it runs, and to pick a chat he already uploaded instead of uploading it again.
- What Brandon Thinks (looked at whatbrandonthinks.com today): the setup is one question a screen, "1 of 7"; the upload screen has a tutorial and an email fallback ("Can't find your chat file? Send it by email instead"); reports live in the account ("Open your account"). The report page is behind a sign-in (email code), so the link only reads when KesherAI's own browser is signed in there.
- Found: the import was one long request (open the page, then the whole model reading) with no steps; the page opens in KesherAI's browser on the computer, invisible from the phone; and a sign-in page could be read as the "report". The import itself did work (a report was being written, part 5 of 10).
- Built (design ImportSteps / ChatPick): the import returns at once and the report page shows each step live (open the link → wait for the page, with its length → read → part 3 of 8 → lay it out), says clearly when the site asks to sign in and what to do, and a report left "being written" by a restart shows as stopped with a way forward. In a new report, step 3 lists the chats already uploaded (one per chat) to start from without uploading again.
- Stopped at: built.

## Students, part 41: attendance (2026-11-18)
- Many Israeli courses require attendance (often 80% of the practice sessions or seminars, or "at most 3 absences"); missing one too many can cost the course. Attendance apps (Absentify, AttendMate, MyCollegeMate) mark each class as attended / absent / excused / cancelled, take either a minimum percent or a maximum number of absences per course, and warn before the limit.
- KesherAI had: the timetable (classes by day, "now" and a reminder to record), nothing on attendance.
- Plan (design Attendance / AttendancePhone): turned on once ("Track attendance"); after each class ends, "Were you there? ✓ / ✗ / cancelled" on the Study home (computer) and the home banner (phone), up to a week back; per course, there of held with the percent, a rule (N absences or N%) and "N absences left", amber at the last one, red over it. Kept in the timetable, so it syncs between the phone and the computer with it.
- Built (2026-11-18): computer and phone. The computer's banner and card now share one copy of the timetable (a mark in one is no longer undone by a save from the other).
- Stopped at: built.

## Students, part 40: a quiz question that is wrong (2026-11-18)
- Gemini Notebook's November update lets a student edit quiz questions afterwards and ask where she fell short (Digital Trends). Quizlet and Knowt have "report this question". With a local model the risk is larger: it writes the key itself, and a wrong key teaches the wrong fact and lowers her score and her mastery.
- KesherAI had: "What should I learn from this?" after a quiz (QuizTalk), calculation questions checked by code; nothing for a wrong key.
- Plan (design QuestionCheck / QuestionCheckPhone): under a missed question, "I think this question is wrong" → "Check against the lecture" (the model reads the lecture it came from and answers right / fix / broken with a quote) or "My answer is right". A fix moves the key and recounts the score; a broken question leaves the quiz and the score, so weak topics and mastery stay true. Computer and phone.
- Built (2026-11-18): computer and phone.
- Stopped at: built.

## Models for Hebrew study (2026-11-18)
- Dicta-LM 3.0 (Dicta, Apache 2.0) comes in three: 24B (on Mistral Small 3.1, the strongest), Nemotron 12B (on NVIDIA's Nemotron Nano V2, a hybrid-SSM that holds very long contexts in little memory) and 1.7B (on Qwen3, for weak laptops). Official GGUFs: dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF (Q4_K_M 7.5 GB; the most downloaded), dicta-il/DictaLM-3.0-24B-Thinking-GGUF, dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF (Q4_K_M 1.1 GB).
- Tonight's failures ("Context size has been exceeded" on long Hebrew reports with a 32K context) are the case for the 12B: long contexts cheaply.
- Built: the 12B in "Start here", offered in Study's setup beside a non-Hebrew model. Next (future list): tools suggest a better model when they start; a check that llama.cpp runs Nemotron-H on the PC after the download.
- Checked on the PC (2026-11-18): llama.cpp b12110 loads the 12B (Nemotron-H) and answers in correct, fluent Hebrew (a CPU-only test beside the busy card: 3.3 tokens a second; on the card it will be far faster).
- Stopped at: built and checked.

## Per-change undo in the run review, against Zed and Cursor (2026-11-18)
- **Zed** and **Cursor** both let you reject one hunk of an agent's edit and keep the rest; KesherAI had undo per run
  and per file only.
- Built: Review (on a run's receipt) shows ↶ on each "@@" change; it puts back only that change
  (`undoRunHunk`, `undoHunk` in the agent package; `POST …/runs/:run/undo {path, hunk}`). The file's fingerprint is
  updated, so "Undo all" later sees no false conflict. A file new in the run is put back whole (no ↶ per change).
- Follow the agent was already built (👁 Follow in the workspace); FUTURE updated.
- Stopped at: built and tested; hosted API docs wait for Roee (a public GitHub Pages site).
- Checked on the PC (0.6.361, card freed): the lip sync self-test moves the lips: vsClip 10.5, between frames 2.3,
  96 frames in 4 s (24 fps). Qwen3-Coder-Next is not downloaded (download waits for Roee).
- Hosted API docs: `.github/workflows/docs.yml` builds typedoc on every release and deploys it to GitHub Pages; it
  stops if the site names a Windows user folder, a home folder or a Gmail address (the local build had none).

## Tools suggest a better model (2026-11-18)
- **AnythingLLM's Model Router**: a primary model plus rules checked top to bottom; "calculated" rules (keywords,
  conversation tokens, an image attached, time of day) and rules a model classifies; it switches by itself.
- **Msty's Model Matchmaker**: choose what matters for the task and get ranked suggestions to try side by side.
- **Cursor**: an image in the chat and a model without vision gives an error; users ask for a warning and a way on.
- **LM Studio**: marks each download as fitting fully on the card, partly, or too big for the computer.
- Built (Roee asked for one smart score that joins all the checks): every model (loaded, on the computer, "Start
  here") gets 0–100 for a tool on this computer: quality by parameters (40), fit for the tool (35: Hebrew → Dicta
  first; code → coding models first; long reports → long-context models), speed here from the Models page's own
  estimate (25; too big = 0, never offered). A line shows when another model is 8 or more higher: the best one on the
  computer and a better download, each with its score (parts on hover), size and whether it fits on the card; and a
  short-context warning for long reports. Never switches by itself; "Keep" is remembered per tool and model. Study
  counts the Hebrew model it already loads by itself (course model "auto").
- Stopped at: built and tested; checking on the PC after the next release.

## Stremio's watch history (2026-11-18)
- Stremio gives addons nothing of her library. Two ways others use: **Stremio's own API** (api.strem.io `login` →
  a session key, `datastoreGet` on the `libraryItem` collection: name, type, timesWatched, flaggedWatched,
  overallTimeWatched, duration; used by stremio-api-client, the Rust `stremio` crate and trakt-stremio-import), and
  **Trakt** (Stremio's official Trakt integration scrobbles there; Simkl and MyTrakt Sync do the same).
- Built both (Roee: "both"): sign in to Stremio on the Stremio page (password only to Stremio, only the session key
  kept, "Sign out" ends it at Stremio), and Trakt with the device code and her own Trakt app. Watched items count as
  seen (Stremio's have no year: the same title already rated is not added twice); Trakt's 1–10 become stars.
- Stopped at: built and tested with stand-ins for both services; the real sign-in waits for Roee (he types his own
  password and approves the Trakt code).

## Magic Tab, step 2: reading the text at the caret on the PC (2026-11-18)
- Tried from KesherAI's terminal with Windows' own UI Automation (no new dependency): a small test window of its own
  (never one of Roee's apps), then another process finding it and reading the text before the caret and the caret's
  box through TextPattern.
- Found: a WinForms window is found by name, but its text box shows only as a "Pane" with no text support from that
  process; a WPF window started the same way did not appear in time (the terminal's hidden child). Starting test
  windows from the terminal is not a fair test of a real app.
- Next (at the keyboard, with Roee): a small C# helper started by the desktop app in his session, reading the focused
  element (`AutomationElement.FocusedElement`, TextPattern / TextPattern2 caret range) in Notepad, Word and Chrome
  (Chrome exposes UIA once an accessibility client asks), measuring the time per read; then the overlay and the key
  hook. Step 1 (a small model's speed beside the big one) can be measured any time the card is free.
- Stopped at: step 2's first try (above); continue at the keyboard.

## What competitors added lately, against KesherAI (2026-11-18, Roee asked for new ideas)
- **Open WebUI 0.11 / 0.11.1**: built-in slash commands (`/compact`, `/fork`, `/status`, `/model`) beside saved prompts;
  chat variables (a prompt asks for its fields in a small form before sending); notes with full chat that edits the
  note; usage heatmap and streaks; hover previews of chats; remappable shortcuts; tool-call approvals; `ask_user`;
  sub-agents; delta streaming.
- **LM Studio 0.4.24–0.4.26 and Bionic 1.1–1.2**: per-load llama.cpp argument overrides; a shared canvas exported to
  PNG/SVG/Excalidraw; in-app previews of Word, spreadsheet, presentation, CSV and HTML files; read-aloud; a terminal;
  LM Link (remote chats, projects and fast file transfer between devices); automatic compaction.
- **Already in KesherAI**: hover previews, remappable keys, usage heatmap and streaks, approvals, ask_user, groups and
  delegation, compaction, canvas export, read-aloud, the terminal, the phone link, streamed deltas.
- **Not yet in KesherAI** (proposed to Roee): (1) built-in slash commands (/compact, /fork, /model, /new, /status) next
  to saved prompts; (2) prompt fields: `{{name}}` / `{{tone:formal|casual}}` in a saved prompt asks for them in a small
  form; (3) previews of Word, Excel, PowerPoint and CSV files in the chat and the workspace (attached or written by
  the agent); (4) engine arguments per model (today one set for all models).
- Stopped at: the list above, waiting for Roee's pick.

## A new icon for KesherAI (2026-11-18, Roee: "at the level of our competitors, in our design lines")
- AI brands converge on circles, gradients and neural shapes ("blanding"); the advice is to keep the shared frame and
  stand out by one detail of shape (proportion, angle, negative space), not by colour. Each platform also needs its
  own form: Android adaptive layers with a monochrome layer (themed icons, Android 13+), a white status-bar icon,
  Windows 16/24 px legibility, a one-colour tray icon, macOS's rounded square, maskable web icons.
- Three directions on our rings (periwinkle on deep ink), checked on an Android home screen, themed icons, the
  Windows taskbar and tray, the Mac dock, Chrome's toolbar and the sidebar in dark and light (design AppIcon).
  Roee chose **B, the lit lens**: where the two rings meet, it lights up.
- Found while placing it: the desktop installer had no icon (Electron's default), the Android app had Capacitor's
  default launcher icon, notifications used system icons, and the extension used a different blue icon.
- Built: assets/brand/ (the drawings) and scripts/brand-icons.mjs (every size from them): web and PWA icons,
  build/icon.png for electron-builder, the extension's 16–128, the Android launcher icons (legacy, round, adaptive
  with a monochrome layer, copied in by CI) and a white status-bar icon for KesherAI's notifications, and BrandMark
  in the sidebar and the welcome screen (deeper colours on light themes through light-dark()).
- Stopped at: built; the landing page's icon (roeetal.com/KesherAI/media/icon.svg) is in Roee's site repo.
- Built (proposal 1): the chat's own `/` commands first in the `/` menu (accent colour) before saved prompts:
  /compact (a summary on demand that the model keeps reading while the rest fits; `compactNow`), /fork (a copy from
  the last message), /model (by part of the name), /new, and the existing /status, /goal, /side. Next: prompt fields.
- Built (proposal 2): prompt fields with Open WebUI's own syntax (`{{name}}`, `{{x | select:options=[…]:default=…:required}}`,
  number, checkbox, textarea, date), so prompts copy between the two; `@kesher/shared` prompt-fields, a small form above
  the box (SlashMenu), a hint on the Prompts page. Next: Office and CSV previews.

## Load settings per model (2026-11-18, the fourth of the competitor proposals)
- **LM Studio**: My Models → ⚙ per model: default load settings (GPU offload, context, flash attention), also saved from the load dialog, used by `lms load` too; 0.4.24 added "advanced llama.cpp argument overrides" for GGUF loading. **llama-swap**: a `cmd` line per model in its config. **Ollama**: `PARAMETER` lines in a Modelfile.
- **Built**: Models → ⚙ next to each GGUF: context, context memory (16/8/4 bit), MoE layers on the processor, flash attention, and more arguments. Saved by file name in config (`engines.modelSettings`) and put on top of the engine's own arguments at each load (the same flag under any spelling is replaced). "Save and reload" loads the running model again.
- **Safety**: the phone can reach this screen, so more arguments come only from an allowed list of load and sampling flags (no file, port, address or key flags), checked on the server too.
- Stopped at: built and tested (878 pass); to try on the PC with Qwen3-Coder-Next when the download ends.

## Relationship analysis: exes (2026-11-18, Roee asked)
- **Competitors**: Mei/Amori ("why my ex ghosted me"), and the shared "AI read my texts with my ex" analyses: compatibility, attachment and communication styles, the best moments, why it would not work. Texts From My Ex is a humour archive, not analysis.
- **Built**: a sixth kind, "Exes" 💔: the report tells the story over time (start, best period, where it turned, the patterns on both sides) and what to take into the next relationship and how to close this one; it never advises getting back together or contacting the other person, and never blames one side alone.
- Stopped at: built (0.6.366).

## The extension asks per site (2026-11-18, from the Chrome Web Store's warning)
- **Pattern**: Claude in Chrome and most agent extensions ask per site; Chrome MV3 `optional_host_permissions` plus `permissions.request`, which needs a click (so a background task cannot ask by itself).
- **Built** (extension 0.2.6): no sites at install. A task on a site not allowed opens a small window (Allow on this site / on all sites / Not now) and waits up to two minutes; "Ask about this page" and the lens ask for the site in front from the click itself (the site is tracked ahead so the question comes straight from the click). The popup has "Allow on all sites".
- **Tested** in Chromium with the extension loaded: no sites at install, the window opens on a task, "Not now" gives a clear error.
- Stopped at: done; Roee uploads 0.2.6 to the store after the current review.

## Editors for every kind of output, part 1: pictures (2026-11-18, Roee asked; FUTURE "Editors for every kind of output")
- **Krita AI Diffusion** (open source, ComfyUI behind it): select an area → generative fill / expand / add or remove objects only there; live painting (the model redraws as you paint); regions (a prompt per layer); control layers (scribble, line art, depth, pose as an editable vector layer); upscale to 4K+ in tiles; a job queue that keeps working while you paint; a history of results and prompts to pick from.
- **Invoke** (open source): the canvas with a bounding box (what gets made; drag it outside the picture to extend it), an inpaint mask brush, every result, mask and paint as its own layer, full undo, a gallery that keeps every result.
- **Photoshop Generative Fill**: lasso → a prompt → three versions to pick from, each as its own generative layer (non-destructive).
- **For KesherAI**: the picture editor = layers + a selection or mask brush + "what to do here" + several versions to pick from (as Photoshop's three), on top of the ComfyUI and sd.cpp KesherAI already runs; results become layers; "Send to the chat" puts the flattened picture back.
- Stopped at: pictures done; next video (Premiere, Resolve, CapCut, Runway, Descript), then sound, then 3D, then the tab system.

## Editors, part 2: video (2026-11-18)
- **Descript**: the transcript is the editor (delete words and the clip is cut there), filler words removed in one go, its agent (Underlord) does edits asked in words. **CapCut**: a simple timeline, auto captions, background removal, clips cut out of a long video. **Premiere Pro**: Firefly text-driven edits, Generative Extend (a few more seconds made by a model at the end of a clip), auto reframe for a phone's shape. **Runway**: a clip changed by a prompt (Aleph: restyle, remove or add things in a video), effects. **Opus Clip**: a long video into short vertical clips.
- **For KesherAI**: the video editor = a timeline (clips, cut, trim, order, sound) + the transcript as a second way to cut (KesherAI already transcribes with whisper) + captions from it; "mark a stretch and say what to do" sends that stretch to the video model (Wan through ComfyUI) or to ffmpeg for plain edits; reframe for the phone with ffmpeg.
- Stopped at: video done (from summaries; the detail pages of the tools are still worth reading before building); next sound (Audacity, Ableton, Descript Studio Sound, ElevenLabs, Suno's editor), then 3D, then tabs.

## Editors, part 3: sound (2026-11-18)
- **Descript**: edit the sound as a document (delete words, filler words go in one go), Studio Sound (noise and echo), Overdub patches a line in a cloned voice, auto loudness. **ElevenLabs**: Speech Correction (fix the transcript's words and only that line is spoken again), voice isolator, voice changer. **MusicGPT / Suno-style music editors**: stems (voice, drums, bass…), regenerate, extend and inpaint a stretch of a song, mastering to a reference track. **Adobe Podcast Enhance**, **Auphonic**: one-click clean-up and loudness. **Audacity**: the waveform with cut, fade, volume, effects.
- **For KesherAI**: the sound editor = a waveform with cut, fade, volume and loudness (ffmpeg), the transcript as a second way to edit (whisper, already in KesherAI), "fix this line" in the user's own voice (the voice clone KesherAI has), clean-up (noise and echo), and for music: stems, then "mark a stretch → redo / extend" with the music model.
- Stopped at: sound done; next 3D (Blender, Spline, Meshy, Tripo), then the tab system.

## Editors, part 4: 3D (2026-11-18)
- **Meshy Edit** (October 2026): select a part with a lasso (all sides) or a brush (what is seen), one sentence ("remove the hat"), up to five reference pictures; only the selection changes, each edit is a new version and the original is kept; about a minute. **Tripo Studio**: AI segmentation into parts (each part textured, retopologized or rigged alone), retopology (quads or triangles, low poly), AI textures from words or a picture and a "magic brush" for local touches, auto rigging with an animation library to try, export to FBX/OBJ/USDZ/GLB/3MF and a bridge to Blender. **Blender**: the full tool; AI add-ons bring generation and texturing into it.
- **For KesherAI**: the 3D editor = a viewer (turn, zoom, light, wireframe), parts as a list, select a part (lasso or brush) + a sentence → a new version (the original kept, versions side by side), retexture and low poly, export, "Send to the chat", and "open in Blender / Unreal / Unity" since KesherAI already drives them. Needs a 3D library in the page (three.js or model-viewer: waiting for Roee's yes, as for GLB previews).
- Stopped at: 3D done; next the tab system (VS Code, browsers, Figma, Photoshop's document tabs; how each works on a phone), then a design proposal for the editors.

## Editors, part 5: tabs (2026-11-18)
- **VS Code**: a row of tabs per editor group; a preview tab (italic) is replaced by the next file until edited or double-clicked; pinned tabs; a dot for unsaved; split into groups side by side; Ctrl+Tab cycles, Ctrl+W closes, middle-click closes; tabs reopen after a restart. **Browsers**: drag to reorder, pinned tabs, groups with a colour and a name, a switcher (Ctrl+Shift+A) to search open tabs; on a phone a grid of cards with a counter on the button. **Figma / Photoshop**: one tab per document, the home (files) always first; a dot or an asterisk for unsaved.
- **For KesherAI**: a tab row under the top bar on the computer: Home first and fixed, then chats, editors, documents and pages; preview tabs (a single click on a result opens a preview tab that the next one replaces; editing keeps it); a dot while unsaved or while a chat is answering; Ctrl+Tab / Ctrl+W; split two tabs side by side; tabs come back after a restart. On the phone (390 px): the open tabs as a counter on the top bar that opens a grid of cards (as phone browsers), with the computer tabs that already exist at the top of the side menu.
- Stopped at: research done (pictures, video, sound, 3D, tabs); next a design proposal in the design doc for Roee to approve, then the build in order: tabs first (everything else opens in them), then the picture editor, then video, sound and 3D.

## The picture editor, in depth (2026-11-18, Roee: "deep research on its features, especially AI, before building")
**Photoshop 2026**: Generative Fill (select → prompt; Firefly Image 5 and partner models Flux Kontext and Gemini 2.5 "Nano Banana" to pick from; a reference picture keeps an object's shape and style); Generative Expand (crop wider, the new area is filled); Remove tool + Find Distractions (it finds people, wires and clutter; you adjust before removing); Harmonize (a pasted object takes the background's light, colour and shadow; 3 versions); Rotate Object (a 2D layer turned in 3D and redrawn); Reflection Removal (a clean layer and a reflection layer); Generative Upscale (Firefly or Topaz, to about 5K); Select Subject and Remove Background on the device (hair, see-through edges); Clarity, Dehaze and Grain as maskable adjustment layers; Layer Cleanup (empty layers gone, layers renamed by content); actions searched in words.
**Affinity 3 (Canva, free)**: non-destructive layers, live filters and adjustment layers, object selection masks, luminosity, hue-range and compound masks; with Canva's AI: Generative Fill, Expand, Remove, Background Removal; a Claude connector writes scripts for repeated jobs.
**Canva Magic Studio**: Magic Edit (replace a brushed area by words), Magic Eraser (most reliable; weak on brick and big areas), Magic Expand (to a new shape; seams in interiors), Magic Grab (a subject becomes a movable layer), Magic Layers (a flat picture into layers, its text into editable text), Background Remover.
**Krita AI Diffusion** and **Invoke** (open source, part 1 above): live painting, regions with a prompt each, control layers (pose, depth, line art), a queue that keeps working, the canvas with a bounding box and an inpaint mask, every result a layer.

**What runs locally for KesherAI** (no cloud): click-to-select = SAM 2; Remove = LaMa (fast) or an inpaint model; Generative Fill and Expand = Flux Fill / SDXL inpaint / Qwen-Image-Edit in ComfyUI (Qwen-Image is already on the PC); edits by words on the whole picture = Qwen-Image-Edit or Flux Kontext; Background removal = BiRefNet / RMBG; Harmonize and relight = IC-Light; Upscale = Real-ESRGAN (fast) or SUPIR (detail); depth for Rotate-like and lens blur = Depth Anything; text in the picture into editable text = OCR (already in KesherAI) + inpaint behind it.

**The plan (in this order)**:
1. The editor: layers (pictures, AI results, text, adjustments) non-destructive, select (rectangle, lasso, brush, click-to-select), mask, crop, undo/history; open from a chat's picture as a tab; Save (a project file keeps layers) and Send to the chat (flattened PNG back into the same chat).
2. AI on a selection: "what to do here" → 3 versions to pick (as Photoshop) → a new layer; Remove (one click, no prompt); Expand (drag the canvas larger); a reference picture.
3. AI on the whole: edit by words (Qwen-Image-Edit), remove background, upscale, harmonize a pasted layer, find distractions.
4. Later: live painting (Krita), control layers (pose, depth), regions, Magic Layers (a flat picture into layers).
Each AI tool shows which local model it uses and offers to download it the first time (as the model score does), and the phone gets the same tools (a bottom tool bar, tap to select).
- Stopped at: picture editor research done; next build step 1 (the editor) after the tabs, with its design boards updated for steps 1–2 first.

## The video editor, in depth (2026-11-18)
**Premiere Pro (2025–2026)**: text-based editing (a rough cut from the transcript, pauses and filler words removed in bulk), speech to text with speakers and captions, caption translation (27 languages), Media Intelligence (find shots by describing them), scene edit detection (a long video into its shots), Generative Extend (frames, and matching sound, added at a clip's start or end), AI object mask (hover and click, tracked), Enhance Speech, auto ducking, Remix (music retimed to the video's length), auto reframe (16:9 → 9:16 following the action), auto colour, colour match, morph cut, audio tagging (music, dialogue, effects), an assistant that organises footage and syncs multicam.
**DaVinci Resolve 20**: IntelliScript (the transcript matched to a script → a timeline of the best takes), IntelliCut (silences removed, one track per speaker), Multicam SmartSwitch (the angle follows who speaks, by sound and lips), Magic Mask 2 (track people or things from points, refine with a brush), Depth Map 2, Set Extender (missing parts of the frame from a prompt), SuperScale (×3, ×4), UltraNR (denoise), Dialogue Separator, Dialogue Matcher, VoiceConvert, Audio Assistant (a finished mix), beat markers for cuts.
**CapCut**: a simple timeline, auto captions with styles, background removal, a long video into shorts, templates. **Descript**: the transcript is the editor, filler words, Underlord does edits asked in words. **Runway**: a clip changed by a prompt (Aleph: restyle, add or remove things), effects.

**What runs locally for KesherAI**: transcript and speakers = whisper (already) + speaker split; scene detection, cuts, silence removal, reframe, captions burned in = ffmpeg; find shots by describing them = a vision model on key frames (KesherAI's own); object mask tracked = SAM 2 (video); extend a clip or fill a gap = Wan (first/last frame) in ComfyUI; restyle by a prompt = Wan video-to-video; upscale = Real-ESRGAN per frame; smoother motion = RIFE; dialogue separated from music = Demucs; beat markers = an onset detector; denoise = ffmpeg's filters.

**The plan**:
1. The editor: a timeline (video, sound and caption tracks), cut, trim, move, split, speed, fade; the transcript beside it, where deleting words cuts the video; open from a chat's clip as a tab; export with ffmpeg; Send to the chat.
2. Plain AI: remove silences and filler words, captions (and translated), scene detection, reframe for the phone, find a shot by describing it, beat markers.
3. Generative: mark a stretch → "what to do" (restyle, remove a thing, extend the end) with Wan; object masks with SAM 2.
4. Later: multicam by who speaks, a script to a rough cut (IntelliScript), a finished mix.
- Stopped at: video done; next sound in depth (Audition, Logic/Ableton AI, iZotope RX, Descript, ElevenLabs, Suno Studio), then 3D in depth (Blender, Substance, Meshy, Tripo, Spline); boards for Roee after each.

## The sound editor, in depth (2026-11-18)
**iZotope RX 11/12** (the repair standard): Repair Assistant (listens and suggests a repair chain), Dialogue Isolate (voice out of noise, with de-reverb), Dialogue Contour (reshape a line's pitch), Music Rebalance (stems by a neural net, each with a volume and a mute), Loudness Optimize and a streaming preview, a spectrogram you paint on to remove a cough or a phone ring, de-click, de-hum. **Logic Pro (2024–2025)**: Stem Splitter (vocals, drums, bass, other), Session Players (AI drummer, bass and keys that follow the song and take direction), Mastering Assistant, Chord ID. **Suno Studio 2.0**: a timeline of AI tracks, stems (up to 12, lead and backing vocals apart), MIDI in and out (a MIDI clip as a prompt), a synth, a chat assistant that adds instruments and tidies the session; the song editor replaces or extends a section. **Descript**: edit the words, filler words, Studio Sound, Overdub. **ElevenLabs**: fix a line's words and only it is spoken again, voice isolator, voice changer. **Adobe Podcast / Auphonic**: one-click clean-up and loudness. **Audition**: the waveform and spectrogram, multitrack, Essential Sound (dialogue, music, effects presets), remix to a length.

**What runs locally for KesherAI**: transcript = whisper (already); stems = Demucs (htdemucs: vocals, drums, bass, other); voice out of noise = DeepFilterNet; "fix this line in my voice" = the voice clone KesherAI already has; music sections = the music model on the Models page (generate, extend, inpaint a stretch); loudness, fades, cuts, speed = ffmpeg (loudnorm); beats, tempo and key = an onset and key detector; the spectrogram = drawn in the page from the samples.

**The plan**:
1. The editor: a waveform (and a spectrogram view), cut, trim, fade, volume, speed, several tracks; the transcript beside spoken sound (delete words → cut); open from a chat's sound as a tab; export; Send to the chat.
2. Plain AI: clean up (noise, echo) with a strength, remove silences and filler words, loudness for a target (podcast, YouTube), stems for music with a slider each.
3. Generative: "fix this line" in her voice, mark a stretch of music → redo / extend / replace in a style, a backing track from a melody.
4. Later: paint on the spectrogram to remove a sound, session players, a repair assistant that suggests the chain.
- Stopped at: sound done; next 3D in depth (Blender, Substance 3D, Meshy, Tripo, Spline, Rodin), then boards for video, sound and 3D for Roee.

## The 3D editor, in depth (2026-11-18)
**Commercial AI 3D in 2026**: Meshy 6 → 7.1 (image to 3D, geometry aligned to the picture) and Meshy Edit (lasso or brush a part + a sentence → a new version, the original kept), Meshy N1 texturing; Tripo P1/H3.1 → P2.0 (native 3D diffusion), Tripo Studio (AI parts, retopology to quads or low poly, AI textures and a magic brush, auto rigging with an animation library, Blender bridge) and its Agentic Canvas; Rodin Gen-2.5 with Agentic Mode and rigging edited by a prompt. **Substance 3D Painter 2026**: no AI in the painter itself; Warp to Geometry (decals on curved or holed surfaces), ribbon assets along a path, texture generators, OpenPBR. **Blender**: the full tool; AI arrives through add-ons (generation, textures, MCP bridges).
**Open models that run on Roee's card (RTX 3090, 24 GB)**: Hunyuan3D 2.1 (shape + PBR textures, Tencent licence), TRELLIS.2 (a picture to a PBR mesh, MIT, about 24 GB), Pixal3D (MIT, single and multi view), Hi3D (refines a rough mesh with a reference picture); for the steps after: part segmentation (PartField-style), retopology (Instant Meshes / QuadriFlow), rigging (UniRig), textures (Hunyuan3D-Paint).

**The plan**:
1. The viewer (done in 0.6.369: turn, zoom, wireframe, triangles) → the editor: parts as a list (from the file's meshes), hide, colour or material per part, a light setup, measurements, export GLB/OBJ/FBX, Send to the chat, "open in Blender / Unreal / Unity" (KesherAI already drives Unreal and Unity).
2. Plain AI: low poly / retopology, re-texture from words or a picture (Hunyuan3D-Paint), a picture of the model from any angle for the chat.
3. Generative: a picture or words → a model (Hunyuan3D 2.1 or TRELLIS.2 in ComfyUI), mark a part → a sentence → a new version (as Meshy Edit: regenerate the part with the rest kept), auto rig.
4. Later: an animation library to try a rigged model, 3D printing checks.
- Stopped at: 3D done; all five editors researched in depth. Next: boards for video, sound and 3D (as the picture editor's), for Roee.

## The picture editor, UI/UX in depth (2026-11-18, Roee: "add the competitors' features and UI/UX")
**Photoshop desktop**: tools down one side, options of the tool along the top, panels (Layers, Properties, History, Adjustments) docked on the other side; the **Contextual Task Bar** floats under what is selected and offers the next steps for it (no selection: Select subject, Remove background; a selection: Generative fill with a prompt box, Modify, Mask, Invert; after a generation: ‹ 1/3 › to step through the versions, 👍👎, Generate again); results also show as thumbnails in Properties; Generative Fill makes a generative layer with its mask (non-destructive). Keys: B brush, E eraser, L lasso, M marquee, W object select, V move, Ctrl+Z / Ctrl+Shift+Z, [ ] brush size, space-drag to pan, Ctrl+wheel or Ctrl+± to zoom, Ctrl+J duplicate, Ctrl+Shift+I invert.
**Photoshop on the phone**: undo and redo at the top; a bottom bar with five groups (Layer properties, Select area, Retouch, Paint, Size); layers from a thumbnail in the corner (drag to reorder, ⋯ for merge, duplicate, delete); **tap to select** shows a thumbnail per object found, tap to add, ➖ to take away, ✓ to confirm, then Generative fill (a prompt, or none to extend) or brightness/contrast for the selection; quick actions when a picture opens (hide background, solid colour, black and white); pinch to zoom; the brush keeps its size at any zoom.
**Affinity 3**: a context toolbar that changes with the tool, studio panels you dock or float, personas (develop, edit, export) for different jobs, live filters and adjustment layers.
**Photopea**: Photoshop's layout in the browser (familiar to many), with the same keys; history panel; saves to PSD.
**Canva**: the edit panel of a picture lists Magic Edit, Eraser, Grab, Expand as cards, one tap each.

**What KesherAI's picture editor takes** (added to the boards):
- The canvas in the middle, tools on the start side, Layers / History / AI on the end side (the phone: undo and redo at the top, a bottom bar of tool groups, layers from a corner thumbnail).
- A **context bar under the selection** (as Photoshop's): no selection → Select subject · Remove background · Edit by words; a selection → "what to do here" + Fill · Remove · Expand · Mask · Invert; after AI → ‹ 1/3 › versions, Keep, Again.
- **Tap to select** (SAM 2) with a thumbnail per object found, ➕/➖, ✓ — on the phone and the computer.
- **Quick actions** when a picture opens: remove background, upscale, edit by words.
- Non-destructive: every AI result a layer with its own mask; History with every step; Ctrl+Z / Ctrl+Shift+Z.
- Photoshop's keys (B, E, L, M, W, V, [ ], space-drag, Ctrl+±, Ctrl+J), shown in a "?" sheet.
- Stopped at: UI/UX research for the picture editor done; next update its boards (computer and phone), then build stage 1.

## Tabs that stay out of the way, and a report in chapters (2026-11-18, afternoon)
- Roee: the tab row covers the screen when only one tab is open; wants something more elegant, as competitors do.
- Safari hid the tab bar with one tab for years (users complained when Safari 26 made it always visible); Obsidian users ask
  for "hide the tab bar with one tab"; VS Code has `workbench.editor.showTabs: single`; Firefox once had it (bug 903720).
  Arc, Zed and Linear draw tabs as quiet pills: no boxes, no rule under them, a soft fill on the open one.
- Done: no row with one open place (Home is in the sidebar), pills of 26px, the phone counter only from two tabs, in the
  corner of the top bar rather than over the title.
- Roee: the relationship report should move between pages, "as steps or chapters", like What Brandon Thinks. Brandon's
  report reads as a story one part at a time (as Spotify Wrapped and Instagram stories): progress segments on top, the
  next part by a button or a swipe. Done: seven chapters (empty ones left out), segments and names on top, ← → keys, swipe,
  and "All on one page".
- Stopped at: checking both on the PC after 0.6.373.

## Tabs on the phone, as Chrome and Safari (2026-11-18, 15:05; Roee: "check how others do it, Chrome too, and above all on mobile")
- **Chrome (Android/iOS):** a square with the number of tabs beside the menu, at the end of the top bar. A tap opens
  the tab switcher: cards two in a row, the open one outlined, ✕ on each, and a card swiped aside closes. A long press
  on the square: new tab, close this tab. A swipe along the toolbar goes to the next or previous tab. On the desktop:
  Ctrl+1…8 jump to a tab and Ctrl+9 to the last; middle click closes; hover shows a card.
- **Safari (iOS):** a swipe along the address bar moves between tabs, and the neighbour peeks in from the edge while the
  finger moves (the only browser with a visible hint, per the write-up below); the tab overview is a grid of cards.
- **Firefox and Samsung Internet:** a counter button and a tray of cards; Firefox does not swipe between tabs on iOS
  (a long-standing request).
- Done in KesherAI: the counter moved into the top bar (a slot in AppBar, from two tabs), long press → new chat / close
  this tab, a swipe on the top bar with the neighbour's name peeking in, the switcher full screen on the phone with cards
  two in a row, swipe a card to close, "Close all" and "Done"; Ctrl+1…9 on the desktop. Boards TabsPhoneBar and
  TabsPhoneSwitcher.
- Sources: ssims.co.uk "Mobile Browser Tab Switching and Affordance" (2023), gadgethacks "Swipe Chrome's address bar to
  switch tabs", PCWorld "6 great Chrome gestures for Android and iOS", connect.mozilla.org "Swipe between open tabs on iOS".
- Stopped at: checking on the phone (remote) after the release.

## The video editor's screen (UI/UX), in depth (2026-11-18, 15:20; before building it, as for the picture editor)
- **One layout everywhere** (Premiere, Resolve's Cut and Edit pages, Final Cut, CapCut desktop, Clipchamp): the viewer on
  top, the timeline across the bottom, media on one side and the inspector (the chosen clip's settings) on the other.
  CapCut desktop puts the kinds of things to add as a rail of tabs over the media (Media, Audio, Text, Stickers,
  Effects, Transitions, Captions, Filters, Adjust); Clipchamp the same as a left rail. Resolve's Cut page shows the
  whole video as a thin strip over a zoomed timeline (no zooming by hand).
- **The timeline**: video tracks over sound tracks, captions as their own track; a magnetic main track (Final Cut,
  CapCut): deleting a clip closes the gap (ripple), pull it off to keep the gap. Snap to the playhead, to cuts and to
  beat markers. Thumbnails on video clips, the waveform on sound.
- **Keys everyone knows**: Space play, J/K/L back/stop/forward (twice = faster), I/O in and out, S or Ctrl+K split
  (Premiere C = razor, Resolve B = blade), Q/W trim to the playhead (ripple), Delete / Shift+Delete (ripple),
  ←/→ a frame, Shift+←/→ five frames, +/− zoom the timeline, Ctrl+Z.
- **Phone (CapCut mobile, the model to follow; also VN, InShot)**: the preview on top, the timeline in the middle with
  the playhead fixed in the centre while the clips slide under it, pinch to zoom the timeline, and a bottom bar that
  changes with what is chosen: with nothing chosen it shows what to add (Edit, Audio, Text, Captions, Effects, Ratio),
  with a clip chosen its tools (Split, Speed, Volume, Animation, Crop, Replace, Delete). Handles on the chosen clip to
  trim; long press to reorder.
- **Text-based editing** (Premiere, Descript): a transcript panel beside the viewer; selecting words selects that
  stretch of video; deleting them cuts it; "remove filler words / pauses" in one press, with a list to review first.
- **Where the AI sits in their screens**: captions are a tab with styles (CapCut) and become a track; Generative Extend
  is dragging a clip's end past its last frame (Premiere); Resolve's AI tools are items on the clip's right-click menu
  and the inspector; Descript's Underlord is a chat panel that edits. For KesherAI: the same task bar as the picture
  editor under a marked stretch ("What to do here?": restyle, remove a thing, extend), the transcript tab, and the
  chat beside it (Send to the chat).
- For KesherAI's stage 1: viewer + timeline (video, sound, captions), magnetic main track, split/trim/delete/move,
  speed and volume, the keys above, transcript with delete-to-cut, captions from speech (whisper), export by ffmpeg,
  Send to the chat; the phone as CapCut mobile.
- Sources: Engadget on DaVinci Resolve 20 (IntelliScript, SmartSwitch, beat markers), the 2026 round-ups of AI video
  editors (firecut.ai, morphic.com, massive.io), plus the feature research above.
- Stopped at: video screen done; next the sound editor's screen (Audition, RX, Descript, Logic on iPad) when there is a
  wait again; then boards for both.

## The sound editor's screen (UI/UX), in depth (2026-11-18, 15:25)
- **Two views, one switch** (Audition, RX, Logic): the waveform editor (one file, select a stretch and act on it) and the
  multitrack (clips on tracks). Audition and RX put the spectrogram under or over the waveform with a slider between them;
  RX's selection tools (time, frequency, lasso, brush) work on the spectrogram; the module list (Repair Assistant, De-noise,
  Dialogue Isolate…) sits on the right with Preview / Render, and history on the left with "compare" (A/B).
- **Transport and keys**: Space play, Shift+Space play the selection, loop (L in RX / Q in Audition), markers M, zoom with
  the wheel on the time ruler and a full overview strip on top (as the video editor's thin strip), fades by dragging the
  corner handles on a clip, volume by the line across the clip (Audition's rubber band).
- **Spoken sound** (Descript, Adobe Podcast, Riverside): the transcript is the editor; filler words and long pauses are
  shown struck through with one "remove all"; Studio Sound is one switch with a strength.
- **Music** (Logic's Stem Splitter, Suno Studio, Moises): stems as tracks with a solo/mute and a slider each; Moises on the
  phone shows the stems as a mixer with big sliders, plus key, tempo and chords on top.
- **Phone** (Ferrite on iPhone, GarageBand, Moises, Dolby On): the waveform large and horizontal, the playhead fixed in the
  centre (as CapCut), pinch to zoom, a bottom bar that changes with the selection (Cut, Fade, Volume, Clean up, Split);
  Dolby On is one big "make it sound good" button with a strength and A/B.
- For KesherAI's stage 1: waveform + spectrogram switch, multitrack, select a stretch → the task bar ("What to do here?":
  clean, cut, fade, redo in my voice, extend the music), transcript tab for speech, stems for music, A/B on every effect,
  export, Send to the chat; the phone as Ferrite/CapCut with the fixed playhead.
- Stopped at: sound screen done; next the 3D editor's screen (Blender, Spline, Meshy's editor, Nomad Sculpt on the phone)
  at the next wait; then boards for video, sound and 3D screens.

## The 3D editor's screen (UI/UX), in depth (2026-11-18, 15:30)
- **Blender**: the 3D view in the middle, the Outliner (the scene's parts as a tree, eye to hide) top right, Properties
  under it (tabs: object, modifiers, material…), the toolbar on the left of the view, a header with modes (Object, Edit,
  Sculpt, Texture Paint); a gizmo in the corner to turn the view, numpad views, G/R/S move/rotate/scale, Tab edit mode,
  H hide, / local view, F2 rename, Ctrl+Z.
- **Spline (web)**: friendlier: the scene list left, the inspector right, the toolbar floating at the top centre, a "Play"
  preview; AI ("Spline AI") is a prompt box that adds or changes objects in the scene.
- **Meshy / Tripo studios**: the model in the middle on a turntable, versions as a strip of thumbnails at the bottom
  (every AI edit is a new version, the original kept), the tools as a left rail (Generate, Texture, Remesh, Rig, Animate),
  and Meshy Edit: lasso or brush a part on the model + a sentence → a new version.
- **Phone** (Nomad Sculpt, Shapr3D on iPad, Spline mobile viewer): one finger turns, two pan, pinch zooms; the tools in a
  bottom or side bar; panels as sheets; a big undo/redo pair always on screen (Nomad).
- For KesherAI's stage 1: the viewer (done) becomes the editor: parts list with eye and colour, the inspector (material,
  measurements), a version strip for AI edits, mark a part (click or lasso) → the task bar ("What to do here?": new
  texture, remove, change by a sentence), export GLB/OBJ, open in Blender/Unreal/Unity, Send to the chat; the phone with
  the gestures above, tools at the bottom, undo/redo always there.
- Stopped at: all three editor screens researched; next boards for the video, sound and 3D screens in the design doc.

## Instruments in the sound editor, and a hum or whistle into an instrument (2026-11-18, 15:40; Roee asked)
- Roee: the sound editor should support instruments (drums, guitar, trumpet, violin…), and recording a hum or a whistle
  and turning it into the sound of an instrument he picks.
- **Two ways the others do it:**
  1. **Audio → notes (MIDI) → any instrument**: Spotify **Basic Pitch** (open source, polyphonic, pitch bends, tiny:
     under 17K parameters, runs in the browser), **Vochlea Dubler 3** (voice to MIDI live, beatbox to drums, mouth sweeps
     to a controller), **Logic Pro** (audio to score, Session Players follow it), **GarageBand / BandLab** (hum → a
     track), **VoiceDrums** (beatbox → a drum kit with velocity layers). The notes can be fixed in a piano roll, moved to
     a key, put on the beat, then played by any instrument. Tip they all give: hum stepped notes (glides confuse the
     pitch), and say "t", "k", "p" for the attacks.
  2. **Timbre transfer (the hum itself becomes the instrument)**: Google Magenta **Tone Transfer / DDSP** (violin, flute,
     trumpet, saxophone, tenor), **SoundID VoiceAI** instrument mode, **Suno Studio** (hum a melody → an instrument part),
     **Udio Converter** (a vocal up to 45 s → stems). Keeps the expression (slides, vibrato, breath) but each instrument
     is its own model.
- **The flow everyone shares**: record (with a count-in and a click), pick an instrument from a gallery with a preview,
  hear it at once, fix notes / timing / key, then lay it as a new track beside the original (or instead of it).
- **What KesherAI can run locally, with no cloud**: monophonic pitch tracking (YIN) in the page for a hum or a whistle,
  exact and instant; Basic Pitch (TF.js, Apache 2.0) later for chords from a guitar or piano; instruments from the
  FluidR3 General MIDI set (CC BY 3.0, by Frank Wen; gleitz's per-note files), sampled every few notes and pitched
  between; drums synthesized in the page (808/909-style kick, snare, hats, clap: no samples, no licence); DDSP timbre
  transfer as stage B for the most expressive instruments; the music model (Models page) as stage C for "a backing track
  to this melody".
- **The plan**:
  - Stage A (now): ● record in the editor (or use the selection); "To an instrument…": the notes found (shown in a piano
    roll), "snap to the key" and "on the beat" switches, an instrument gallery (piano, acoustic and electric guitar, bass,
    violin, cello, strings, trumpet, saxophone, flute, clarinet, choir, synth) with a preview, and drums from a beatbox
    (kick / snare / hat by the sound's brightness); the result as a new track over the original with a volume each.
  - Stage B: DDSP timbre transfer (violin, flute, trumpet, saxophone) for the expression; Basic Pitch for chords.
  - Stage C: a backing track from the melody with the music model; an instrument track drawn by hand (piano roll, drum
    grid) as in GarageBand.
- Sources: sonarworks.com "Can you turn your voice into an instrument?" (Dubler 3, Logic 11.2, SoundID VoiceAI, Udio
  Converter, VoiceDrums), basicpitch.spotify.com/about, elephorm.com on humming in Suno Studio, the gleitz
  midi-js-soundfonts README (FluidR3_GM, CC BY 3.0).
- Stopped at: research done; next the board, then stage A.

## The 3D editor after Blender, 3ds Max and Maya (2026-11-18, 16:20; Roee: "a lot of inspiration and research from Blender, 3ds Max, Maya")
- **What the three share** (and so what a 3D person expects): an Outliner / Scene Explorer as a tree of the scene's
  objects with eye (hide) and select toggles; a numeric panel for the chosen object — Maya's **Channel Box** (Translate,
  Rotate, Scale X/Y/Z, editable by typing or dragging the label), Blender's **N panel** (Location / Rotation / Scale /
  Dimensions), 3ds Max's **Transform Type-In** (F12); a **transform gizmo** with move / rotate / scale; **frame the
  selection** (F in all three; A frames all in Maya, Home in Blender, Z in Max); shading modes; duplicate and delete;
  undo for everything; snapping.
- **Keys** (each its own): Maya / 3ds Max **W E R** = move / rotate / scale (Q select), Blender **G R S** (then X/Y/Z to
  lock an axis, a number to type the amount); Blender Shift+D duplicate, X delete, H hide, Alt+H show all, numpad 1 / 3 / 7
  front / right / top, 5 perspective ↔ orthographic, / local view; Maya 4 / 5 / 6 wireframe / shaded / textured, F frame,
  Space tap = the four views, Ctrl+D duplicate; 3ds Max F / L / T / P = front / left / top / perspective views, Alt+W
  maximise a view, F3 wireframe, F4 edges on faces, S snaps.
- **Views**: 3ds Max's **ViewCube** (top-right: click a face, an edge or a corner for that view, drag to turn), Blender's
  **navigation gizmo** (X/Y/Z axis balls), the quad views (top / front / side / perspective) in Max and Maya; shading as
  four buttons in Blender's header (wireframe, solid, material preview, rendered).
- **Non-destructive changes**: 3ds Max's modifier stack (Smart Extrude, Boolean with history in the stack), Blender's
  modifiers (Mirror, Subdivision, Bevel, Array), Maya's construction history: every change can be turned off, reordered
  or removed later.
- **2026 news**: 3ds Max 2026 — topology-aware retopology loops, a steadier Boolean, Smart Extrude in the stack, viewport
  culling (a large scene from about 10 to 22 FPS), real-time material preview; Maya at SIGGRAPH 2026 — MotionMaker
  trained on your own rigs and animation (AI motion), Arnold's render in the viewport; 3ds Max edits Gaussian splats as
  points and takes World Labs Marble worlds (AI environments).
- **For KesherAI's 3D editor (stage 1.5, now)**: the outliner as a tree of the file's nodes; a Channel-Box-style panel
  (position, rotation, scale, by typing); a transform gizmo with both key sets (W E R and G R S), axis lock and snapping;
  shading modes (Maya's 4 / 5 / 6 and Blender's buttons); view buttons like Max's ViewCube faces (front / right / top /
  perspective, numpad 1 / 3 / 7 and F / L / T / P); duplicate (Shift+D / Ctrl+D) and delete (X / Delete); undo for all of
  it. Later: modifiers (mirror, subdivide, bevel, array) as a stack, quad views, edit mode on vertices, and the AI task
  bar on a part (texture, change by a sentence, retopology).
- Sources: Autodesk news on SIGGRAPH 2026 (MotionMaker, Arnold in the viewport, 3DGS in 3ds Max), superrendersfarm.com
  "What's new in 3ds Max 2026", digitalproduction.com on 3ds Max 2026, renderhub.com monthly news (Blender 4.5), plus each
  tool's own key map.
- Stopped at: research done; next the board update, then stage 1.5.

## Textures for the 3D editor from the image editor, and editors that work alone but together (2026-11-18, 16:40; Roee asked)
- Roee: the 3D editor should make and edit textures with the image editor; give him the tools; research how it should be
  done and how every tool stays separate yet works with the others.
- **How the big tools do textures with a 2D editor:**
  - **Maya: PSD Network** (Texturing → Create PSD Network): pick the material's channels (colour, bump, specular…), Maya
    makes a PSD with one layer set per channel, coloured from the material, plus an optional **UV snapshot** layer on top
    as a guide that does not render; paint in Photoshop, save; **Update PSD Networks** brings each layer set back into its
    channel.
  - **Blender:** Image Editor → Image → **Edit Externally** opens the texture in the system's editor, then **Reload**;
    **UV Editor → Export UV Layout** for a guide; **Texture Paint** mode paints on the model itself. Bridges (Universal
    Bridge for Photoshop, Affinity Bridge) automate it: **Edit Image** watches the file it sent and reloads it the moment it
    is saved; **New Texture with UV Guide** makes a blank 512–4096 px document with the UV layout as a guide layer and puts
    the painted layer on the material's base colour on save; **Edit as Height** wires the result as a bump map; **Keep
    Versions** saves `_v001`, `_v002` instead of overwriting.
  - **3ds Max: Viewport Canvas** paints on the model in the viewport, layers like Photoshop's, and **Edit in Photoshop**
    hands the current layer to Photoshop and takes it back.
  - **Substance Painter:** paints in layers directly on the model, exports texture sets; to Photoshop by **Send to
    Photoshop** / PSD export. **Unreal:** a texture is an asset; "Edit in external app" and it reimports when the source
    file changes. **Meshy / Tripo:** AI texture by a prompt (retexture), the model kept.
- **What they share:** a texture is a **file linked from the material's slot**; the 2D editor gets the texture **and a UV
  guide that never renders**; saving brings it back into **the same slot**; versions are kept; the 3D tool decides which
  channel it is (colour, roughness, normal / height).
- **Separate yet together** (Photoshop's linked files and Edit Smart Object, Blender's Edit Externally, Figma's plugins,
  Apple's "Edit with", Windows' OLE before them): each program opens and saves its own files and needs nothing from the
  other; the hand-off is only **a file + where it came from + a way back**. The first program writes the file, opens the
  second with a return ticket, the second saves and says "back", the first reloads that file into the place it came from.
  If the second is not installed, the first still works (and offers to get it).
- **For KesherAI** (generalising what the video ↔ sound editors do): a hand-off on the plugin bridge —
  `editor.handoff { to, data, name, slot, guide? }` saves the file in the chat's folder and opens the other editor (offering
  to turn it on if it is off) with `ret` (the file to go back to), `retp` (the editor to go back to), `slot` (an opaque
  place, e.g. "Seat:map") and an optional guide; `editor.handBack { data, name }` saves the result and opens the first
  editor again with `back` and `slot`. The 3D editor: per part, a **Base colour texture** slot (thumbnail; Edit in the
  image editor; New texture with a UV guide; Remove), the model kept as a working copy while away; the image editor: the
  UV guide as a top layer that is never exported, and **↩ Back to the 3D model**. Later: roughness / normal slots, AI
  texture by a prompt (seamless, from the picture model), painting on the model itself (Viewport Canvas / Texture Paint).
- Sources: Autodesk Maya help "Create a PSD file with layer sets from within Maya" and "Update PSD Networks";
  superhivemarket.com Universal Bridge: Photoshop docs; versluis.com "How to use an external image editor with Blender";
  creativebloq.com "How to paint model textures directly in 3ds Max"; polycount threads on Viewport Canvas and Photoshop.
- Stopped at: research done; next the board, then the hand-off and the texture slot.

## Choosing exact parts of a model, and splitting it by meaning with AI (2026-11-18, 16:50; Roee: "really choose specific parts and change their texture; ask the AI to split it")
- **Without AI, what the tools give**: Blender's **Separate** (P: by selection, by material, by loose parts) and **Select
  Linked** (L under the mouse; "delimit" by seam, sharp edge, material, or by the angle between faces); 3ds Max's
  **Element** sub-object level and **Detach**; Maya's **Extract** and **Separate**. So: a click picks the faces under it
  and grows across edges until the surface turns more than an angle (a chair's leg ends where it meets the seat), then
  "Separate" makes it a part of its own.
- **With AI (2025–2026)**: **P3-SAM** (Tencent Hunyuan3D-Part): native 3D part segmentation of any mesh into parts and
  their boxes, automatic or from a point clicked on the model, the step before X-Part makes the parts whole; demos on
  Hugging Face, Colab and Kaggle; Tencent's community licence. **PartField** (NVIDIA, 2025): a feature field that
  clusters a mesh into parts at any number of parts. **SAMPart3D** / **SAMesh**: SAM's 2D masks lifted onto the mesh.
  All need a GPU (Roee's 24 GB is enough) and a Python engine, like KesherAI's voice engine.
- **The plan**: now — "Choose by click" (faces linked under the click, stopping at an angle, 10–90°), shown in orange, then
  "Separate" into a new part, plus the split by loose pieces / by material already built; next — "By meaning (AI)" as a
  download Roee agrees to (P3-SAM in KesherAI's engines, the mesh in, a part for each face out), with a click on the
  model as the prompt for "this part"; the parts then get textures through the image editor.
- Sources: huggingface.co/tencent/Hunyuan3D-Part (P3-SAM, X-Part), arXiv 2509.06784 (P3-SAM), arXiv 2509.12815
  (Hunyuan3D Studio), themoonlight.io review of P3-SAM; Blender, 3ds Max and Maya manuals for Separate / Detach / Extract.
- Stopped at: research done; next "Choose by click" and Separate in the 3D editor.

## The editors' next tools, from how the known tools do them (2026-11-18, 17:00–18:10)
- **Texture slots** (Blender's Principled BSDF, Substance's channels, glTF PBR): colour (sRGB), roughness and normal
  (data, linear); roughness / normal made from the colour's brightness as Materialize and Substance's "from base colour"
  do (Sobel for the normal, OpenGL green-up as glTF asks).
- **Painting on the model** (Blender's Texture Paint, Substance Painter, 3D-Coat): the brush draws through the UVs; a
  part without UVs gets Blender's Cube Projection (each face on the box side it faces, six cells, no overlap).
- **Noise clean-up** (Audacity's Noise Reduction; iZotope RX and Adobe Podcast as the AI versions): learn the noise from
  a stretch (or the quietest tenth), gate each frequency, smooth the gain so it does not twinkle.
- **Chords under a hummed melody** (Hookpad's and Band-in-a-Box's harmonize): the key's triad per bar that holds most of
  the melody's notes, I / IV / V preferred, home chord at the ends.
- **Shot changes** (Premiere's Scene Edit Detection, Resolve's Scene Cut Detector, CapCut's auto cut): FFmpeg's scene
  score. **Burned captions and reframe** (CapCut, Premiere's Auto Reframe): libass with right-to-left Hebrew; the middle
  of the frame at 9:16 / 1:1 / 4:5 (subject tracking left for later).
- **Remove background** (Photoshop, Canva): rembg with BiRefNet (MIT), not RMBG (BRIA's licence is non-commercial).
- **P3-SAM on Windows**: its requirements are Linux-first (flash-attention from Git, PyG wheels without an index, Sonata
  at /root/sonata); Sonata's authors give enable_flash=False with patches of 1024 for when flash-attention is missing.
- Stopped at: all built and checked in a browser here; on the PC waiting until Roee frees it (a Switch 2 build runs).

## A game scene edited in KesherAI without its engine, synced by our plugin (2026-11-18, 19:25; Roee: "load a stand-in of an Unreal, Unity or Godot scene, move things without the engine, and it syncs when the engine opens")
- **Godot**: scenes are text (.tscn, format=3): `[node name= type= parent="A/B" unique_id=…]` then `transform =
  Transform3D(basis x, basis y, basis z, origin)` (12 numbers; 2D: `position = Vector2(…)`, `rotation`, `scale`);
  `unique_id` (4.6+) follows a node through renames; instanced scenes are `instance=ExtResource("id")`. So KesherAI can
  read and write a closed scene directly (only the transform lines change; Godot reloads it), and through our addon
  when the editor is open (the same change as an undo step).
- **Unity**: scenes and prefabs are YAML (Force Text, the default): each GameObject has a Transform with
  `m_LocalPosition / m_LocalRotation (quaternion) / m_LocalScale` and `m_Father`; objects inside a prefab are changed
  as `m_Modifications` of the PrefabInstance. Writing YAML by hand is fragile (fileIDs, prefab overrides), so: read the
  YAML for the stand-in, and apply moves through the Unity package when Unity opens (Undo.RecordObject), never by hand.
- **Unreal**: .umap is binary; only the engine reads it. Our KesherAIBridge already exports Blueprints for offline work
  (UnrealOfflineSync): the same way, it would write a snapshot of the level's actors (name, class, transform, mesh) on
  save, and on the next start apply the moves made in KesherAI as one transaction (FScopedTransaction), reporting any
  actor that also moved in the engine. Epic's own Multi-User Editing and the Remote Control API do this live (with the
  editor running); USD / Omniverse "live layers" keep the changes as a layer over the scene, the model for our list.
- **The stand-in**: each object a box of its bounds (or its mesh, exported to GLB where the engine can), named as in the
  engine, in the 3D editor; changes kept as a list (object id, new transform, the transform it had), so a conflict is
  "it moved in the engine too".
- **Order**: Godot first (text, no engine needed, the addon exists), then Unity (read YAML, apply through the package),
  then Unreal (snapshot and apply through the bridge, needs a plugin release).
- Sources: Godot docs "TSCN file format" (godot-docs engine_details/file_formats/tscn.rst); Unity Manual "Format of
  Text Serialized files" and "UnityYAML"; Unreal docs "Multi-User Editing" and "Remote Control API"; NVIDIA Omniverse
  "Live layers"; KesherAI's UnrealOfflineSync board.
- Stopped at: research done; next the design board, then the Godot reader / writer with tests.

## The scene stand-in, part 2: 2D, the phone, a full outliner; Unity Studio (2026-11-18, 19:30; Roee: "2D and 3D, from the phone too, an outliner with the hierarchy and what is attached to each object, ideas from Unity's browser tool that works as a group")
- **Unity Studio** (Unity's in-browser, no-code 3D editor, shipped March 2026, $799/seat/year): the engine's own layout
  in a browser (Hierarchy, Project, Scene view, Inspector, a Camera Preview), imports GLB/FBX/OBJ (big files shown
  through a lighter "preview GLB"), a node-based Logic editor, a shared timeline for animation, publish to a web link.
  **Working as a group**: up to 12 people in one draft; each has a colour; their **named cursors and cameras** show in
  the view; what each has **selected is outlined in their colour**, and a **coloured dot marks it in the Hierarchy**; a
  value someone is editing in the Inspector is lit in their colour; **follow** someone's camera for a guided review; a
  script being edited is locked to one person. Drafts keep a browsable **version history**.
- **The outliner in the engines**: Godot's Scene dock is the node tree itself (a node's script and children shown on its
  row, a signal icon; the Inspector has the node's properties by class); Unity's Hierarchy lists GameObjects, and the
  Inspector lists each one's **components** (Transform, Mesh Filter, Mesh Renderer, Collider, Light, scripts), each
  with a checkbox; Unreal's Outliner lists actors in folders, and Details shows each actor's **component tree**
  (DefaultSceneRoot, StaticMeshComponent, PointLight…). Common: search, an eye (hide), a lock, a type icon per row,
  prefab / instance marked (Unity blue, Godot a "scene" icon, Unreal a Blueprint link).
- **2D**: Godot's Node2D / Control (`position`, `rotation`, `scale` in pixels, Y down) and Sprite2D's texture; Unity 2D
  is the same scene format with SpriteRenderer (class 212) and an orthographic camera; Unreal 2D is Paper2D
  (PaperSpriteActor, flipbooks) in a 3D level, seen from the side. The usual view: an orthographic canvas, pan with the
  middle button / two fingers, zoom on the wheel / pinch, the sprites as their pictures, a grid in pixels.
- **What we take**:
  - The outliner as the engines show it: the tree with a type icon, eye and lock per row, search, prefab / instance
    marked. Under a chosen object, what is attached to it (components / child nodes: mesh, collider, light, script,
    sprite), read-only for now. On the phone, the outliner is a bottom sheet.
  - A **2D view**: a scene that is all 2D opens in it on its own; a switch moves between 2D and 3D.
  - Unity Studio's **group work**, later and on our own share links: the colour per person, their selection outlined,
    the dot in the outliner, follow their view. The stand-in already works remotely (the phone on the same KesherAI).
- Sources: unity.com/blog "Unity Studio real-time collaboration"; Digital Production "Unity ships Unity Studio for
  in-browser 3D" (2026-03-23); unity.com/products/unity-studio; the engines' manuals (Godot Scene dock and Inspector,
  Unity Hierarchy and Inspector, Unreal Outliner and Details).
- Stopped at: research done; next the SceneStandIn board (2D, the outliner, the phone), then the readers' components and
  the 2D view.
