/**
 * A live quiz with classmates (design LiveQuiz, RESEARCH_LOG "Students, part 28" #4, like Kahoot and Quizizz): she
 * hosts a quiz from her course; friends open a link (or a QR) on their phones, with no app and no account, type a
 * name and answer each question against the clock; a faster right answer scores more; a scoreboard after each one.
 * Rooms live in memory only, for three hours at most; the link's token is the only key.
 */
import { randomBytes } from "node:crypto";
import type { StudyQuestion } from "@kesher/shared";

/** A room's stage. */
export type LiveStage = "lobby" | "question" | "reveal" | "end";

interface Player {
  name: string;
  score: number;
  /** The answer to each question, and when it came (ms after it opened). */
  answers: Array<{ choice: number; ms: number } | undefined>;
}

/** A room. */
export interface LiveRoom {
  token: string;
  title: string;
  questions: StudyQuestion[];
  stage: LiveStage;
  /** The question showing (or just shown). */
  qi: number;
  /** When the question opened (ms). */
  openedAt: number;
  /** Seconds to answer. */
  seconds: number;
  players: Map<string, Player>;
  createdAt: number;
}

const MAX_ROOMS = 5;
const MAX_PLAYERS = 60;
const LIFE = 3 * 60 * 60_000;
const rooms = new Map<string, LiveRoom>();

const clean = (now: number) => {
  for (const [k, r] of rooms) if (now - r.createdAt > LIFE) rooms.delete(k);
};

/** A new room for these questions (multiple choice only). */
export function createRoom(title: string, questions: StudyQuestion[], seconds = 20, now = Date.now()): LiveRoom {
  clean(now);
  const qs = questions.filter((q) => q.options.length >= 2 && q.answer >= 0).slice(0, 40);
  if (!qs.length) throw Object.assign(new Error("No multiple-choice questions for a live quiz."), { statusCode: 400 });
  while (rooms.size >= MAX_ROOMS) rooms.delete(rooms.keys().next().value!);
  const token = randomBytes(9).toString("base64url");
  const room: LiveRoom = { token, title: title.slice(0, 120), questions: qs, stage: "lobby", qi: 0, openedAt: 0, seconds: Math.max(5, Math.min(120, Math.round(seconds))), players: new Map(), createdAt: now };
  rooms.set(token, room);
  return room;
}

/** A room, or undefined (gone or expired). */
export function getRoom(token: string, now = Date.now()): LiveRoom | undefined {
  clean(now);
  return /^[\w-]{8,40}$/.test(token) ? rooms.get(token) : undefined;
}

/** Ends a room. */
export function closeRoom(token: string): void {
  rooms.delete(token);
}

/** The host moves on: lobby → first question → its answer → next question … → the end. */
export function advance(r: LiveRoom, now = Date.now()): LiveRoom {
  if (r.stage === "lobby") Object.assign(r, { stage: "question", qi: 0, openedAt: now });
  else if (r.stage === "question") r.stage = "reveal";
  else if (r.stage === "reveal") {
    if (r.qi + 1 >= r.questions.length) r.stage = "end";
    else Object.assign(r, { stage: "question", qi: r.qi + 1, openedAt: now });
  }
  return r;
}

/** A friend joins with a name (trimmed, at most 24 letters); returns her player id. */
export function join(r: LiveRoom, name: string): string {
  const n = [...name].filter((c) => c >= " " && c !== "<" && c !== ">").join("").trim().slice(0, 24);
  if (!n) throw Object.assign(new Error("Type a name."), { statusCode: 400 });
  if (r.players.size >= MAX_PLAYERS) throw Object.assign(new Error("The room is full."), { statusCode: 409 });
  const pid = randomBytes(9).toString("base64url");
  r.players.set(pid, { name: n, score: 0, answers: [] });
  return pid;
}

/**
 * An answer to the question showing: once per question, in time; a right one scores 500–1000 (faster is more).
 *
 * @returns Whether it counted.
 */
