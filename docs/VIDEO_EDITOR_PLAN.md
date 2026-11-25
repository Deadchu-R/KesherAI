# Video Editor — Plan to Pro Level

From `docs/WORK_LIST.md` ("Video editor to a pro level: keyframes, colour, titles, audio ducking"), researched in
`docs/research/c-20261122-04.md` and `docs/research/c-20261122-11.md` (Part D).

- **Phase 1 — audio ducking, interactive (UI → API → server).** Automatic ducking already exists as an on/off switch
  with a fixed depth; this phase gives it a depth control the person sets while editing.
- **Phase 2 — keyframes** (per-clip volume/fade/colour envelopes on the timeline).
- **Phase 3 — colour** (exposure/contrast/temperature/LUT on the clip inspector).
- **Phase 4 — titles** (multi-line text clips with styles, built on the existing `texts` overlay list).

---

## Phase 1, Item 1: interactive audio ducking controls

### Where ducking stands today (built, on/off only)

| Layer | File | What exists |
| --- | --- | --- |
| UI | `plugins/video-editor/ui/editor.html:58` | `#duck` checkbox "Lower it while someone speaks", beside `#musicVol` / `#fadeIn` / `#fadeOut` inside `#musicTools` |
| UI logic | `plugins/video-editor/ui/editor.js:568` | `musicSettings()` → `{ volume, fadeIn, fadeOut, duck }` |
| Preview | `plugins/video-editor/ui/editor.js:577` | while a transcript line is under the playhead: `v *= 0.3` (hardcoded depth) |
| Export call | `plugins/video-editor/ui/editor.js:1147` | `kesher.call("video.cut", { …, music: { path, start, …musicSettings() } })` |
| Bridge | `apps/web/src/plugins.tsx:344` | passes the whole `music` object through — no per-field list, no change needed here |
| API | `packages/core/src/routes/files.ts:75,111-117` | body type `music?: { … duck?: boolean }`; builds `MusicTrack`, `duck: mu.duck !== false` |
| Server | `packages/core/src/video-cut.ts:112-151` | `MusicTrack.duck: boolean`; `musicGraph` adds `sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400` (fixed params) |
| Tests | `packages/core/src/video-cut.test.ts:58-71` | duck on → `/sidechaincompress/` in the graph; `duck: false` → no `sidechain` |

### The gap

`duck` is a boolean; the depth is hardcoded in two places that cannot be changed by the person editing:
the preview's `×0.3` and the export's `ratio=8`. "Lower the music a little under the voice" is impossible.

### The design: a "how much" slider

- **Control** — a range slider `#duckAmt` (10–100 %, step 5, default **70 %**) under the `#duck` checkbox,
  with a percent readout like `#musicVolN`. Disabled while `#duck` is unchecked.
- **Semantics** — `duckAmt` ∈ 0…1: how much the music lowers while someone speaks.
  Default 0.7 = exactly today's behaviour (preview `×(1 − 0.7) = ×0.3`).
- **Preview** (`editor.js:577`) — `v *= 1 - m.duckAmt` instead of `v *= 0.3`.
- **API** — `music.duckAmt?: number` added to the cut route's body type; passed to `MusicTrack` as `Number(mu.duckAmt)`
  (the neighbouring `volume` / `fadeIn` / `fadeOut` are read the same way; range-keeping belongs to `musicGraph`,
  as the comment at `files.ts:111` says).
- **Server** — `MusicTrack.duckAmt?: number` (0…1, TSDoc). In `musicGraph`:
  `amt = Number.isFinite(m.duckAmt) ? clamp(m.duckAmt, 0, 1) : 0.7` (NaN — an older client that sends no `duckAmt` —
  falls back to today's behaviour), and the side-chain's ratio becomes **`ratio = 1 + amt × 10`**:
  0.7 → `8` (today's fixed value, default export unchanged), 0.3 → `4`, 1 → `11`, 0 → the duck branch is skipped
  entirely (same as `duck: false`). Threshold, attack and release stay as they are; finer controls
  (Fairlight-style threshold/attack/release, per the research) are a later item.
- **Badge** — the music lane keeps showing `⇣` when ducking is on (`editor.js:329`); no change.

### Files to change

1. `plugins/video-editor/ui/editor.html` — after the `#duck` row (line 58) add, inside `#musicTools`:
   `<label class="row small"><span data-t="duckAmt">How much</span> <input type="range" id="duckAmt" min="10" max="100" step="5" value="70" style="flex:1" /> <span id="duckAmtV" class="muted" dir="ltr">70%</span></label>`
   (copy the `#musicVol` row's exact classes/structure).
2. `plugins/video-editor/ui/editor.js`
   - Hebrew dictionary (line 17): `duckAmt: "כמה להנמיך"` (English comes from the HTML text, as for `duck`).
   - `musicSettings()` (line 568): add `duckAmt: Number($("duckAmt").value) / 100`.
   - Preview (line 577): `if (m.duck && captions().some(…)) v *= 1 - m.duckAmt;`
   - Wiring (line 622): add `"duckAmt"` to the `["musicVol", …]` list, update `#duckAmtV` text, and set
     `$("duckAmt").disabled = !$("duck").checked`.
3. `apps/web/src/plugins.tsx` — **no change** (`music` is forwarded as one object).
4. `packages/core/src/routes/files.ts` — body type (line 75): `duckAmt?: number` in `music`;
   construction (line 117): `duckAmt: Number(mu.duckAmt)`.
5. `packages/core/src/video-cut.ts` — `MusicTrack.duckAmt?: number` + `musicGraph` ratio mapping (above).
6. `packages/core/src/video-cut.test.ts` (test at lines 58-71) — add:
   - default `m` → `ratio=8\.0` in the graph (the old fixed value);
   - `{ …m, duckAmt: 0.3 }` → `ratio=4\.0`; `{ …m, duckAmt: 1 }` → `ratio=11\.0`;
   - `{ …m, duckAmt: 0 }` → no `sidechain` (with `voice` passed, as line 67 does).

### Acceptance

- `pnpm -s typecheck && pnpm -s test` green; no prettier, no new dependencies.
- With no `duckAmt` sent (old client) the export graph is byte-identical to today's except `ratio=8` → `ratio=8.0`.
- Default slider (70 %): preview drops to `×0.3` during speech — same as today; export `ratio=8`.
- Slider at 30 %: preview `×0.7`, export `ratio=4`; at 0 / checkbox off: no side-chain in the graph.
- UI in Hebrew and English, usable at 390 px (the inspector is already a single-column column).

### Out of scope for Phase 1

Threshold / attack / release sliders, per-region manual ducking, ducking the sound track instead of the music track,
loudness normalisation (EBU R128) — later items; keyframes / colour / titles are Phases 2–4.
When Phase 1 ships, update `docs/WORK_LIST.md:410` (the line still says "audio ducking not built").
