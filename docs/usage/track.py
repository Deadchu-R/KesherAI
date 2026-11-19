#!/usr/bin/env python3
"""Usage tracker for a Claude Code session.  Run:  python3 -I track.py

Reads the session transcripts (*.jsonl) and writes usage.json next to this script.
Stdlib only, read-only on the transcripts, idempotent (same inputs -> same output,
apart from the generated_at stamp).  Transcript text is only measured (lengths /
token counts), never copied into the output.
"""
import glob
import json
import os
import statistics
from collections import defaultdict
from datetime import datetime, timezone

# ---- configuration ---------------------------------------------------------
PROJECTS_ROOT = "/root/.claude/projects"   # every project folder, every session, every subagent
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage.json")
BUCKET_MIN = 15

# Effective-unit weights (input x1, cache write x2, cache read x0.1, output x5).
UNIT_IN, UNIT_CW, UNIT_CR, UNIT_OUT = 1.0, 2.0, 0.1, 5.0
# APPROXIMATE relative costs per model family (Opus = 1.0). Not exact prices.
# Unknown families (e.g. "fable") fall back to 1.0 and are listed in the output.
MODEL_WEIGHTS = {"opus": 1.0, "sonnet": 0.6, "haiku": 0.2}
DEFAULT_WEIGHT = 1.0
OPUS_WEIGHT = MODEL_WEIGHTS["opus"]
CHARS_PER_TOKEN = 4.0          # rough size estimate for text we can only measure in chars
DROP_FRACTION = 0.5            # a context drop below 50% of previous turn...
DROP_MIN_TOKENS = 50_000       # ...and bigger than this counts as a compaction


def weight(model):
    m = (model or "").lower()
    for fam, w in MODEL_WEIGHTS.items():
        if fam in m:
            return w, True
    return DEFAULT_WEIGHT, False


