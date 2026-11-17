/**
 * A shared focus room (design StudyTogether, RESEARCH_LOG "Students, part 28" #5, like Focusmate, StudyStream and
 * Forest's "plant together"): she opens a room with a focus/break rhythm; friends open its link on any device, write
 * a name and what they are working on, and everyone sees the same timer and who is studying now. In memory only, for
 * twelve hours at most; the link's token is the only key; nothing is recorded or kept.
 */
import { randomBytes } from "node:crypto";

interface Member {
  name: string;
  task: string;
  seen: number;
}

/** A room. */
export interface FocusRoom {
  token: string;
  title: string;
  /** Focus and break lengths (minutes). */
  focus: number;
  rest: number;
  /** When the current run of focus/break cycles began; undefined while paused. */
  start?: number;
  /** Seconds into the cycle when it was paused (resumes from there). */
  pausedAt: number;
  members: Map<string, Member>;
  createdAt: number;
}

const MAX_ROOMS = 5;
const MAX_MEMBERS = 40;
const LIFE = 12 * 60 * 60_000;
/** A member counts as here while her page asked within this. */
const HERE = 25_000;
const rooms = new Map<string, FocusRoom>();

const clean = (now: number) => {
  for (const [k, r] of rooms) if (now - r.createdAt > LIFE) rooms.delete(k);
};
const text = (s: unknown, n: number) => [...String(s ?? "")].filter((c) => c >= " " && c !== "<" && c !== ">").join("").replace(/\s+/g, " ").trim().slice(0, n);

/** A new room (focus 5–120 minutes, break 1–60), paused at its start. */
export function createFocusRoom(title: string, focus = 25, rest = 5, now = Date.now()): FocusRoom {
  clean(now);
  while (rooms.size >= MAX_ROOMS) rooms.delete(rooms.keys().next().value!);
  const r: FocusRoom = { token: randomBytes(9).toString("base64url"), title: text(title, 80) || "Study together", focus: Math.max(5, Math.min(120, Math.round(focus) || 25)), rest: Math.max(1, Math.min(60, Math.round(rest) || 5)), pausedAt: 0, members: new Map(), createdAt: now };
  rooms.set(r.token, r);
  return r;
}

/** A room, or undefined (gone or expired). */
export function getFocusRoom(token: string, now = Date.now()): FocusRoom | undefined {
  clean(now);
  return /^[\w-]{8,40}$/.test(token) ? rooms.get(token) : undefined;
}

/** Ends a room. */
export function closeFocusRoom(token: string): void {
  rooms.delete(token);
}

/** Seconds into the focus/break cycle now. */
const into = (r: FocusRoom, now: number) => (r.start === undefined ? r.pausedAt : (r.pausedAt + Math.floor((now - r.start) / 1000)) % ((r.focus + r.rest) * 60));

/** Starts or pauses the shared timer; `reset` goes back to the start of a focus block. */
export function setTimer(r: FocusRoom, run: boolean, reset = false, now = Date.now()): FocusRoom {
  const at = reset ? 0 : into(r, now);
  r.pausedAt = at;
  if (run) r.start = now;
  else delete r.start;
  return r;
}

/** A friend joins (a name, and what she is working on); returns her member id. */
export function joinFocus(r: FocusRoom, name: string, task: string, now = Date.now()): string {
  const n = text(name, 24);
  if (!n) throw Object.assign(new Error("Type a name."), { statusCode: 400 });
  for (const [k, m] of r.members) if (now - m.seen > LIFE / 2) r.members.delete(k);
  if (r.members.size >= MAX_MEMBERS) throw Object.assign(new Error("The room is full."), { statusCode: 409 });
  const id = randomBytes(9).toString("base64url");
  r.members.set(id, { name: n, task: text(task, 80), seen: now });
  return id;
}

