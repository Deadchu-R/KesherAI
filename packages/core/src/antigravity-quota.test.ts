import { test } from "node:test";
import assert from "node:assert/strict";
import { listeningPorts, parseServers, quotaBackAt, readAntigravityQuota, readQuota } from "./antigravity-quota.js";

const CMD = `4242 C:\\Apps\\Antigravity\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe --enable_lsp --csrf_token 1a2b-3c --extension_server_port 51000
77 C:\\Other\\language_server_windows_x64.exe --csrf_token zzz
9 node something`;

test("the Antigravity language server is found with its token; another program's is not", () => {
  assert.deepEqual(parseServers(CMD), [{ pid: 4242, csrf: "1a2b-3c", port: 51000 }]);
});

test("listening ports come from netstat (Windows) and lsof (macOS, Linux)", () => {
  const net = "  TCP    127.0.0.1:51001        0.0.0.0:0              LISTENING       4242\n  TCP    0.0.0.0:445    0.0.0.0:0    LISTENING    4";
  assert.deepEqual(listeningPorts(net, 4242), [51001]);
  const lsof = "language_ 4242 roee 12u IPv4 0x1 0t0 TCP 127.0.0.1:51002 (LISTEN)";
  assert.deepEqual(listeningPorts(lsof, 4242), [51002]);
});

test("each model's quota is read wherever it sits; a used-up model has no fraction", () => {
  const json = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: "Claude Opus 4.6 (Thinking)", quotaInfo: { resetTime: "2026-11-26T21:00:00Z" } },
    { label: "Gemini 3.1 Pro", quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-26T20:00:00Z" } },
  ] } } };
  const q = readQuota(json, 1)!;
  assert.deepEqual(q.models.map((m) => [m.name, m.left]), [["Claude Opus 4.6 (Thinking)", 0], ["Gemini 3.1 Pro", 0.4]]);
  assert.equal(quotaBackAt(q), undefined, "one model still has quota");
  assert.equal(quotaBackAt({ at: 1, models: [q.models[0]!] }), Date.parse("2026-11-26T21:00:00Z"));
  assert.equal(readQuota({ nothing: true }, 1), undefined);
});

test("the reading asks the language server on 127.0.0.1 with its token, and is undefined when Antigravity is closed", async () => {
  const asked: string[] = [];
  const run = async (file: string) => (file === "powershell.exe" ? CMD : "  TCP    127.0.0.1:51001  0.0.0.0:0  LISTENING  4242");
  const post = async (port: number, path: string, _b: string, h: Record<string, string>, tls: boolean) => {
    asked.push(`${port} ${tls} ${h["x-codeium-csrf-token"]}`);
    return port === 51001 && tls && path.endsWith("/GetUserStatus") ? JSON.stringify({ x: [{ label: "M", quotaInfo: { remainingFraction: 1 } }] }) : undefined;
  };
  const q = await readAntigravityQuota({ platform: "win32", run, post, now: 5 });
  assert.deepEqual(q, { at: 5, models: [{ name: "M", left: 1 }] });
  assert.equal(asked[0], "51001 true 1a2b-3c");
  assert.equal(await readAntigravityQuota({ platform: "linux", run: async () => "", post, now: 5 }), undefined);
});

test("the CSRF token goes only to ports the language server itself listens on, and only this user's processes are listed", async () => {
  const asked: number[] = [];
  const files: string[][] = [];
  // The command line names port 51000, but another process listens there; the server's own port is 51001.
  const run = async (file: string, args: string[]) => (files.push([file, ...args]), file === "ps" ? CMD.replace(/^\d+ C:\S+/, "4242 /opt/antigravity/language_server_linux") : "node 999 me 20u IPv4 0t0 TCP 127.0.0.1:51000 (LISTEN)\nlanguage_ 4242 me 21u IPv4 0t0 TCP 127.0.0.1:51001 (LISTEN)");
  const post = async (port: number) => (asked.push(port), undefined);
  assert.equal(await readAntigravityQuota({ platform: "linux", run, post, now: 5 }), undefined);
  assert.deepEqual([...new Set(asked)], [51001]);
  assert.deepEqual(files[0], ["ps", "-x", "-o", "pid=,command="]);
});

test("model names and counts in the answer are capped", () => {
  const q = readQuota({ m: Array.from({ length: 100 }, (_, i) => ({ label: `${"x".repeat(200)}${i}`, quotaInfo: { remainingFraction: 0.5 } })) }, 1);
  assert.equal(q?.models.length, 40);
  assert.ok(q!.models.every((m) => m.name.length <= 80));
});
