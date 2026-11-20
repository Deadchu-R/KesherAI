# Research with Gemini (Roee, 2026-11-20)

Broad research (competitors, market, how others built a feature) goes to Gemini to save Claude tokens:
- **Gemini app, Deep Research** (Roee runs it from his phone or PC and attaches the PDF or text in the Claude chat), or
- **the task inbox** with `executor: antigravity` (runs on his PC after his Run tap; writes the result to
  docs/RESEARCH_LOG.md on its agy/* branch).
Claude (Sonnet agent) keeps the research that needs the code: the gap list against the repo, decisions, the build plan.
Every result, from either side, goes into docs/RESEARCH_LOG.md (summarised by Claude with "Stopped at:").

## Prompt template for Gemini Deep Research
Copy, fill the two lines in brackets, send:

```
Research topic: [the feature, e.g. "live view of AI agents' work on a phone"]
Context: KesherAI is an open-source, local-first AI desktop app (chat, local models via llama.cpp, ComfyUI, Unity /
Unreal / Godot bridges, editors for picture, video, sound and 3D) with an Android app that controls the PC remotely.
[One line on what we have today for this topic.]

Please research end to end how the leading products and open-source projects do this (at least 6, name each), with
sources and dates. For each: what the user sees, how it works technically, limits, pricing/licence if relevant.
Then: what to take, what to avoid, and a step-by-step plan for KesherAI, with the risks.

Answer format (keep it short and structured):
1. One-paragraph conclusion.
2. A table: product | what it does | how | what to take.
3. The plan in numbered steps, each with a "done when" line.
4. Open questions.
5. Sources (title, link, date).
```

## Gemini as a second opinion for Claude (Roee's PDF, 2026-11-20)
Gemini's guide suggests Claude call the Gemini CLI (`git diff | gemini -p "review…"`) before big architecture changes,
after 2 failed bug fixes, and before finishing a large feature; or a Node script with an AI Studio key.
- Claude's cloud session cannot reach Google's endpoints (generativelanguage / cloudcode: proxy 403, like the hub), so the
  CLI cannot run there today. The API-key path is out: Roee enters keys himself, wants Gemini only through his AI Pro plan,
  and the free tier may use the data for training.
- Until the hosts are allowed: a second opinion goes through the task inbox as an Antigravity "review" task (the diff or
  the design question in the task file; Roee's Run; the answer comes back on agy/*). Only for the cases above, not every task.
- If Roee adds the hosts to the environment's allowlist: try `gemini` with NO_BROWSER sign-in (he signs in himself);
  the sign-in lives only in that cloud session and must be repeated in each new chat.
