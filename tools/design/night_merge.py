"""Merges a `pnpm design:render` result into the one publish prepared for the design doc (out/night).

Why not the renderer's own canvas merge: tonight's publish has to sit on top of the LIVE canvas (Roee edits it), mark
"newest" only on boards that are new or whose picture changed against the live doc, and lay the new boards out by
area (title per area, rows that wrap) so every board is visible on the canvas, with no marker over a design.

Usage (nothing is published; Claude publishes publish.json with publish_files, base_version = BASE_VERSION):
  python3 tools/design/night_merge.py --render <render out dir> --live-canvas <live canvas.json> \
      --live-version <version> --live-boards <dir with the live .dc.html of boards that are on the doc already> \
      --night tools/design/out/night

The area of a board is the "group" of its scenario file (tools/design/scenarios); areas go in AREA_ORDER, others last.
"""
import argparse
import base64
import io
import json
import os
import re
import shutil

from PIL import Image  # Pillow: reads the pictures inside the boards

AREA_ORDER = ["סוכנים", "צ'אט", "דפדפן ומחשב", "משחקים", "מודלים", "פתיחה", "זיכרון", "קול", "האב", "עיצוב"]
ROW_W = 7600       # a row of new boards wraps after this width
SIDE = 380         # room kept beside each board (as design_marks.py)
GAP = 900          # between rows: room for the newest note (and the area title) above each row
NOTE_PAD, NOTE_ABOVE, NOTE_H = 28, 340, 300
MIN_PIXELS = 1000   # fewer differing pixels than this = the same picture
SIDEBAR = 264      # width of a computer board's sidebar (Hebrew: on the right)
TOLERANCE = 48     # a channel may be off by this much and the picture still counts as the same (as design-png.ts)


def board_png(path):
    """The picture inside a .dc.html board, or None."""
    m = re.search(r'src="data:image/png;base64,([^"]+)"', open(path, encoding="utf8").read())
    return Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGB") if m else None


def differs(a, b, desktop):
    """True when the pictures really differ: another size, or more than MIN_PIXELS pixels off by more than TOLERANCE.
    A computer board's sidebar and top bar (the right 264 px; version, port and nav items change every build) are
    left out, and a few stray pixels are Chromium's own noise."""
    if a is None or b is None or a.size != b.size:
        return True
    from PIL import ImageChops
    if desktop:
        a, b = a.crop((0, 0, a.size[0] - SIDEBAR, a.size[1])), b.crop((0, 0, b.size[0] - SIDEBAR, b.size[1]))
    d = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > TOLERANCE else 0)
    return d.histogram()[255] > MIN_PIXELS


def overlaps(a, b):
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def note_place(boards, name):
    """Above the board when free, else beside it, else below (no marker may cover a design)."""
    b = boards[name]
    others = [o for n, o in boards.items() if n != name]
    free = lambda r: not any(overlaps(r, o) for o in others)
    above = {"x": b["x"] - NOTE_PAD, "y": b["y"] - NOTE_PAD - NOTE_ABOVE, "w": b["w"] + 2 * NOTE_PAD, "h": NOTE_H}
    if free(above):
        return above["x"], above["y"], above["w"]
    beside = {"x": b["x"] + b["w"] + 40, "y": b["y"], "w": 260, "h": NOTE_H}
    if free(beside):
        return beside["x"], beside["y"], 260
    return b["x"], b["y"] + b["h"] + 40, max(260, b["w"])


def scenario_groups(scen_dir):
    """Board file name -> (area group, order index), from the scenario files."""
    out = {}
    for f in sorted(os.listdir(scen_dir)):
        if not f.endswith(".json"):
            continue
        d = json.load(open(os.path.join(scen_dir, f), encoding="utf8"))
        for b in d["boards"]:
            for vp in b.get("viewports", ["desktop", "phone"]):
                out[f"{b['id']}{'Phone' if vp == 'phone' else ''}.dc.html"] = (d["group"], len(out))
    return out