def eff_units(i, cw, cr, o, model):
    base = i * UNIT_IN + cw * UNIT_CW + cr * UNIT_CR + o * UNIT_OUT
    return base * weight(model)[0]


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def bucket_of(dt):
    m = (dt.minute // BUCKET_MIN) * BUCKET_MIN
    return dt.replace(minute=m, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%MZ")


def read_jsonl(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except OSError:
        return


def content_chars(c):
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        return sum(content_chars(x) for x in c)
    if isinstance(c, dict):
        if "text" in c and isinstance(c["text"], str):
            return len(c["text"])
        if "content" in c:
            return content_chars(c["content"])
    return 0


def load_transcript(path):
    """Return (messages, tool_result_chars, last_text_chars, compactions, ts_range, cost_state).
    messages: unique assistant messages (deduped by message id; content blocks of one
    API response are written as several lines sharing id + usage)."""
    msgs = {}
    order = []
    tr_chars = 0
    last_text = 0
    compactions = []
    cost_state = None
    tss = []
    for o in read_jsonl(path):
        t = o.get("type")
        ts = o.get("timestamp")
        if ts:
            tss.append(ts)
        if t == "assistant":
            m = o.get("message") or {}
            u = m.get("usage")
            if not isinstance(u, dict) or not ts:
                continue
            model = m.get("model") or ""
            if model.startswith("<"):  # synthetic placeholder messages
                continue
            key = m.get("id") or o.get("uuid")
            rec = {
                "ts": ts,
                "model": model,
                "in": int(u.get("input_tokens") or 0),
                "cw": int(u.get("cache_creation_input_tokens") or 0),
                "cr": int(u.get("cache_read_input_tokens") or 0),
                "out": int(u.get("output_tokens") or 0),
            }
            if key in msgs:  # keep earliest ts, max of each counter
                old = msgs[key]
                for k in ("in", "cw", "cr", "out"):
                    old[k] = max(old[k], rec[k])
            else:
                msgs[key] = rec
                order.append(key)
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "text":
                    last_text = len(b.get("text") or "")
        elif t == "user":
            c = (o.get("message") or {}).get("content")
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        tr_chars += content_chars(b.get("content"))
        elif t == "system" and o.get("subtype") == "compact_boundary":
            cm = o.get("compactMetadata") or {}
            compactions.append({
                "ts": ts, "kind": "compact_boundary",
                "pre_tokens": cm.get("preTokens"), "post_tokens": cm.get("postTokens"),
            })
        elif t == "cost-state":
            cost_state = o
    rows = [msgs[k] for k in order]
    rows.sort(key=lambda r: r["ts"])
    rng = (min(tss), max(tss)) if tss else (None, None)
    return rows, tr_chars, last_text, compactions, rng, cost_state


def merge_cost(states):
    """Combine the cost-state records of all sessions (sum of totals, earliest start)."""
    if not states:
        return None
    m = {"modelUsage": {}, "totalDuration": 0, "totalAPIDuration": 0, "startTime": None}
    for cs in states:
        m["totalDuration"] += cs.get("totalDuration", 0)
        m["totalAPIDuration"] += cs.get("totalAPIDuration", 0)
        st = cs.get("startTime")
        if st and (m["startTime"] is None or st < m["startTime"]):
            m["startTime"] = st
        for model, d in (cs.get("modelUsage") or {}).items():
            acc = m["modelUsage"].setdefault(model, {})
            for k, v in d.items():
                if isinstance(v, (int, float)):
                    acc[k] = acc.get(k, 0) + v
    return m


def kind_of(desc, atype):
    """Generic agent kind from the task description (never stored): research / build / lookup / other."""
    d = (desc or "").lower()
    if d.startswith(("research", "investigate", "study")):
        return "research"
    if d.startswith(("build", "design", "implement", "create", "write", "usage", "fix")):
        return "build"
    if d.startswith(("audit", "check", "find", "look", "scan", "review")) or atype == "Explore":
        return "lookup"
    return "other"


def main():
    # ---- discover transcripts ------------------------------------------------
    lead_files = sorted(glob.glob(os.path.join(PROJECTS_ROOT, "*", "*.jsonl")))
    agent_files = sorted(glob.glob(os.path.join(PROJECTS_ROOT, "*", "*", "subagents", "*.jsonl")))

    unknown_models = set()
    lead_rows = []          # all lead turns (all top-level sessions in folder)
    compactions = []
    cost_states = []
    earliest = []
    for p in lead_files:
        sid = os.path.basename(p)[:-6]
        rows, _, _, comp, rng0, cs = load_transcript(p)
        if rng0[0]:
            earliest.append(rng0[0])
        for r in rows:
            r["session"] = sid
        lead_rows += rows
        compactions += comp
        if cs:
            cost_states.append(cs)
    lead_rows.sort(key=lambda r: r["ts"])
    cost_state = merge_cost(cost_states)

    agents = []
    for p in agent_files:
        aid = os.path.basename(p)[:-6].replace("agent-", "")
        meta = {}
        try:
            with open(p[:-6] + ".meta.json", "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            pass
        rows, trc, last_text, _, rng, _ = load_transcript(p)
        if rng[0]:
            earliest.append(rng[0])
        if not rows:
            continue
        agents.append({
            "id": aid,
            "name": meta.get("description") or meta.get("agentType") or aid,
            "agent_type": meta.get("agentType"),
            "requested_model": meta.get("model"),
            "finished": meta.get("finished"),
            "rows": rows, "tr_chars": trc, "last_text_chars": last_text,
            "start": rng[0], "end": rng[1],
        })
    agents.sort(key=lambda a: a["start"])
    counters = defaultdict(int)
    for a in agents:           # replace private names/ids by a generic kind + running number
        k = kind_of(a["name"], a["agent_type"])
        counters[k] += 1
        a["kind"] = k
        a["id"] = a["name"] = "%s-%d" % (k, counters[k])
        a["agent_type"] = k
        a["requested_model"] = a["requested_model"]
    # Helpers from a previous day (before the surviving lead window) are listed but kept out of
    # every total, so they do not distort the "helpers started" moment or the per-hour figures.
    older_agents = []
    if lead_rows:
        cutoff = parse_ts(lead_rows[0]["ts"]).timestamp() - 12 * 3600
        older_agents = [a for a in agents if parse_ts(a["start"]).timestamp() < cutoff]
        agents = [a for a in agents if a not in older_agents]

    # ---- per-message units ----------------------------------------------------
    for r in lead_rows + [r for a in agents + older_agents for r in a["rows"]]:
        w, known = weight(r["model"])
        if not known:
            unknown_models.add(r["model"])
        r["units"] = eff_units(r["in"], r["cw"], r["cr"], r["out"], r["model"])
        r["ctx"] = r["in"] + r["cr"] + r["cw"]

    # ---- 15-minute buckets ----------------------------------------------------
    buckets = defaultdict(lambda: defaultdict(float))
    meta_of = {"lead": {"name": "lead (main session)", "model": None}}
    for r in lead_rows:
        buckets[bucket_of(parse_ts(r["ts"]))]["lead"] += r["units"]
    for a in agents:
        models = sorted({r["model"] for r in a["rows"]})
        meta_of[a["id"]] = {"name": a["id"], "model": ",".join(models)}
        for r in a["rows"]:
            buckets[bucket_of(parse_ts(r["ts"]))][a["id"]] += r["units"]
    bucket_list = []
    for b in sorted(buckets):
        d = buckets[b]
        bucket_list.append({
            "bucket_start_utc": b,
            "lead": round(d.get("lead", 0.0), 1),
            "helpers": {k: round(v, 1) for k, v in sorted(d.items()) if k != "lead"},
            "helpers_total": round(sum(v for k, v in d.items() if k != "lead"), 1),
        })

    # ---- lead context + compaction events --------------------------------------
    ctx_series = [{"ts": r["ts"], "context_tokens": r["ctx"], "model": r["model"]} for r in lead_rows]
    events = []
    known_c = {c["ts"][:19] for c in compactions}
    for c in compactions:
        events.append({"ts": c["ts"], "type": "compaction", "source": "compact_boundary",
                       "context_before": c["pre_tokens"], "context_after": c["post_tokens"]})
    for prev, cur in zip(lead_rows, lead_rows[1:]):
        if prev["ctx"] - cur["ctx"] >= DROP_MIN_TOKENS and cur["ctx"] < DROP_FRACTION * prev["ctx"]:
            near = any(abs((parse_ts(cur["ts"]) - parse_ts(c["ts"])).total_seconds()) < 300 for c in compactions)
            if not near:
                events.append({"ts": cur["ts"], "type": "compaction", "source": "context_drop",
                               "context_before": prev["ctx"], "context_after": cur["ctx"]})
    all_agents = sorted(agents + older_agents, key=lambda a: a["start"])
    if all_agents:
        events.append({"ts": all_agents[0]["start"], "type": "first_helper_ever",
                       "kind": all_agents[0]["kind"], "helper_count_all": len(all_agents)})
    if agents:
        first = agents[0]
        events.append({"ts": first["start"], "type": "helpers_started",
                       "kind": first["kind"], "helper_count": len(agents)})
    events.sort(key=lambda e: e["ts"])
    comp_ts = sorted(parse_ts(e["ts"]) for e in events if e["type"] == "compaction")

    # ---- savings estimate ------------------------------------------------------
    lead_ts = [parse_ts(r["ts"]) for r in lead_rows]
    first_lead = lead_ts[0] if lead_ts else None
    last_lead = lead_ts[-1] if lead_ts else None
    span = (last_lead - first_lead).total_seconds() if lead_ts and len(lead_ts) > 1 else 0
    turn_rate = (len(lead_ts) - 1) / span if span > 0 else 0.0   # observed lead turns per second

    savings = []
    for a in agents:
        end = parse_ts(a["end"])
        a_out = sum(r["out"] for r in a["rows"])
        added = a["tr_chars"] / CHARS_PER_TOKEN + a_out
        report = a["last_text_chars"] / CHARS_PER_TOKEN       # final answer that really enters lead
        added_net = max(0.0, added - report)
        nxt = next((c for c in comp_ts if c > end), None)
        observed = sum(1 for t in lead_ts if t > end and (nxt is None or t < nxt))
        # lead turns that happened after the helper ended but are not in any transcript
        # (history before the first surviving lead message was dropped by compaction)
        est_missing = 0.0
        if first_lead and end < first_lead and turn_rate > 0:
            gap_end = min(first_lead, nxt) if nxt else first_lead
            est_missing = max(0.0, (gap_end - end).total_seconds()) * turn_rate
        actual = sum(r["units"] for r in a["rows"])
        # Secondary scenario: the lead would also have spent one of its own turns per helper
        # turn, each re-reading its whole context (median on disk) at 0.1, plus the same output.
        med_ctx = statistics.median([r["ctx"] for r in lead_rows]) if lead_rows else 0
        lead_work = sum(med_ctx * UNIT_CR + r["out"] * UNIT_OUT for r in a["rows"]) * OPUS_WEIGHT
        cf_obs = added_net * observed * UNIT_CR * OPUS_WEIGHT
        cf_est = added_net * (observed + est_missing) * UNIT_CR * OPUS_WEIGHT
        savings.append({
            "label": a["id"], "kind": a["kind"],
            "start": a["start"], "end": a["end"],
            "tokens_that_would_enter_lead": round(added_net),
            "lead_turns_observed_after": observed,
            "lead_turns_estimated_missing": round(est_missing, 1),
            "counterfactual_units_observed": round(cf_obs, 1),
            "counterfactual_units_with_estimate": round(cf_est, 1),
            "actual_units": round(actual, 1),
            "saved_observed": round(cf_obs - actual, 1),
            "saved_with_estimate": round(cf_est - actual, 1),
            "lead_would_also_spend_on_own_work_turns": round(lead_work, 1),
            "saved_if_lead_did_work_itself": round(cf_est + lead_work - actual, 1),
        })

    # ---- totals ----------------------------------------------------------------
    helpers_total = sum(r["units"] for a in agents for r in a["rows"])
    lead_total = sum(r["units"] for r in lead_rows)
    hours = lambda s: s / 3600.0
    helpers_start = parse_ts(agents[0]["start"]) if agents else None
    lead_after = [r for r in lead_rows if helpers_start and parse_ts(r["ts"]) >= helpers_start]
    after_units = sum(r["units"] for r in lead_after)
    after_hours = hours((last_lead - first_lead).total_seconds()) if span else 0
    totals = {
        "lead_units_on_disk": round(lead_total, 1),
        "lead_units_after_helpers_started": round(after_units, 1),
        "lead_after_helpers_window_hours": round(after_hours, 3),
        "lead_after_helpers_per_hour": round(after_units / after_hours, 1) if after_hours > 0 else None,
        "helpers_units_total": round(helpers_total, 1),
        "helpers_window_hours": round(hours((max(parse_ts(a["end"]) for a in agents) - helpers_start).total_seconds()), 3) if agents else 0,
        "saved_units_lower_bound_observed_only": round(sum(s["saved_observed"] for s in savings), 1),
        "saved_units_with_estimated_missing_turns": round(sum(s["saved_with_estimate"] for s in savings), 1),
        "saved_units_incl_lead_own_work_turns": round(sum(s["saved_if_lead_did_work_itself"] for s in savings), 1),
        "note_lead_before_helpers": None,
    }
    totals["helpers_per_hour_of_window"] = (
        round(helpers_total / totals["helpers_window_hours"], 1) if totals["helpers_window_hours"] > 0 else None)

    # Session-wide cross-check from the cost-state record (whole session, all days,
    # includes work whose transcript lines were dropped by compaction).
    session = None
    if cost_state:
        mu = cost_state.get("modelUsage") or {}
        tot = 0.0
        per_model = {}
        for model, d in mu.items():
            u = eff_units(d.get("inputTokens", 0), d.get("cacheCreationInputTokens", 0),
                          d.get("cacheReadInputTokens", 0), d.get("outputTokens", 0), model)
            if not weight(model)[1]:
                unknown_models.add(model)
            per_model[model] = round(u)
            tot += u
        start_ms = cost_state.get("startTime")
        start_dt = datetime.fromtimestamp(start_ms / 1000, timezone.utc) if start_ms else None
        session = {
            "units_total_all_models": round(tot),
            "units_per_model": per_model,
            "session_start_utc": start_dt.isoformat() if start_dt else None,
            "wall_clock_hours_total": round(cost_state.get("totalDuration", 0) / 3.6e6, 1),
            "api_hours_total": round(cost_state.get("totalAPIDuration", 0) / 3.6e6, 1),
        }
        # Lead activity not visible per-turn = session total - helpers (assumes cost-state
        # includes helper agents) - lead turns on disk.  Mixes true "before helpers" with the
        # unobserved stretch between helper start and the compaction, so it is only a rough
        # figure and its per-hour value divides by wall-clock hours (idle time included).
        unobs = max(0.0, tot - helpers_total - lead_total)
        pre_hours = None
        if start_dt and helpers_start:
            pre_hours = (helpers_start - start_dt).total_seconds() / 3600.0
        totals["lead_before_helpers_or_unobserved_units"] = round(unobs)
        totals["lead_before_helpers_per_wall_hour_rough"] = (
            round(unobs / pre_hours) if pre_hours and pre_hours > 0 else None)
        totals["note_lead_before_helpers"] = (
            "LOW CONFIDENCE: transcripts on disk start after the last compaction, so per-turn lead "
            "history before then is gone; this figure is the session total from the cost-state "
            "record minus helpers minus lead turns on disk, divided by wall-clock hours since "
            "session start (idle time included).")

    daily = defaultdict(lambda: {"lead": 0.0, "helpers": 0.0, "by_kind": defaultdict(float), "helper_count": 0})
    for r in lead_rows:
        daily[r["ts"][:10]]["lead"] += r["units"]
    for a in all_agents:
        daily[a["start"][:10]]["helper_count"] += 1
        for r in a["rows"]:
            dd = daily[r["ts"][:10]]
            dd["helpers"] += r["units"]
            dd["by_kind"][a["kind"]] += r["units"]
    daily_list = [{"day_utc": d, "lead": round(v["lead"], 1), "helpers": round(v["helpers"], 1),
                   "helper_count": v["helper_count"],
                   "helpers_by_kind": {k: round(x, 1) for k, x in sorted(v["by_kind"].items())}}
                  for d, v in sorted(daily.items())]
    totals["earliest_timestamp_found"] = min(earliest) if earliest else None
    totals["helpers_units_all_days"] = round(sum(r["units"] for a in all_agents for r in a["rows"]), 1)

    method = (
        "Effective units per assistant message = (input x1 + cache_write x2 + cache_read x0.1 + "
        "output x5) times a model weight (Opus 1.0, Sonnet 0.6, Haiku 0.2; approximate relative "
        "costs; unknown families such as 'fable' are weighted 1.0). Messages are deduplicated by "
        "message id because one API response is written as several transcript lines. Buckets are "
        "15-minute UTC windows; 'lead' is the main session, every other key is one helper agent. "
        "Lead context per turn = input + cache_read + cache_write. A compaction is a compact_boundary "
        "record, or a drop of lead context to under half of the previous turn (and more than 50k). "
        "Savings, per helper: if the lead had done the work itself, everything the helper read via "
        "tools (tool-result size, estimated at 4 characters per token) plus the helper's own output "
        "tokens would have sat in the lead's context, minus its short final report which reaches the "
        "lead anyway. Every later lead turn re-reads that from cache at 0.1 per token at the Opus "
        "weight, until the next compaction clears it. Counterfactual = those tokens x number of lead "
        "turns after the helper finished (until the next compaction) x 0.1 x 1.0. Saved = counterfactual "
        "minus the helper's actual effective units (negative means the helper cost more than it saved). "
        "Lead turns before the oldest surviving transcript line are lost to compaction, so 'observed' "
        "counts only turns on disk (a lower bound) and 'with_estimate' adds missing turns at the "
        "observed turn rate. A second figure (saved_if_lead_did_work_itself) also charges the lead for one own turn per helper turn at its median context, since doing the work itself means re-reading its whole context on every tool call. Conservative: ignores the one-time cache-write cost of the larger "
        "lead context and the lead time spent doing the work itself."
    )

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": method,
        "constants": {"unit_weights": {"input": UNIT_IN, "cache_write": UNIT_CW,
                                       "cache_read": UNIT_CR, "output": UNIT_OUT},
                      "model_weights_approx": MODEL_WEIGHTS, "default_weight": DEFAULT_WEIGHT,
                      "bucket_minutes": BUCKET_MIN, "chars_per_token": CHARS_PER_TOKEN},
        "inputs": {"lead_transcripts": len(lead_files), "helper_transcripts": len(agents),
                   "lead_turns": len(lead_rows), "helper_transcripts_all": len(all_agents),
                   "earliest_timestamp_found": min(earliest) if earliest else None,
                   "lead_range": [lead_rows[0]["ts"], lead_rows[-1]["ts"]] if lead_rows else None,
                   "models_with_default_weight": sorted(unknown_models)},
        "totals": totals,
        "session_cost_state": session,
        "helpers": [{"label": a["id"], "kind": a["kind"],
                     "model": meta_of[a["id"]]["model"],
                     "start": a["start"], "end": a["end"], "turns": len(a["rows"]),
                     "units": round(sum(r["units"] for r in a["rows"]), 1)} for a in agents],
        "excluded_older_helpers": [{"label": a["id"], "kind": a["kind"], "start": a["start"],
                                    "units": round(sum(r["units"] for r in a["rows"]), 1)}
                                   for a in older_agents],
        "daily": daily_list,
        "buckets_15min": bucket_list,
        "lead_context_per_turn": ctx_series,
        "events": events,
        "savings_per_helper": savings,
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    os.replace(tmp, OUT)
    write_all(out, os.path.dirname(OUT))
    print("wrote", OUT)

# ---- charts (hand-written SVG) and Hebrew summary ---------------------------------
HEB_KIND = {"research": "מחקר", "build": "בנייה", "lookup": "בדיקה", "other": "אחר"}


def fmt(v):
    a = abs(v)
    if a >= 1e6:
        return "%.1fM" % (v / 1e6)
    if a >= 1e3:
        return "%.0fK" % (v / 1e3)
    return "%.0f" % v


def heb_label(label):
    k, _, n = label.rpartition("-")
    return "%s %s" % (HEB_KIND.get(k, k), n)


SVG_STYLE = """<style>
.bg{fill:#f6f6f3}.t{fill:#2b2d31}.m{fill:#6b6f76}.grid{stroke:#d3d4d0;stroke-width:1}
.ax{stroke:#8a8e95;stroke-width:1}.lead{fill:#4a7fb5;stroke:#4a7fb5}.ag{fill:#d9923b;stroke:#d9923b}
.good{fill:#4a9d6b}.bad{fill:#c2574f}.line{fill:none;stroke:#4a7fb5;stroke-width:2}
.mk1{stroke:#c2574f;stroke-width:2;stroke-dasharray:5 4}.mk2{stroke:#4a9d6b;stroke-width:2;stroke-dasharray:5 4}
.tx1{fill:#c2574f}.tx2{fill:#4a9d6b}
@media (prefers-color-scheme: dark){
.bg{fill:#25282c}.t{fill:#e6e7e9}.m{fill:#a4a9b0}.grid{stroke:#3c4147}.ax{stroke:#7b8088}
.lead{fill:#6fa3d8;stroke:#6fa3d8}.ag{fill:#e8a85a;stroke:#e8a85a}.good{fill:#62b886}.bad{fill:#e07b73}
.line{stroke:#6fa3d8}.mk1{stroke:#e07b73}.mk2{stroke:#62b886}.tx1{fill:#e07b73}.tx2{fill:#62b886}}
text{font-family:system-ui,"Segoe UI",Arial,sans-serif}
</style>"""


def svg_open(w, h, title, sub):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" '
            'role="img" aria-label="%s">%s<rect class="bg" width="%d" height="%d" rx="8"/>'
            '<text class="t" x="%d" y="30" font-size="18" font-weight="600" text-anchor="middle" '
            'direction="rtl" unicode-bidi="plaintext">%s</text>'
            '<text class="m" x="%d" y="50" font-size="12" text-anchor="middle" direction="rtl" '
            'unicode-bidi="plaintext">%s</text>') % (w, h, w, h, title, SVG_STYLE, w, h, w // 2, title, w // 2, sub)


def txt(x, y, s, cls="m", size=11, anchor="middle", extra=""):
    return '<text class="%s" x="%.1f" y="%.1f" font-size="%d" text-anchor="%s" direction="rtl" unicode-bidi="plaintext" %s>%s</text>' % (
        cls, x, y, size, anchor, extra, s)


def yaxis(x0, x1, y0, y1, vmin, vmax, n=4):
    out = []
    for i in range(n + 1):
        v = vmin + (vmax - vmin) * i / n
        y = y1 - (y1 - y0) * i / n
        out.append('<line class="grid" x1="%d" x2="%d" y1="%.1f" y2="%.1f"/>' % (x0, x1, y, y))
        out.append(txt(x0 - 6, y + 4, fmt(v), "m", 11, "end"))
    return "".join(out)


def legend(items, x, y):
    out = []
    for i, (cls, name) in enumerate(items):
        out.append('<rect class="%s" x="%d" y="%d" width="12" height="12" rx="2"/>' % (cls, x - i * 150, y))
        out.append(txt(x - i * 150 - 6, y + 10, name, "t", 12, "end"))
    return "".join(out)


def chart_daily(out, path):
    d = out["daily"]
    W, H, L, R, T, B = 760, 400, 70, 30, 80, 60
    vmax = max([x["lead"] + x["helpers"] for x in d] + [1]) * 1.1
    s = [svg_open(W, H, "שימוש יומי (יחידות אפקטיביות): ליד מול סוכנים",
                  "רק ימים שהתמלל שלהם נמצא במחשב; היסטוריה שנמחקה בדחיסה לא נכללת")]
    s.append(yaxis(L, W - R, T, H - B, 0, vmax))
    slot = (W - L - R) / max(len(d), 1)
    bw = min(120, slot * 0.55)
    for i, x in enumerate(d):
        cx = L + slot * (i + 0.5)
        hl = (H - B - T) * x["lead"] / vmax
        ha = (H - B - T) * x["helpers"] / vmax
        s.append('<rect class="lead" x="%.1f" y="%.1f" width="%.1f" height="%.1f"/>' % (cx - bw / 2, H - B - hl, bw, hl))
        s.append('<rect class="ag" x="%.1f" y="%.1f" width="%.1f" height="%.1f"/>' % (cx - bw / 2, H - B - hl - ha, bw, ha))
        s.append(txt(cx, H - B - hl - ha - 6, fmt(x["lead"] + x["helpers"]), "t", 12))
        s.append(txt(cx, H - B + 18, x["day_utc"], "m", 12))
        s.append(txt(cx, H - B + 34, "סוכנים: %d" % x["helper_count"], "m", 11))
    s.append(legend([("lead", "ליד (שיחה ראשית)"), ("ag", "סוכנים")], W - R - 10, 62))
    s.append("</svg>")
    open(path, "w", encoding="utf-8").write("".join(s))


def chart_context(out, path):
    pts = out["lead_context_per_turn"]
    ev = out["events"]
    W, H, L, R, T, B = 760, 400, 70, 30, 80, 60
    times = [parse_ts(p["ts"]).timestamp() for p in pts]
    hs = [parse_ts(e["ts"]).timestamp() for e in ev if e["type"] == "helpers_started"]
    t0 = min(times + hs) if times else 0
    t1 = max(times + [t0 + 1])
    vmax = max([p["context_tokens"] for p in pts] + [1]) * 1.1
    X = lambda t: L + (W - L - R) * (t - t0) / (t1 - t0)
    Y = lambda v: (H - B) - (H - B - T) * v / vmax
    s = [svg_open(W, H, "גודל ההקשר של הליד לאורך זמן (טוקנים)",
                  "הנתונים הקיימים מתחילים אחרי הדחיסה האחרונה; הציר: שעה (UTC)")]
    s.append(yaxis(L, W - R, T, H - B, 0, vmax))
    if pts:
        s.append('<polyline class="line" points="%s"/>' % " ".join("%.1f,%.1f" % (X(t), Y(p["context_tokens"])) for t, p in zip(times, pts)))
        for t, p in zip(times, pts):
            s.append('<circle class="lead" cx="%.1f" cy="%.1f" r="3"/>' % (X(t), Y(p["context_tokens"])))
    for e in ev:
        t = parse_ts(e["ts"]).timestamp()
        if e["type"] == "compaction" and t0 <= t <= t1:
            s.append('<line class="mk1" x1="%.1f" x2="%.1f" y1="%d" y2="%d"/>' % (X(t), X(t), T, H - B))
            s.append(txt(X(t) - 4, T + 14, "דחיסה (compaction)", "tx1", 12, "end"))
        if e["type"] == "helpers_started" and t0 <= t <= t1:
            s.append('<line class="mk2" x1="%.1f" x2="%.1f" y1="%d" y2="%d"/>' % (X(t), X(t), T, H - B))
            s.append(txt(X(t) + 4, T + 14, "הסוכנים התחילו", "tx2", 12, "start"))
    for i in range(5):
        t = t0 + (t1 - t0) * i / 4
        s.append(txt(X(t), H - B + 18, datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M"), "m", 11))
    s.append("</svg>")
    open(path, "w", encoding="utf-8").write("".join(s))


def chart_before_after(out, path):
    t = out["totals"]
    bars = [("ליד לפני סוכנים (גס)", t.get("lead_before_helpers_per_wall_hour_rough") or 0, "lead"),
            ("ליד אחרי סוכנים", t.get("lead_after_helpers_per_hour") or 0, "lead"),
            ("סוכנים", t.get("helpers_per_hour_of_window") or 0, "ag")]
    W, H, L, R, T, B = 760, 400, 70, 30, 80, 60
    vmax = max([b[1] for b in bars] + [1]) * 1.15
    s = [svg_open(W, H, "יחידות אפקטיביות לשעה: לפני מול אחרי הסוכנים",
                  "הערכה גסה בלבד: הצד של 'לפני' מחולק בשעות שעון כולל זמן סרק")]
    s.append(yaxis(L, W - R, T, H - B, 0, vmax))
    slot = (W - L - R) / len(bars)
    for i, (name, v, cls) in enumerate(bars):
        cx = W - R - slot * (i + 0.5)       # RTL order: first bar on the right
        h = (H - B - T) * v / vmax
        s.append('<rect class="%s" x="%.1f" y="%.1f" width="%.1f" height="%.1f"/>' % (cls, cx - 45, H - B - h, 90, h))
        s.append(txt(cx, H - B - h - 6, fmt(v), "t", 12))
        s.append(txt(cx, H - B + 20, name, "m", 12))
    s.append("</svg>")
    open(path, "w", encoding="utf-8").write("".join(s))


def chart_saved(out, path):
    sv = out["savings_per_helper"]
    W, H, L, R, T, B = 820, 420, 70, 30, 80, 70
    vals = [x["saved_with_estimate"] for x in sv] + [x["saved_if_lead_did_work_itself"] for x in sv]
    vmax, vmin = max(vals + [1]) * 1.15, min(vals + [-1]) * 1.15
    Y = lambda v: (H - B) - (H - B - T) * (v - vmin) / (vmax - vmin)
    s = [svg_open(W, H, "חיסכון משוער לכל סוכן (יחידות אפקטיביות)",
                  "מעל הקו = חסך; מתחת = עלה יותר ממה שחסך. שתי שיטות חישוב לכל סוכן")]
    s.append(yaxis(L, W - R, T, H - B, vmin, vmax, 5))
    s.append('<line class="ax" x1="%d" x2="%d" y1="%.1f" y2="%.1f"/>' % (L, W - R, Y(0), Y(0)))
    slot = (W - L - R) / max(len(sv), 1)
    for i, x in enumerate(sv):
        cx = W - R - slot * (i + 0.5)
        for j, key in enumerate(("saved_with_estimate", "saved_if_lead_did_work_itself")):
            v = x[key]
            bx = cx + (-1 if j == 0 else 0) * 0 - 14 + j * 15 - 1 * 0
            y0, y1 = sorted((Y(0), Y(v)))
            s.append('<rect class="%s" x="%.1f" y="%.1f" width="13" height="%.1f" opacity="%s"/>' % (
                "good" if v >= 0 else "bad", bx, y0, max(y1 - y0, 1), "1" if j else "0.55"))
        s.append(txt(cx, H - B + 18, heb_label(x["label"]), "m", 11))
    s.append(txt(W - R - 2, 66, "עמודה בהירה: רק הקשר שנחסך | עמודה מלאה: כולל תורות עבודה של הליד", "m", 11, "end"))
    s.append("</svg>")
    open(path, "w", encoding="utf-8").write("".join(s))


def write_summary(out, path):
    t, inp, ses = out["totals"], out["inputs"], out.get("session_cost_state") or {}
    hl = out["helpers"]
    kinds = defaultdict(int)
    for h in hl:
        kinds[h["kind"]] += 1
    lines = [
        "# סיכום שימוש: ליד מול סוכני עזר",
        "",
        "נוצר אוטומטית מהתמלילים שנמצאים במחשב. כולל מספרים, זמנים, שמות מודלים וסוגי סוכנים בלבד.",
        "",
        "## מספרים עיקריים",
        "- הנתון המוקדם ביותר שנמצא: %s (UTC)" % t.get("earliest_timestamp_found"),
        "- תמלילים שנסרקו: %d של הליד, %d של סוכנים (מחקר %d, בנייה %d, בדיקה %d, אחר %d)" % (
            inp["lead_transcripts"], inp["helper_transcripts_all"], kinds["research"], kinds["build"], kinds["lookup"], kinds["other"]),
        "- יחידות אפקטיביות של הליד שנמצאות בתמלילים: %s" % fmt(t["lead_units_on_disk"]),
        "- יחידות אפקטיביות של הסוכנים (הריצה הנוכחית): %s; כל הימים: %s" % (fmt(t["helpers_units_total"]), fmt(t["helpers_units_all_days"])),
        "- ליד אחרי תחילת הסוכנים: %s ליחידות לשעה (חלון קצר מאוד, %.2f שעות)" % (fmt(t["lead_after_helpers_per_hour"] or 0), t["lead_after_helpers_window_hours"]),
        "- סוכנים: %s ליחידות לשעה בחלון הסוכנים" % fmt(t["helpers_per_hour_of_window"] or 0),
        "- חיסכון משוער לפי הנוסחה הבסיסית (הקשר שהליד היה נושא): %s (שלילי = הסוכנים עלו יותר)" % fmt(t["saved_units_with_estimated_missing_turns"]),
        "- חיסכון משוער כולל תורות העבודה שהליד היה מבצע בעצמו: %s" % fmt(t["saved_units_incl_lead_own_work_turns"]),
        "",
        "## איך מחשבים (במילים פשוטות)",
        "- כל הודעת עוזר נספרת כך: קלט x1, כתיבה למטמון x2, קריאה ממטמון x0.1, פלט x5, ואז כפל במשקל מודל (Opus 1.0, Sonnet 0.6, Haiku 0.2; משקלים יחסיים משוערים, לא מחירים מדויקים).",
        "- חיסכון לסוכן: אם הליד היה מבצע את העבודה בעצמו, כל מה שהסוכן קרא וכתב היה נכנס להקשר של הליד, והליד היה קורא אותו מחדש מהמטמון בכל תור עד הדחיסה הבאה (x0.1). מחסירים את מה שהסוכן עלה בפועל. גרסה שנייה מוסיפה גם את התורות שהליד היה מבלה בעבודה עצמה.",
        "",
        "## הסתייגויות",
        "- ההיסטוריה של הליד לפני הדחיסה האחרונה נמחקה מהדיסק, ולכן ההשוואה 'לפני סוכנים' לשעה היא הערכה גסה ביותר (מבוססת על סיכום הסשן הכולל וכוללת זמן סרק).",
        "- מספר תורות הליד שאחרי כל סוכן נמדד רק עבור מה שנשמר, והשאר מוערך לפי קצב התורות שנצפה.",
        "- בנתונים הקיימים אין הוכחה לחיסכון ברור: לפי הנוסחה הבסיסית הסוכנים עלו יותר מהחיסכון, ולפי הגרסה המורחבת התוצאה קרובה לאיזון. מומלץ לא לפרסם זאת כהוכחה לחיסכון בלי לחזור ולמדוד על תקופה ארוכה יותר.",
        "",
        "## קבצים",
        "usage.json, daily_usage.svg, lead_context.svg, before_after.svg, saved_per_agent.svg",
        "",
    ]
    open(path, "w", encoding="utf-8").write("\n".join(lines))


def write_all(out, d):
    chart_daily(out, os.path.join(d, "daily_usage.svg"))
    chart_context(out, os.path.join(d, "lead_context.svg"))
    chart_before_after(out, os.path.join(d, "before_after.svg"))
    chart_saved(out, os.path.join(d, "saved_per_agent.svg"))
    write_summary(out, os.path.join(d, "summary.md"))



if __name__ == "__main__":
    main()
