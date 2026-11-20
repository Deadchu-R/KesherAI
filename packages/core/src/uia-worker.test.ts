import { test } from "node:test";
import assert from "node:assert/strict";
import { UiaWorker, powershellWorker, type UiaTransport } from "./uia-worker.js";
import { UIA_SCRIPT, releaseScript } from "./uia-script.js";

/** A fake worker process: records what is written, answers by a function, and can end. */
function fakeSpawn(answer: (req: { id: number; op: string; args: Record<string, unknown> }) => unknown | undefined, hello: Record<string, unknown> = { hello: "kesher-uia", version: 1, elevated: false }) {
  const st = { spawned: 0, killed: 0, written: [] as string[], exit: undefined as undefined | ((c: number | null, e: string) => void) };
  const spawnWorker = (): UiaTransport => {
    st.spawned++;
    let onLine: (l: string) => void = () => undefined;
    let alive = true;
    const t: UiaTransport = {
      write: (line) => {
        st.written.push(line);
        const req = JSON.parse(line) as { id: number; op: string; args: Record<string, unknown> };
        const r = answer(req);
        if (r !== undefined) setImmediate(() => alive && onLine(JSON.stringify(r)));
      },
      onLine: (fn) => {
        onLine = fn;
        setImmediate(() => {
          fn("WARNING: a PowerShell line that is not JSON");
          fn(JSON.stringify(hello));
        });
      },
      onExit: (fn) => void (st.exit = fn),
      kill: () => {
        alive = false;
        st.killed++;
      },
    };
    return t;
  };
  return { st, spawnWorker };
}

test("uia worker: starts once on demand, matches answers by id, reports errors", async () => {
  const { st, spawnWorker } = fakeSpawn((r) =>
    r.op === "bad" ? { id: r.id, ok: false, error: "No such ref." } : { id: r.id, ok: true, result: { op: r.op, args: r.args } },
  );
  const w = new UiaWorker(spawnWorker);
  assert.equal(w.running(), false, "nothing runs before the first call");
  const [a, b] = await Promise.all([w.call<{ op: string }>("windows"), w.call<{ args: { x: number } }>("tree", { x: 1 })]);
  assert.equal(a.op, "windows");
  assert.equal(b.args.x, 1);
  assert.equal(st.spawned, 1, "one process for both calls");
  assert.equal(w.running(), true);
  await assert.rejects(w.call("bad"), /No such ref/);
  assert.ok(st.written.every((l) => l.endsWith("\n") && JSON.parse(l).id > 0), "one JSON request per line");
  w.kill();
  assert.equal(st.killed, 1);
  assert.equal(w.running(), false);
});

test("uia worker: an elevated worker is killed and refused", async () => {
  const { st, spawnWorker } = fakeSpawn(() => undefined, { hello: "kesher-uia", version: 1, elevated: true });
  const w = new UiaWorker(spawnWorker);
  await assert.rejects(w.call("windows"), /administrator/);
  assert.equal(st.killed, 1);
  assert.equal(st.written.length, 0, "no request reaches an elevated worker");
  assert.equal(w.running(), false);
});

test("uia worker: a call that does not answer kills the worker; the next call starts a new one", async () => {
  let hang = true;
  const { st, spawnWorker } = fakeSpawn((r) => (hang ? undefined : { id: r.id, ok: true, result: "ok" }));
  const w = new UiaWorker(spawnWorker, { callTimeoutMs: 30 });
  await assert.rejects(w.call("tree"), /did not answer/);
  assert.equal(st.killed, 1);
  hang = false;
  assert.equal(await w.call("ping"), "ok");
  assert.equal(st.spawned, 2);
  w.kill();
});

test("uia worker: kill fails waiting calls, lets go of held keys and the mouse button", async () => {
  const released: Array<{ keys: unknown[]; mouse: boolean }> = [];
  const { spawnWorker } = fakeSpawn((r) => (r.op === "mouse" ? { id: r.id, ok: true, result: {} } : undefined));
  const w = new UiaWorker(spawnWorker, { release: (keys, mouse) => released.push({ keys, mouse }) });
  await w.call("mouse", { kind: "down", x: 1, y: 1 });
  const hold = w.call("holdKey", { keys: [{ vk: 0x10 }, { vk: 0x57 }], ms: 5000 });
  await new Promise((r) => setImmediate(r));
  w.kill("The user pressed Stop.");
  await assert.rejects(hold, /pressed Stop/);
  assert.deepEqual(released, [{ keys: [{ vk: 0x10 }, { vk: 0x57 }], mouse: true }]);
});

test("uia worker: an abort (Stop) kills it; the process ending fails waiting calls", async () => {
  const { st, spawnWorker } = fakeSpawn(() => undefined);
  const w = new UiaWorker(spawnWorker);
  const ac = new AbortController();
  const p = w.call("wait", {}, { signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await assert.rejects(p, /Stopped/);
  assert.equal(st.killed, 1);
  const q = w.call("tree");
  await new Promise((r) => setImmediate(r));
  st.exit?.(1, "boom");
  await assert.rejects(q, /ended \(code 1\): boom/);
  assert.equal(w.running(), false);
});

test("uia worker: stops itself when idle", async () => {
  const { st, spawnWorker } = fakeSpawn((r) => ({ id: r.id, ok: true, result: 1 }));
  const w = new UiaWorker(spawnWorker, { idleMs: 20 });
  await w.call("ping");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(st.killed, 1);
  assert.equal(w.running(), false);
});

test("uia script: ASCII only, every op answered, release script lets go in reverse", () => {
  assert.ok([...UIA_SCRIPT].every((c) => c.charCodeAt(0) < 128), "PowerShell 5.1 reads a file without BOM in the system code page");
  for (const op of ["ping", "windows", "tree", "act", "setValue", "focus", "move", "wait", "holdKey", "cursor", "mouse", "clipboardGet", "clipboardSet", "quit"])
    assert.ok(UIA_SCRIPT.includes(`'${op}' {`), op);
  assert.match(UIA_SCRIPT, /if \(\$elevated\) \{ exit 3 \}/);
  const s = releaseScript([{ vk: 0x11 }, { vk: 0x25, ext: true }], true);
  assert.ok(s.indexOf("keybd_event(37, 0, 3") < s.indexOf("keybd_event(17, 0, 2"), "extended key up, last pressed first");
  assert.match(s, /mouse_event\(4,/);
});

test("uia worker on Windows: the real PowerShell worker lists windows and is killed", { skip: process.platform !== "win32" }, async () => {
  const w = new UiaWorker(powershellWorker);
  try {
    const r = await w.call<{ windows: unknown[]; monitors: Array<{ index: number }> }>("windows", {}, { timeoutMs: 30_000 });
    assert.ok(Array.isArray(r.windows));
    assert.ok(r.monitors.length >= 1);
    const c = await w.call<{ x: number; y: number }>("cursor");
    assert.equal(typeof c.x, "number");
    assert.equal(w.running(), true);
  } finally {
    w.kill();
  }
  assert.equal(w.running(), false);
});
