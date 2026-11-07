# @kesher/agent

The engine behind every KesherAI conversation. A plain chat and a coding session are the same thing here: an `AgentSession` that runs the model, executes the tools it calls, and stops to ask you when it needs to.

| File | What it does |
| --- | --- |
| `session.ts` | `AgentSession`: the loop (model turn → tool calls → results → next turn), approvals, questions, stop, undo. Every visible step is an `AgentEvent` |
| `tools.ts` | Built-in tools for code conversations: `list_files`, `read_file`, `search`, `write_file`, `edit_file`, `run_command`; and the `ask_user` tool every session has |
| `permissions.ts` | Who decides what: the permission table (`ask`, `auto-edit`, `auto`) and the list of dangerous commands that always ask |
| `workspace.ts` | Keeps every path inside the project folder, including through symlinks |
| `prompt.ts` | The system prompt, including the project's `AGENTS.md` |

The session never talks to a provider directly: it receives a `ModelTurn` function. The core server builds that function from the provider registry (`modelTurnFor` in `packages/core/src/conversations.ts`), and tests pass a scripted one. That is how the agent works with any model that supports tool calling — llama.cpp, LM Studio, Ollama, OpenAI, Anthropic — and degrades to plain chat with models that do not.

Adding a tool: implement `AgentTool` (spec, risk, `run`, optional `preview`) and pass it in the session's `tools`. Plugins add tools through `PluginContext.registerTool`; they get risk `exec`, so they ask before running unless the session is in `auto` mode.
