import { test } from "node:test";
import assert from "node:assert/strict";
import { countPlaceholders, entropy, findLeaks, leakSummary, luhn, privacyModeOf, redactLeaks, type LeakKind } from "./leak-guard.js";
import { connectionTrainingRisk, freeTierTrains, trainingRiskOf } from "./training-risk.js";
import { FREE_PROVIDERS } from "./task-inbox.js";

const kinds = (text: string, ctx = {}): LeakKind[] => findLeaks(text, ctx).map((h) => h.kind);
// Built from parts, so no scanner mistakes this test file for real secrets.
const gh = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const aws = "AKIA" + "IOSFODNN7EXAMPLE";
const sk = "sk-" + "proj-" + "Zx81Qm2Lk93Hd7Tq0Wv5Bn6Yc4Rf1Ga8Ue";
const goog = "AIza" + "SyD3h7Kq9Lm2Np4Rs6Tv8Xw0Yz1Ab3Cd5E";

test("keys and tokens by their prefixes", () => {
  for (const k of [gh, aws, sk, goog, "hf_" + "AbCdEfGhIjKlMnOpQrStUvWxYz123456", "xoxb-" + "1234567890-abcdefghij"]) assert.deepEqual(kinds(`token is ${k} here`), ["key"], k.slice(0, 5));
});

test("private key blocks are hidden whole", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2\nabc\n-----END RSA PRIVATE KEY-----";
  const r = redactLeaks(`before\n${pem}\nafter`);
  assert.equal(r.text, "before\n[private key hidden]\nafter");
});

test(".env lines, config passwords and URL passwords", () => {
  assert.deepEqual(kinds("DB_PASSWORD=hunter2hunter\nSTRIPE_SECRET=abcdef123456"), ["password", "key"]);
  assert.deepEqual(kinds(`const config = { password: "S3cret!pw" }`), ["password"]);
  assert.deepEqual(kinds(`"apiKey": "9f8e7d6c5b4a39281706"`), ["key"]);
  assert.deepEqual(kinds("password: hunter22"), ["password"]);
  const r = redactLeaks("postgres://admin:pa55word@db.local:5432/app");
  assert.equal(r.text, "postgres://admin:[password hidden]@db.local:5432/app");
});

test("no false positives on ordinary code", () => {
  const code = [
    `const key = "id";`,
    `const token = getToken();`,
    `let maxTokens = 4096;`,
    `password: string;`,
    `const apiKey = process.env.API_KEY;`,
    `API_KEY=\${API_KEY}`,
    `OPENAI_API_KEY=your-key-here`,
    `const tokenType = "Bearer";`,
    `headers["x-api-key"] = apiKey;`,
    `const secret = config.secret;`,
    `commit 128145bc6e106a19428c64333c761227ad047de4`,
    `"integrity": "sha512-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp=="`,
    `function handleUserAuthenticationCallbackExtended() {}`,
    `const id = 123456789; const ts = 1732370000000;`,
    `const version = "0.6.464"; const port = 8080;`,
    `git clone git@github.com:owner/repo.git`,
    `author: Roee Tal <Deadchu-R@users.noreply.github.com>`,
    `contact: someone@example.com`,
    `img src="logo@2x.png"`,
    `cd /home/runner/work && ls /Users/Shared`,
  ].join("\n");
  assert.deepEqual(findLeaks(code), []);
});

test("emails, phones, IDs and card numbers", () => {
  assert.deepEqual(kinds("write to dana.levi@gmail.com"), ["email"]);
  assert.deepEqual(kinds("call +972 52-123-4567 or 050-1234567"), ["phone", "phone"]);
  assert.deepEqual(kinds("ת.ז. 000000018"), ["id-number"]);
  assert.deepEqual(kinds("ID number: 000000018"), ["id-number"]);
  assert.deepEqual(kinds("ID number: 000000019"), [], "a wrong check digit is not an ID");
  assert.deepEqual(kinds("SSN 123-45-6789"), ["id-number"]);
  assert.deepEqual(kinds("card 4111 1111 1111 1111 exp 12/29"), ["card"]);
  assert.deepEqual(kinds("card 4111 1111 1111 1112"), [], "fails Luhn");
});