/** What every page shows: the timer, and who is here with what (a member's own call also marks her here). */
export function focusView(r: FocusRoom, mid?: string, task?: string, now = Date.now()) {
  const m = mid ? r.members.get(mid) : undefined;
  if (m) {
    m.seen = now;
    if (typeof task === "string") m.task = text(task, 80);
  }
  const t = into(r, now);
  const focusing = t < r.focus * 60;
  return {
    title: r.title,
    running: r.start !== undefined,
    phase: focusing ? "focus" : "break",
    left: focusing ? r.focus * 60 - t : (r.focus + r.rest) * 60 - t,
    focus: r.focus,
    rest: r.rest,
    here: [...r.members.values()].filter((x) => now - x.seen < HERE).map((x) => ({ name: x.name, task: x.task })),
    ...(m ? { me: m.name } : {}),
  };
}

/** The page friends open: small, its own script only. */
export function focusPage(token: string, nonce: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>לומדים יחד · KesherAI</title>
<style>body{margin:0;font:17px system-ui,Arial,sans-serif;background:#121213;color:#eee;display:flex;justify-content:center}main{width:min(560px,100%);padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}h1{font-size:20px;margin:0}p{margin:0}button,input{font:inherit;border-radius:12px;border:1px solid #333;padding:12px;background:#1e1f24;color:inherit}.primary{background:#a5b4ff;color:#111;border:0;font-weight:700}.muted{color:#9a9caa;font-size:14px}.clock{font-size:64px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;direction:ltr}.phase{text-align:center}.brk{color:#7fd6a8}ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}li{padding:8px 10px;border:1px solid #2a2a30;border-radius:10px}</style></head>
<body><main id="m"><p class="muted">…</p></main>
<script nonce="${nonce}">
const T=${JSON.stringify(token)};const m=document.getElementById("m");let mid=sessionStorage.getItem("fr-"+T)||"";let s=null;let got=0;let built=false;
const esc=(x)=>String(x).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const mmss=(n)=>{n=Math.max(0,Math.round(n));return Math.floor(n/60)+":"+String(n%60).padStart(2,"0");};
function joinForm(){m.innerHTML='<h1>'+esc(s.title)+'</h1><p class="muted">'+s.here.length+' לומדים עכשיו</p><input id="n" maxlength="24" placeholder="השם שלך" dir="auto"><input id="t" maxlength="80" placeholder="על מה את/ה עובד/ת (לא חובה)" dir="auto"><button class="primary" id="j">להיכנס לחדר</button>';
document.getElementById("j").onclick=async()=>{const n=document.getElementById("n").value.trim();if(!n)return;const r=await (await fetch("/f/"+T+"/join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:n,task:document.getElementById("t").value})})).json();if(r.id){mid=r.id;sessionStorage.setItem("fr-"+T,mid);pull();}else alert(r.error||"");};}
function draw(){if(!s)return;if(!mid){if(!built){built=true;joinForm();}return;}
const left=s.running?s.left-(Date.now()-got)/1000:s.left;
m.innerHTML='<h1>'+esc(s.title)+'</h1><p class="phase '+(s.phase==="break"?"brk":"")+'">'+(s.phase==="focus"?"⏳ זמן ריכוז":"☕ הפסקה")+(s.running?"":" · מושהה")+'</p><div class="clock">'+mmss(left)+'</div><p class="muted">'+s.focus+' דקות ריכוז, '+s.rest+' דקות הפסקה</p><b>לומדים עכשיו ('+s.here.length+')</b><ul>'+s.here.map((h)=>'<li dir="auto"><b>'+esc(h.name)+'</b>'+(h.task?' · <span class="muted">'+esc(h.task)+'</span>':'')+'</li>').join("")+'</ul>';}
async function pull(){try{const r=await fetch("/f/"+T+"/state"+(mid?"?mid="+encodeURIComponent(mid):""));if(!r.ok){m.innerHTML='<h1>החדר נסגר או לא קיים</h1>';s=null;return;}s=await r.json();got=Date.now();if(mid&&!s.me){mid="";sessionStorage.removeItem("fr-"+T);built=false;}draw();}catch{}}
pull();setInterval(pull,5000);setInterval(draw,1000);
</script></body></html>`;
}
