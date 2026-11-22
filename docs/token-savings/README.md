# Token savings — source of truth

The numbers behind the interview deck (Slides artifact "KesherAI — חיסכון בטוקנים", slug 0ad86683-0df1-4379-ad7a-d3526e600b53) and the website charts (kesherai-token-savings-en.svg / -he.svg in this folder).

Rule (Roee, 22.11.2026): every time we find another way to save tokens, add a row below, update the deck (practices slide and, when a number changes, the charts) and regenerate both SVGs.

## Measured
- Prompt caching, one chat, 530 requests (22.11.2026): input 1.3K, cache write 0.59M, cache read 248.6M, output 0.2M. Effective cost with weights read ×0.1, write ×2, output ×5 ≈ 27M input units vs ≈ 250M without caching → ≈ 89% less (approximate weights, not a bill).
- Research outside Claude: 36 reports (≈22 Antigravity, 14 free Gemini key) by 22.11.2026.
- Claude helper cost per run (measured 22.11): research/summary ≈ 125K tokens; build helpers 145K–316K.

## Totals for the with/without chart
- Caching: without 250.2M, with 27.0M (measured)
- Research: without 4.5M, with ≈0.2M (Claude only writes the task and reads a short summary; estimate)
- All: without 254.7M, with 27.2M → ≈89% less

## Estimates
- Claude tokens not spent on research: 36 × ≈125K ≈ 4.5M.

## Practices (date added)
- 2026-11-19 Lead + at most 2 helpers, model per task (Sonnet for light work, Opus for code)
- 2026-11-19 Only changed-file tests while working; full suite before a release; security scan every 5 releases
- 2026-11-20 HANDOFF.md: a new chat every 1–2 weeks starts from a short handoff, not the whole history
- 2026-11-21 Research to Antigravity / free Gemini key (no Claude tokens)
- 2026-11-22 Computer actions through KesherAI computer tasks (one goal, a summary back) instead of Claude screenshots
- 2026-11-22 Logs Claude can read (hub-diag.json, main.log) instead of screenshots from Roee
- 2026-11-22 Research index (docs/research/INDEX.md) so agents don't repeat research
- 2026-11-22 Antigravity model fallback and quota memory (Opus → Sonnet → Flash)