def area_rank(group):
    first = group.split("·")[0].strip()
    return AREA_ORDER.index(first) if first in AREA_ORDER else len(AREA_ORDER)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", required=True)
    ap.add_argument("--live-canvas", required=True)
    ap.add_argument("--live-version", required=True)
    ap.add_argument("--live-boards", required=True)
    ap.add_argument("--night", required=True)
    ap.add_argument("--scenarios", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenarios"))
    a = ap.parse_args()

    state = json.load(open(os.path.join(a.render, "state.json"), encoding="utf8"))["boards"]
    groups = scenario_groups(a.scenarios)
    canvas = json.load(open(a.live_canvas, encoding="utf8"))
    cb = canvas["boards"]

    status = {}  # name -> new | updated | same
    for name in state:
        if name not in cb:
            status[name] = "new"
        else:
            live = os.path.join(a.live_boards, name)
            same = os.path.exists(live) and not differs(board_png(live), board_png(os.path.join(a.render, "project", name)), not name.endswith("Phone.dc.html"))
            status[name] = "same" if same else "updated"

    # The canvas: the live one, tonight's old markers removed, changed boards resized in place.
    for k in [k for k in canvas["notes"] if k.startswith("mk-")]:
        del canvas["notes"][k]
    canvas["noteOrder"] = [k for k in canvas["noteOrder"] if not k.startswith("mk-")]
    for name, s in status.items():
        if s == "updated":
            b = state[name]
            cb[name].update({"w": b["w"], "h": b["h"], "title": b["title"]})

    # New boards by area: a title, then rows that wrap; each board followed by its phone twin as rendered.
    fresh = [n for n, s in status.items() if s == "new"]
    areas = sorted({groups.get(n, (state[n]["group"], 0))[0] for n in fresh}, key=lambda g: (area_rank(g), g))
    bottom = max(b["y"] + b["h"] for b in cb.values())
    for gi, g in enumerate(areas):
        names = sorted((n for n in fresh if groups.get(n, (state[n]["group"], 0))[0] == g), key=lambda n: groups.get(n, ("", 0))[1])
        y = bottom + GAP + 300  # extra room for the area title above the first row
        x, rowh, widest = 0, 0, 0
        for n in names:
            b = state[n]
            if x and x + b["w"] > ROW_W:
                widest = max(widest, x)
                y += rowh + GAP
                x, rowh = 0, 0
            cb[n] = {"x": x, "y": y, "w": b["w"], "h": b["h"], "title": b["title"]}
            canvas["order"].append(n)
            x += b["w"] + SIDE
            rowh = max(rowh, b["h"])
        widest = max(widest, x)
        tid = f"dg-night-{gi}"
        first_y = min(cb[n]["y"] for n in names)
        canvas["notes"][tid] = {"x": 0, "y": first_y - NOTE_ABOVE - NOTE_PAD - 260, "w": 240, "maxW": max(1820, widest), "text": g, "kind": "title1"}
        canvas["noteOrder"].append(tid)
        bottom = y + rowh

    # The newest notes: only new and changed boards.
    marked = [n for n, s in status.items() if s != "same"]
    for i, n in enumerate(marked):
        x, y, w = note_place(cb, n)
        label = ("חדש" if status[n] == "new" else "עודכן") + ": " + cb[n]["title"]
        canvas["notes"][f"mk-newest{i}"] = {"x": x, "y": y, "w": w, "text": f"🆕 הכי חדש · {label}", "fill": "orange", "size": "xl", "bold": True}
        canvas["noteOrder"].append(f"mk-newest{i}")

    # Files: the changed and new boards + canvas.json (the template SceneTogether.dc.html stays; it is not published).
    proj = os.path.join(a.night, "project")
    os.makedirs(proj, exist_ok=True)
    for f in os.listdir(proj):
        if f.endswith(".dc.html") and f != "SceneTogether.dc.html":
            os.remove(os.path.join(proj, f))
    for n in marked:
        shutil.copy(os.path.join(a.render, "project", n), os.path.join(proj, n))
    json.dump(canvas, open(os.path.join(proj, "canvas.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
    pub = [{"as": f"project/{n}", "path": os.path.abspath(os.path.join(proj, n))} for n in sorted(marked)]
    pub.append({"as": "project/canvas.json", "path": os.path.abspath(os.path.join(proj, "canvas.json"))})
    json.dump(pub, open(os.path.join(a.night, "publish.json"), "w"), indent=1)
    open(os.path.join(a.night, "BASE_VERSION"), "w").write(a.live_version + "\n")

    # SUMMARY.md for the morning report.
    lines = [f"# Night design publish (base version {a.live_version}; NOT published)", "",
             f"{len(marked)} boards to publish ({sum(status[n] == 'new' for n in marked)} new, {sum(status[n] == 'updated' for n in marked)} updated); "
             f"{sum(s == 'same' for s in status.values())} rendered boards equal the live doc and are left as they are.", ""]
    by = {}
    for n in marked:
        by.setdefault(groups.get(n, (state[n]["group"], 0))[0], []).append(n)
    for g in sorted(by, key=lambda g: (area_rank(g), g)):
        lines += [f"## {g}", ""] + [f"- {cb[n]['title']} ({n[:-8]}) — {status[n]}" for n in sorted(by[g], key=lambda n: groups.get(n, ('', 0))[1])] + [""]
    same = [n for n, s in status.items() if s == "same"]
    if same:
        lines += ["## Unchanged against the live doc (no newest mark)", ""] + [f"- {cb[n]['title']} ({n[:-8]})" for n in same] + [""]
    open(os.path.join(a.night, "SUMMARY.md"), "w", encoding="utf8").write("\n".join(lines))
    print(len(marked), "boards;", {s: list(status.values()).count(s) for s in ("new", "updated", "same")})


if __name__ == "__main__":
    main()