export function answer(r: LiveRoom, pid: string, qi: number, choice: number, now = Date.now()): boolean {
  const p = r.players.get(pid);
  const q = r.questions[qi];
  if (!p || !q || r.stage !== "question" || qi !== r.qi || p.answers[qi] || !Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return false;
  const ms = now - r.openedAt;
  if (ms > r.seconds * 1000 + 1500) return false;
  p.answers[qi] = { choice, ms };
  if (choice === q.answer) p.score += Math.round(1000 - 500 * Math.min(1, ms / (r.seconds * 1000)));
  return true;
}

/** The scoreboard, best first. */
export function board(r: LiveRoom): Array<{ name: string; score: number }> {
  return [...r.players.values()].map((p) => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
}

/**
 * What a player's phone sees: the stage, the question without its answer until it is revealed, the time left, her
 * own score and answer, and the scoreboard after each question.
 */
export function playerView(r: LiveRoom, pid: string | undefined, now = Date.now()) {
  const q = r.questions[r.qi];
  const p = pid ? r.players.get(pid) : undefined;
  const mine = p?.answers[r.qi];
  return {
    title: r.title,
    stage: r.stage,
    qi: r.qi,
    count: r.questions.length,
    ...(r.stage === "question" || r.stage === "reveal" ? { q: q!.q, options: q!.options } : {}),
    ...(r.stage === "question" ? { left: Math.max(0, Math.ceil(r.seconds - (now - r.openedAt) / 1000)) } : {}),
    ...(r.stage === "reveal" ? { answer: q!.answer, explain: q!.explain } : {}),
    ...(p ? { me: { name: p.name, score: p.score, ...(mine ? { picked: mine.choice } : {}) } } : {}),
    ...(r.stage === "reveal" || r.stage === "end" ? { board: board(r).slice(0, 10) } : {}),
    players: r.players.size,
  };
}

/** What the host sees: as a player sees, plus how many answered and every name. */
export function hostView(r: LiveRoom, now = Date.now()) {
  return { ...playerView(r, undefined, now), answered: [...r.players.values()].filter((p) => p.answers[r.qi]).length, names: [...r.players.values()].map((p) => p.name), board: board(r).slice(0, 20) };
}

/** The page friends open (no app, no account): small, its own script only. */
export function livePage(token: string, nonce: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>בוחן חי · KesherAI</title>
<style>body{margin:0;font:17px system-ui,Arial,sans-serif;background:#121213;color:#eee;display:flex;justify-content:center}main{width:min(560px,100%);padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}h1{font-size:20px;margin:0}p{margin:0}button,input{font:inherit;border-radius:12px;border:1px solid #333;padding:12px;background:#1e1f24;color:inherit}button{cursor:pointer}.opt{text-align:start;width:100%}.opt.right{border-color:#2e9e6a;background:#2e9e6a33}.opt.wrong{border-color:#c0392b;background:#c0392b33}.opt.mine{outline:2px solid #a5b4ff}.muted{color:#9a9caa;font-size:14px}.big{font-size:44px;font-weight:800}.row{display:flex;gap:8px;align-items:center}ol{margin:0;padding-inline-start:20px;line-height:1.8}.primary{background:#a5b4ff;color:#111;border:0;font-weight:700}</style></head>
<body><main id="m"><p class="muted">…</p></main>
<script nonce="${nonce}">
const T=${JSON.stringify(token)};const m=document.getElementById("m");let pid=sessionStorage.getItem("lq-"+T)||"";let last="";
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function tick(){let s;try{s=await (await fetch("/q/"+T+"/state"+(pid?"?pid="+pid:""))).json();}catch{return;}
if(s.error){m.innerHTML='<h1>הבוחן הסתיים או לא קיים</h1>';return;}
const key=JSON.stringify([s.stage,s.qi,s.left,s.me&&s.me.picked,s.players,!pid]);if(key===last)return;last=key;
let h='<h1>'+esc(s.title)+'</h1>';
if(!pid){h+='<p class="muted">'+s.players+' משתתפים</p><input id="n" maxlength="24" placeholder="השם שלך" dir="auto"><button class="primary" id="j">להצטרף</button>';m.innerHTML=h;document.getElementById("j").onclick=async()=>{const n=document.getElementById("n").value.trim();if(!n)return;const r=await (await fetch("/q/"+T+"/join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:n})})).json();if(r.pid){pid=r.pid;sessionStorage.setItem("lq-"+T,pid);last="";tick();}else alert(r.error||"");};return;}
h+='<p class="muted">'+esc(s.me?s.me.name:"")+' · '+(s.me?s.me.score:0)+' נקודות</p>';
if(s.stage==="lobby")h+='<p>מחכים שהבוחן יתחיל… ('+s.players+' משתתפים)</p>';
if(s.stage==="question"||s.stage==="reveal"){h+='<p class="muted">שאלה '+(s.qi+1)+' מתוך '+s.count+(s.stage==="question"?' · <b>'+s.left+'</b> שניות':'')+'</p><b dir="auto">'+esc(s.q)+'</b>';
s.options.forEach((o,i)=>{let c="opt";if(s.stage==="reveal"){if(i===s.answer)c+=" right";else if(s.me&&s.me.picked===i)c+=" wrong";}if(s.me&&s.me.picked===i)c+=" mine";h+='<button class="'+c+'" data-i="'+i+'" dir="auto" '+((s.stage!=="question"||(s.me&&s.me.picked!==undefined)||!s.left)?"disabled":"")+'>'+esc(o)+'</button>';});
if(s.stage==="reveal"&&s.explain)h+='<p class="muted" dir="auto">'+esc(s.explain)+'</p>';}
if(s.board&&s.board.length)h+='<b>'+(s.stage==="end"?'התוצאה הסופית':'הטבלה')+'</b><ol>'+s.board.map((b)=>'<li dir="auto">'+esc(b.name)+' · '+b.score+'</li>').join("")+'</ol>';
m.innerHTML=h;m.querySelectorAll("button[data-i]").forEach((b)=>b.onclick=async()=>{await fetch("/q/"+T+"/answer",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pid,qi:s.qi,choice:Number(b.dataset.i)})});last="";tick();});}
tick();setInterval(tick,1000);
</script></body></html>`;
}
