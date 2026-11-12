# Plan — t35: Extract Entities tab out of Day.tsx into apps/web/src/Entities.tsx

Goal (board t35, {big}, claimed by kesher): pull the "People & projects" (entities) tab component out of `apps/web/src/pages/Day.tsx` into its own file `apps/web/src/Entities.tsx`, same pattern as `MeetingRecorder.tsx` (its own `L` helper, `api`, `Select`, TSDoc on the exported component). Day.tsx keeps rendering it via the tab switch.

## Items
- [x] Confirm nothing outside Day.tsx uses `Entities`/`Entity` (search done: only Day.tsx).
- [x] Create `apps/web/src/Entities.tsx` with the `Entity` interface + `Entities` component (markup unchanged, TSDoc added).
- [x] Remove the `Entities` function and `Entity` interface from Day.tsx; add `import { Entities } from "../Entities";` (the `Select` import stays — also used by JournalSettingsCard).
- [x] Read the diff like a reviewer: markup byte-identical (verified programmatically, UTF-8 via node), imports correct, no leftover unused symbols (fixes: removed a stray blank line the interface removal left; made `Entity` non-exported to match the MeetingRecorder pattern of private interfaces).
- [x] Check: `pnpm -s typecheck && pnpm -s test` — 403 pass, 0 fail; `pnpm -s lint` clean too.

## Decisions
- Export `Entities` (named) to match the `MeetingRecorder` export style.
- Move the `Entity` interface along with the component; Day.tsx's `DayData.entities` inline array stays as-is (different shape, still used by DayView's chips).
- Keep the `ent-chip` / `ent-list` CSS in the global stylesheet untouched (no markup change).
- No new dependencies, no i18n wording changes.

## Blockers
- None so far.
