# Token savings — source of truth

The numbers behind the interview deck (Slides artifact "KesherAI — חיסכון בטוקנים", slug 0ad86683-0df1-4379-ad7a-d3526e600b53) and the website charts (kesherai-token-savings-en.svg / -he.svg in this folder).

Rule (Roee, 22.11.2026): every time we find another way to save tokens, add a row below, update the deck (practices slide and, when a number changes, the charts) and regenerate both SVGs.

## Measured
- Prompt caching, one chat, 530 requests (22.11.2026): input 1.3K, cache write 0.59M, cache read 248.6M, output 0.2M. Effective cost with weights read ×0.1, write ×2, output ×5 ≈ 27M input units vs ≈ 250M without caching → ≈ 89% less (approximate weights, not a bill).
- Research outside Claude: 36 reports (≈22 Antigravity, 14 free Gemini key) by 22.11.2026.
- Claude helper cost per run (measured 22.11): research/summary ≈ 125K tokens; build helpers 145K–316K.

## Scenario chart (same work, different setups; effective M tokens, % less than "Nothing")
| Column | M | % less | Basis |
|---|---|---|---|
| Everything | 27.2 | 93% | measured chat (27.0) + research summaries (0.2) |
| Without research offload | 31.5 | 92% | + 36 × 125K − 0.2M summaries (measured count × measured helper cost) |
| Without new chat + handoff | 32.2 | 91% | + ≈5M: context ≈20% larger without fresh chats (assumption) |
| Without agent split | 34.0 | 91% | + ≈6.8M: 9 helpers × ≈50K tokens of file output kept in the main chat × ≈150 later requests × 0.1 cache (assumption) |
| Caching only | 43.3 | 88% | all three above added |
| Nothing | 372.2 | baseline | no cache: main chat 250.2 + research 4.5 + agent-split 67.5 + handoff 50 (×10 without cache) |
Measured parts: caching numbers and research count/cost. The rest are stated assumptions; replace them as real measurements arrive.

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
- 2026-11-22 KesherAI: Anthropic prompt caching (cache_control on last tool, static system block, last two user turns); measured: pending (answer footer cache %, usage events `cached` / `cacheWrite`)
- 2026-11-22 KesherAI: context pruning — superseded file reads as one line, old command/check outputs keep their exit line; measured: pending (usage `pruned`, session `savedTokens`)
- 2026-11-22 KesherAI: llama.cpp host-RAM prompt cache 20 GB (`--cache-ram`, `--cache-idle-slots`) on 64 GB computers; measured: pending (engine log prompt time / `promptTps` when returning to a chat)
- 2026-11-23 KesherAI: thinking off for short helper calls (router, inline code, translator, titles): fewer local tokens and no empty answers
- 2026-11-23 ComfyUI flow smoke runs through KesherAI (one call, a ✓ back) instead of Claude driving ComfyUI on screen

## Not counted as savings
- OpenCode Go and other paid plans (Roee, 23.11): moving work to a service he pays for is not a token saving, so it stays out of the deck and the charts.
