import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, dayKey, dayStats, parseInsights, skipReason, type Capture } from "./journal.js";

test("skip rules: password managers, private windows, sign-in pages, excluded apps", () => {
  assert.equal(skipReason("1Password", "Vault", []), "password-manager");
  assert.equal(skipReason("msedge", "New tab - InPrivate", []), "private-window");
  assert.equal(skipReason("chrome", "Sign in - Google Accounts", []), "sensitive");
  assert.equal(skipReason("Spotify.exe", "Song", ["spotify"]), "excluded");
  assert.equal(skipReason("Code", "main.ts - kesher", []), undefined);
});

test("day stats: time per app, switches, longest focus, meetings", () => {
  const t0 = new Date("2026-11-07T09:00:00").getTime();
  const caps: Capture[] = [];
  for (let i = 0; i < 20; i++) caps.push({ t: t0 + i * 30_000, app: "Code", title: "a.ts" });
  for (let i = 20; i < 30; i++) caps.push({ t: t0 + i * 30_000, app: "Teams", title: "Weekly sync | Microsoft Teams" });
  caps.push({ t: t0 + 30 * 30_000, app: "Code", title: "a.ts" });
  caps.push({ t: t0 + 31 * 30_000, app: "", title: "", idle: true });
  const s = dayStats(caps, 30);
  assert.equal(s.apps[0]!.app, "Code");
  assert.equal(s.switches, 2);
  assert.equal(s.longestFocus.app, "Code");
  assert.equal(s.longestFocus.minutes, 10);
  assert.equal(s.meetings.length, 1);
  assert.equal(s.hours[9], s.activeMinutes);
});

test("parses the model's JSON even with words around it", () => {
  const r = parseInsights('Here:\n```json\n{"observations":[{"from":"09:00","to":"09:30","text":"Wrote code"}],"actions":[{"text":"Send the report","who":"Dana"}],"entities":[{"name":"KesherAI","kind":"project"},{"name":"x"}]}\n```');
  assert.equal(r.observations[0]!.text, "Wrote code");
  assert.equal(r.actions[0]!.who, "Dana");
  assert.equal(r.entities.length, 1);
  assert.deepEqual(parseInsights("no json"), { observations: [], actions: [], entities: [] });
});

test("captures, skips sensitive windows, dedups pictures, summarizes, searches, forgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-journal-"));
  const screens = [
    { app: "Code", title: "journal.ts", text: "export class Journal", hash: "A" },
    { app: "Code", title: "journal.ts", text: "export class Journal", hash: "A" },
    { app: "chrome", title: "Sign in - Bank", text: "password", hash: "B" },
    { app: "Outlook", title: "Inbox", text: "Dana: please send the Q3 report by Friday", hash: "C" },
    { app: "Outlook", title: "Inbox", text: "Dana: please send the Q3 report by Friday", hash: "D" },
  ];
  let i = 0;
  let sentLog = "";
  const j = new Journal(
    dir,
    () => ({
      id: "local/m",
      local: true,
      turn: async (req) => {
        sentLog = String(req.messages[1]!.content);
        return { text: '{"observations":[{"text":"Worked on the journal, then read email from Dana."}],"actions":[{"text":"Send the Q3 report","who":"Dana"}],"entities":[{"name":"Dana","kind":"person","note":"Asked for the Q3 report"}]}', toolCalls: [] };
      },
    }),
    async (frame) => {
      const s = screens[i++]!;
      await writeFile(frame, "jpg");
      return { t: Date.now() + i, app: s.app, title: s.title, text: s.text, frame: "", hash: s.hash };
    },
  );
  await j.update({ enabled: true, intervalSec: 600 });
  for (let k = 0; k < screens.length; k++) await j.tick();
  j.close();
  const day = dayKey(Date.now());
  const caps = await j.captures(day);
  assert.equal(caps.length, 5);
  assert.equal(caps[1]!.frame, undefined); // same screen: no second picture
  assert.equal(caps[2]!.skipped, "sensitive");
  assert.equal(caps[2]!.title, "");
  assert.equal(caps[2]!.text, undefined);
  assert.equal((await readdir(join(dir, day, "frames"))).length, 3);

  const ins = await j.summarize(day);
  assert.doesNotMatch(sentLog, /password|Bank/);
  assert.equal(ins.actions[0]!.text, "Send the Q3 report");
  assert.equal((await j.listEntities())[0]!.name, "Dana");
  // Summarizing again adds nothing (no new captures).
  assert.equal((await j.summarize(day)).actions.length, 1);

  const hits = await j.search("q3 report");
  assert.ok(hits.some((h) => h.kind === "screen"));
  assert.ok(hits.some((h) => h.kind === "action"));
  assert.equal((await j.search("password")).length, 0);

  await j.setAction(day, ins.actions[0]!.id, "done");
  assert.equal((await j.openActions()).length, 0);

  assert.equal(await j.forgetRecent(60), 5);
  await j.forgetDay(day);
  assert.equal((await j.days()).length, 0);
  assert.equal((await j.listEntities()).length, 0);
});

test("a cloud model needs permission to read the screen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-journal-"));
  let n = 0;
  const j = new Journal(dir, () => ({ id: "openai/gpt", local: false, turn: async () => ({ text: "{}", toolCalls: [] }) }), async () => ({ t: Date.now() + n++, app: "Code", title: `f${n}`, text: "x" }));
  await j.update({ enabled: true, intervalSec: 600 });
  for (let k = 0; k < 4; k++) await j.tick();
  j.close();
  assert.match((await j.summarize(dayKey(Date.now()))).error ?? "", /cloud/);
});

test("meetings: transcript pieces, write-up, actions join the day, search", async () => {
  const { parseMeeting } = await import("./journal.js");
  const dir = await mkdtemp(join(tmpdir(), "kesher-journal-"));
  let sent = "";
  const j = new Journal(dir, () => ({
    id: "local/m",
    local: true,
    turn: async (req) => {
      sent = String(req.messages[1]!.content);
      return { text: '{"summary":"Agreed to ship on Thursday.","decisions":["Ship Thursday"],"actions":[{"text":"Update the release notes","who":"Roee"}]}', toolCalls: [] };
    },
  }));
  const { day, meeting } = await j.startMeeting("Weekly sync | Microsoft Teams");
  const t = Date.now();
  await j.addSegment(day, meeting.id, t + 2000, "and then we ship on Thursday, right?", "others");
  await j.addSegment(day, meeting.id, t + 1000, "Let's talk about the release date.", "me");
  await j.addSegment(day, meeting.id, t, "   ");
  const m = await j.finishMeeting(day, meeting.id);
  assert.match(sent, /Me: Let's talk about the release date[\s\S]*Others: and then we ship on Thursday/);
  assert.equal(m.summary, "Agreed to ship on Thursday.");
  assert.deepEqual(m.decisions, ["Ship Thursday"]);
  assert.equal(m.segments.length, 2);
  const ins = await j.insights(day);
  assert.equal(ins.actions[0]!.who, "Roee");
  assert.equal(ins.observations[0]!.kind, "meeting");
  assert.ok((await j.search("thursday")).some((h) => h.kind === "meeting"));
  assert.equal((await j.meetings(day)).length, 1);
  await j.deleteMeeting(day, meeting.id);
  assert.equal((await j.meetings(day)).length, 0);
  await assert.rejects(j.addSegment(day, "../../etc", 0, "x"));
  assert.equal(parseMeeting("just text").summary, "just text");
});