test("Luhn and entropy helpers", () => {
  assert.equal(luhn("4111111111111111"), true);
  assert.equal(luhn("4111111111111112"), false);
  assert.ok(entropy("aaaa") === 0);
  assert.ok(entropy("Zx81Qm2Lk93Hd7Tq0Wv5Bn6Yc4Rf1Ga8") > 4.3);
});

test("paths with the user name (POSIX: case matters)", () => {
  const ctx = { username: "dana", home: "/home/dana", platform: "linux" };
  assert.equal(redactLeaks("open /home/dana/notes.txt", ctx).text, "open [home hidden]/notes.txt");
  assert.equal(redactLeaks("see /mnt/dana/x", ctx).text, "see /mnt/[user hidden]/x");
  assert.equal(redactLeaks("see /mnt/Dana/x", ctx).text, "see /mnt/Dana/x");
  assert.deepEqual(kinds("dana said hi", ctx), [], "a bare name is not a path");
});

test("paths with the user name (Windows: any case, either slash)", () => {
  const ctx = { username: "Dana", home: "C:\\Users\\Dana", platform: "win32" };
  assert.equal(redactLeaks("C:\\Users\\Dana\\Desktop\\a.txt", ctx).text, "[home hidden]\\Desktop\\a.txt");
  assert.equal(redactLeaks("c:/users/dana/Desktop", ctx).text, "[home hidden]/Desktop");
  assert.equal(redactLeaks("D:\\DANA\\work", ctx).text, "D:\\[user hidden]\\work");
  assert.equal(redactLeaks("C:\\Users\\Public\\x", ctx).text, "C:\\Users\\Public\\x");
});

test("paths on this computer's own platform", () => {
  const win = process.platform === "win32";
  const home = win ? "C:\\Users\\Kesher Tester" : "/home/kestester";
  const ctx = { username: win ? "Kesher Tester" : "kestester", home };
  assert.equal(redactLeaks(`${home}${win ? "\\" : "/"}file.txt`, ctx).text, `[home hidden]${win ? "\\" : "/"}file.txt`);
});

test("the never-send list: words in any language, files and folders", () => {
  const ctx = { neverSend: ["Project Falcon", "salary.xlsx", "secret-plans/", "מבצע"] };
  assert.equal(redactLeaks("about project falcon and salary.xlsx", ctx).text, "about [hidden] and [hidden]");
  assert.equal(redactLeaks("read secret-plans\\a.md", ctx).text, "read [hidden]a.md");
  assert.equal(redactLeaks("ה-מבצע מחר", ctx).text, "ה-[hidden] מחר");
  assert.deepEqual(kinds("falconry", { neverSend: ["falcon"] }), [], "whole words only");
});

test("summary, placeholders and modes", () => {
  const r = redactLeaks(`${gh} and ${aws} and a@b.co`);
  assert.deepEqual(leakSummary(r.hits), [{ kind: "key", count: 2 }, { kind: "email", count: 1 }]);
  assert.equal(countPlaceholders(r.text), 3);
  assert.equal(countPlaceholders("const a = [1, 2];"), 0);
  assert.equal(privacyModeOf("auto-hide"), "auto-hide");
  assert.equal(privacyModeOf("off"), "ask");
});

test("training risk: one table for chat, presets and the inbox", () => {
  assert.equal(trainingRiskOf("nvidia-nim/meta/llama-3.3-70b-instruct"), "yes");
  assert.equal(trainingRiskOf("opencode-go/big-pickle-contributor-free"), "yes");
  assert.equal(trainingRiskOf("opencode-go/kimi-k2"), undefined);
  assert.equal(trainingRiskOf("gemini/gemini-2.5-flash"), "may");
  assert.equal(trainingRiskOf("mistral/devstral-small-latest"), "may");
  assert.equal(trainingRiskOf("openrouter/qwen/qwen3-coder:free"), "may");
  assert.equal(trainingRiskOf("openrouter/openrouter/free"), "may");
  assert.equal(trainingRiskOf("openrouter/anthropic/claude-sonnet-4"), undefined);
  assert.equal(trainingRiskOf("llamacpp/Qwen3.6-27B"), undefined);
  assert.equal(connectionTrainingRisk("openrouter"), "some");
  assert.equal(connectionTrainingRisk("gemini"), "may");
  assert.equal(connectionTrainingRisk("ollama"), undefined);
  for (const p of FREE_PROVIDERS) assert.equal(p.trainsOnData, freeTierTrains(p.id), p.id);
});
