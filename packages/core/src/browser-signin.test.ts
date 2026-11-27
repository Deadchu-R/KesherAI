import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSignIn, handOverMessage, pageUrlOf, resolveSignIn, SecretFieldError, secretFieldKind, watchLeave, type SignInDeps } from "./browser-signin.js";

/** Snapshots as browser_snapshot gives them (title, address, tree). */
const LOGIN = `Sign in - Mail\nhttps://accounts.example.com/signin?next=%2F\n\n- heading "Sign in"\n- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Next" [ref=e3]`;
const TWO_STEP = `2-Step Verification\nhttps://accounts.example.com/challenge/totp\n\n- heading "2-Step Verification"\n- text: Enter the code from your authenticator app\n- textbox "Enter code" [ref=e1]\n- button "Next" [ref=e2]`;
const CAPTCHA = `Just a moment...\nhttps://shop.example.com/\n\n- heading "shop.example.com"\n- text: Verify you are human by completing the action below.\n- Iframe "Widget containing a Cloudflare security challenge"`;
const NORMAL = `Mail\nhttps://mail.example.com/inbox\n\n- link "Sign in" [ref=e1]\n- heading "Inbox"\n- textbox "Search mail" [ref=e2]\n- Iframe "reCAPTCHA"`;
const HEBREW = `כניסה\nhttps://bank.example.co.il/login\n\n- textbox "שם משתמש" [ref=e1]\n- textbox "סיסמה" [ref=e2]`;

test("sign-in: finds password, two-step and robot-check pages, not a normal page with a Sign in link", () => {
  assert.equal(detectSignIn({ text: LOGIN }), "login");
  assert.equal(detectSignIn({ text: HEBREW }), "login");
  assert.equal(detectSignIn({ text: TWO_STEP }), "code");
  assert.equal(detectSignIn({ text: CAPTCHA }), "captcha");
  // A "Sign in" link and reCAPTCHA v3's corner badge are on many normal pages.
  assert.equal(detectSignIn({ text: NORMAL }), undefined);
  // The DOM probe (CDP) finds what the tree does not name.
  assert.equal(detectSignIn({ text: NORMAL, markers: { password: true, otp: false, captcha: false } }), "login");
  assert.equal(detectSignIn({ text: NORMAL, markers: { password: false, otp: true, captcha: false } }), "code");
  assert.equal(detectSignIn({ text: LOGIN, markers: { password: true, otp: false, captcha: true } }), "captcha");
  assert.equal(detectSignIn({ text: NORMAL, markers: { password: false, otp: false, captcha: false } }), undefined);
});

test("sign-in: password and code fields are refused by their label; other fields are not", () => {
  assert.equal(secretFieldKind('textbox "Password" (ref e2)'), "login");
  assert.equal(secretFieldKind('textbox "סיסמה" (ref e2)'), "login");
  assert.equal(secretFieldKind('textbox "Enter code" (ref e1)'), "code");
  assert.equal(secretFieldKind('textbox "Email" (ref e1)'), undefined);
  assert.equal(secretFieldKind("element 4"), undefined);
  assert.equal(secretFieldKind(undefined), undefined);
  assert.match(new SecretFieldError("login").message, /never types passwords/);
});

test("sign-in: the page's address is the second line of a read", () => {
  assert.equal(pageUrlOf(LOGIN), "https://accounts.example.com/signin?next=%2F");
  assert.equal(pageUrlOf("Scrolled."), undefined);
});

/** Deps with a scripted card and pages read again in order. */
function deps(answers: string[], rereads: string[], o: Partial<SignInDeps> = {}) {
  const cards: { question: string; info: unknown }[] = [];
  const d: SignInDeps = {
    markers: async () => undefined,
    reread: async () => rereads.shift() ?? NORMAL,
    url: async () => "https://accounts.example.com/signin",
    handOver: async (question, info) => (cards.push({ question, info }), answers.shift() ?? "cancel"),
    browser: "pane",
    ...o,
  };
  return { d, cards };
}

test("sign-in: a normal page passes through untouched, without a card", async () => {
  const { d, cards } = deps([], []);
  assert.equal(await resolveSignIn(NORMAL, d), NORMAL);
  assert.equal(cards.length, 0);
});

test("sign-in: Continue reads the page again; a code page after the password shows the card again", async () => {
  const { d, cards } = deps(["continue", "continue:auto"], [TWO_STEP, NORMAL]);
  const out = await resolveSignIn(LOGIN, d);
  assert.deepEqual(cards.map((c) => c.info), [
    { wall: "login", site: "accounts.example.com", browser: "pane" },
    { wall: "code", site: "accounts.example.com", browser: "pane" },
  ]);
  assert.match(cards[0]!.question, /Sign in to accounts\.example\.com on the PC/);
  assert.match(out, /^The user finished signing in; the page now:\nMail/);
});

test("sign-in: Cancel, a time-out and no one to ask each tell the model to hand over, never to type", async () => {
  assert.match(await resolveSignIn(LOGIN, deps(["cancel"], []).d), /chose not to sign in now/);
  assert.match(await resolveSignIn(CAPTCHA, deps(["(timed out)"], []).d), /robot check[\s\S]*within 10 minutes/);
  const none = await resolveSignIn(LOGIN, deps([], [], { handOver: undefined }).d);
  assert.ok(none.startsWith(LOGIN));
  assert.match(none, /SIGN-IN NEEDED: accounts\.example\.com[\s\S]*Never type a password/);
  // The page still asks after three cards: stop and ask the user.
  const still = await resolveSignIn(LOGIN, deps(["continue", "continue", "continue"], [LOGIN, LOGIN, LOGIN]).d);
  assert.match(still, /still asks/);
});

test("sign-in: browser_type's refusal (forced) shows the card for that field, with the site from the tab", async () => {
  const { d, cards } = deps(["cancel"], []);
  const out = await resolveSignIn(new SecretFieldError("code").message, { ...d, browser: "chrome" }, "code");
  assert.deepEqual(cards[0]!.info, { wall: "code", site: "accounts.example.com", browser: "chrome" });
  assert.equal(out, handOverMessage("code", "accounts.example.com", "chrome", "cancel"));
});

test("sign-in: the watch continues by itself when the tab leaves the sign-in page, and ends when the card is answered", async () => {
  const urls = ["https://accounts.example.com/signin?x=1", "https://accounts.example.com/signin#a", "https://mail.example.com/inbox"];
  assert.equal(await watchLeave(async () => urls.shift(), "https://accounts.example.com/signin", new AbortController().signal, 1), true);
  assert.equal(urls.length, 0);
  const stop = new AbortController();
  const w = watchLeave(async () => "https://accounts.example.com/signin", "https://accounts.example.com/signin", stop.signal, 1);
  setTimeout(() => stop.abort(), 10);
  assert.equal(await w, false);
});
