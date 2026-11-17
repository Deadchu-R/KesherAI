import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { Study } from "../study.js";
import { closeFocusRoom, createFocusRoom, focusPage, focusView, getFocusRoom, joinFocus, setTimer } from "../focus-room.js";
import { advance, answer, closeRoom, createRoom, getRoom, hostView, join, livePage, playerView } from "../live-quiz.js";

/** A friends' page's headers: its own script only, never framed, not indexed, not kept. */
const headers = (nonce: string) => ({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

/**
 * The live quiz (design LiveQuiz): the host's routes under /api (her app key), and the friends' page and its calls at
 * /q/<token> (outside /api: the token is the key, as share links).
 *
 * @param app - Fastify instance.
 * @param st - Study (the course's questions).
 */
export async function liveQuizRoutes(app: FastifyInstance, st: Study): Promise<void> {
  app.post<{ Params: { id: string }; Body: { count?: number; seconds?: number; lectureIds?: string[] } }>("/api/study/courses/:id/live", async (req) => {
    const b = req.body ?? {};
    const course = (await st.get(req.params.id)).course;
    const quiz = await st.makeQuiz(req.params.id, { count: Math.max(3, Math.min(20, Number(b.count) || 10)), level: "normal", ...(Array.isArray(b.lectureIds) ? { lectureIds: b.lectureIds.map(String).slice(0, 50) } : {}) });
    const r = createRoom(course.name, quiz.questions, Number(b.seconds) || 20);
    return { token: r.token, path: `/q/${r.token}` };
  });
  app.get<{ Params: { token: string } }>("/api/live/:token", async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? hostView(r) : reply.code(404).send({ error: "This live quiz is over." });
  });
  app.post<{ Params: { token: string } }>("/api/live/:token/next", async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? hostView(advance(r)) : reply.code(404).send({ error: "This live quiz is over." });
  });
  app.delete<{ Params: { token: string } }>("/api/live/:token", async (req) => {
    closeRoom(req.params.token);
    return { ok: true };
  });

  // The friends' side.
  app.get<{ Params: { token: string } }>("/q/:token", async (req, reply) => {
    if (!getRoom(req.params.token)) return reply.code(404).type("text/plain; charset=utf-8").send("This live quiz is over.");
    const nonce = randomBytes(12).toString("base64");
    return reply.headers(headers(nonce)).send(livePage(req.params.token, nonce));
  });
  app.get<{ Params: { token: string }; Querystring: { pid?: string } }>("/q/:token/state", async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? reply.header("cache-control", "no-store").send(playerView(r, typeof req.query.pid === "string" ? req.query.pid : undefined)) : reply.code(404).send({ error: "over" });
  });
  app.post<{ Params: { token: string }; Body: { name?: string } }>("/q/:token/join", { bodyLimit: 2048 }, async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? { pid: join(r, String(req.body?.name ?? "")) } : reply.code(404).send({ error: "over" });
  });
  app.post<{ Params: { token: string }; Body: { pid?: string; qi?: number; choice?: number } }>("/q/:token/answer", { bodyLimit: 2048 }, async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? { ok: answer(r, String(req.body?.pid ?? ""), Number(req.body?.qi), Number(req.body?.choice)) } : reply.code(404).send({ error: "over" });
  });
}

/**
 * The shared focus room (design StudyTogether): her controls under /api (her app key), and the friends' page and its
 * calls at /f/<token> (the token is the key).
 *
 * @param app - Fastify instance.
 */
export async function focusRoomRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { title?: string; focus?: number; rest?: number } }>("/api/study/focus-room", async (req) => {
    const r = createFocusRoom(String(req.body?.title ?? ""), Number(req.body?.focus) || 25, Number(req.body?.rest) || 5);
    return { token: r.token, path: `/f/${r.token}` };
  });
  app.get<{ Params: { token: string } }>("/api/focus/:token", async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? focusView(r) : reply.code(404).send({ error: "This room is closed." });
  });
  app.post<{ Params: { token: string }; Body: { run?: boolean; reset?: boolean } }>("/api/focus/:token/timer", async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? focusView(setTimer(r, req.body?.run === true, req.body?.reset === true)) : reply.code(404).send({ error: "This room is closed." });
  });
  app.delete<{ Params: { token: string } }>("/api/focus/:token", async (req) => {
    closeFocusRoom(req.params.token);
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>("/f/:token", async (req, reply) => {
    if (!getFocusRoom(req.params.token)) return reply.code(404).type("text/plain; charset=utf-8").send("This room is closed.");
    const nonce = randomBytes(12).toString("base64");
    return reply.headers(headers(nonce)).send(focusPage(req.params.token, nonce));
  });
  app.get<{ Params: { token: string }; Querystring: { mid?: string } }>("/f/:token/state", async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? reply.header("cache-control", "no-store").send(focusView(r, typeof req.query.mid === "string" ? req.query.mid : undefined)) : reply.code(404).send({ error: "closed" });
  });
  app.post<{ Params: { token: string }; Body: { name?: string; task?: string } }>("/f/:token/join", { bodyLimit: 2048 }, async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? { id: joinFocus(r, String(req.body?.name ?? ""), String(req.body?.task ?? "")) } : reply.code(404).send({ error: "closed" });
  });
}

/** The page teammates open for a group project board (design GroupProject): its own script only, no account. */
function projectPage(token: string, nonce: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>עבודה קבוצתית · KesherAI</title>
<style>body{margin:0;font:16px system-ui,Arial,sans-serif;background:#121213;color:#eee;display:flex;justify-content:center}main{width:min(640px,100%);padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}h1{font-size:20px;margin:0}p{margin:0}button,input{font:inherit;border-radius:10px;border:1px solid #333;padding:9px 12px;background:#1e1f24;color:inherit}.primary{background:#a5b4ff;color:#111;border:0;font-weight:700}.muted{color:#9a9caa;font-size:14px}ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}li{padding:10px;border:1px solid #2a2a30;border-radius:12px;display:flex;flex-direction:column;gap:6px}li.done b{text-decoration:line-through;color:#9a9caa}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input{flex:1;min-width:0}</style></head>
<body><main id="m"><p class="muted">…</p></main>
<script nonce="${nonce}">
const T=${JSON.stringify(token)};const m=document.getElementById("m");let me=localStorage.getItem("gp-name")||"";
const esc=(x)=>String(x).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function send(b){const r=await fetch("/g/"+T+"/task",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});const j=await r.json();if(j.error)alert(j.error);else draw(j);}
function draw(s){if(!s||s.error){m.innerHTML='<h1>הלוח לא משותף יותר</h1>';return;}
let h='<h1>'+esc(s.title||s.course)+'</h1><p class="muted">'+esc(s.course)+' · '+s.tasks.filter(t=>t.done).length+' מתוך '+s.tasks.length+' בוצעו</p>';
h+='<div class="row"><input id="me" maxlength="40" placeholder="השם שלך" dir="auto" value="'+esc(me)+'"></div><ul>';
for(const t of s.tasks){h+='<li class="'+(t.done?'done':'')+'"><b dir="auto">'+esc(t.text)+'</b><span class="muted">'+(t.who?'👤 '+esc(t.who):'אף אחד עוד לא לקח')+(t.due?' · עד '+esc(t.due.split("-").reverse().join("."))+'':'')+'</span><div class="row"><button data-a="claim" data-id="'+esc(t.id)+'">'+(t.who&&t.who===me?'לשחרר':'אני לוקח/ת')+'</button><button data-a="done" data-id="'+esc(t.id)+'">'+(t.done?'לבטל ✓':'✓ בוצע')+'</button></div></li>';}
h+='</ul><div class="row"><input id="nt" maxlength="300" placeholder="משימה חדשה" dir="auto"><button class="primary" id="add">להוסיף</button></div>';
m.innerHTML=h;
document.getElementById("me").onchange=(e)=>{me=e.target.value.trim();localStorage.setItem("gp-name",me);};
document.getElementById("add").onclick=()=>{const v=document.getElementById("nt").value.trim();if(v)send({action:"add",text:v,who:me});};
m.querySelectorAll("button[data-a]").forEach((b)=>b.onclick=()=>{const a=b.dataset.a;const t=s.tasks.find(x=>x.id===b.dataset.id);if(a==="claim")send({action:"claim",id:b.dataset.id,who:t&&t.who===me?"":me});else send({action:"done",id:b.dataset.id});});}
async function pull(){try{const r=await fetch("/g/"+T+"/state");draw(r.ok?await r.json():null);}catch{}}
pull();setInterval(()=>{if(!document.activeElement||document.activeElement.tagName!=="INPUT")pull();},10000);
</script></body></html>`;
}

/**
 * The group project board (design GroupProject): her routes under /api, and the teammates' page and calls at
 * /g/<token> (the key is the token; it ends when she stops sharing).
 *
 * @param app - Fastify instance.
 * @param st - Study.
 */
export async function projectRoutes(app: FastifyInstance, st: Study): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/study/courses/:id/project", async (req) => ({ project: await st.project(req.params.id) }));
  app.put<{ Params: { id: string }; Body: unknown }>("/api/study/courses/:id/project", { bodyLimit: 128 * 1024 }, async (req) => ({ project: await st.saveProject(req.params.id, req.body) }));
  app.post<{ Params: { id: string }; Body: { on?: boolean } }>("/api/study/courses/:id/project/share", async (req) => ({ project: await st.shareProject(req.params.id, req.body?.on !== false) }));

  const view = (f: { course: string; project: { title: string; tasks: unknown[] } }) => ({ course: f.course, title: f.project.title, tasks: f.project.tasks });
  app.get<{ Params: { token: string } }>("/g/:token", async (req, reply) => {
    if (!(await st.projectByToken(req.params.token))) return reply.code(404).type("text/plain; charset=utf-8").send("This board is not shared.");
    const nonce = randomBytes(12).toString("base64");
    return reply.headers(headers(nonce)).send(projectPage(req.params.token, nonce));
  });
  app.get<{ Params: { token: string } }>("/g/:token/state", async (req, reply) => {
    const f = await st.projectByToken(req.params.token);
    return f ? reply.header("cache-control", "no-store").send(view(f)) : reply.code(404).send({ error: "not shared" });
  });
  app.post<{ Params: { token: string }; Body: { action?: string; id?: string; text?: string; who?: string } }>("/g/:token/task", { bodyLimit: 4096 }, async (req) => {
    const b = req.body ?? {};
    const p = await st.projectTeamChange(req.params.token, { action: String(b.action ?? ""), ...(typeof b.id === "string" ? { id: b.id } : {}), ...(typeof b.text === "string" ? { text: b.text } : {}), ...(typeof b.who === "string" ? { who: b.who } : {}) });
    const f = await st.projectByToken(req.params.token);
    return f ? view(f) : { course: "", title: p.title, tasks: p.tasks };
  });
}

/** The phone app's package (apps/android/capacitor.config.json). */
const APP_PACKAGE = "dev.kesherai.app";

/**
 * A plain https link that opens the phone app and connects to this computer (Roee, 2026-11-17: a kesherai:// link
 * is not tappable in most apps, and pasting a long link was "complicated"). The key is in the link's fragment
 * (/open#t=…), which the browser never sends anywhere: this page reads it and hands it to the app through an
 * Android intent; without the app it opens KesherAI in the browser instead.
 *
 * @param app - Fastify instance.
 */
export async function appLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get("/open", async (_req, reply) => {
    const nonce = randomBytes(12).toString("base64");
    return reply.headers(headers(nonce)).send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KesherAI</title>
<style>body{font-family:system-ui,sans-serif;background:#121213;color:#eee;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center;padding:16px}a{display:inline-block;margin:10px;padding:14px 20px;border-radius:14px;background:#a5b4ff;color:#121213;text-decoration:none;font-weight:700}p{color:#aaa}</style></head>
<body><main><h1>KesherAI</h1><p id="m">פותח את האפליקציה…</p><a id="app" href="#">פתיחה באפליקציה</a><br><a id="web" href="/" style="background:#2a2a2e;color:#eee">פתיחה בדפדפן</a></main>
<script nonce="${nonce}">
const t=new URLSearchParams(location.hash.slice(1)).get("t")||"";
if(!/^[\\w.~-]{8,200}$/.test(t)){document.getElementById("m").textContent="הקישור חסר את המפתח. סרקי את קוד ה-QR במחשב (הגדרות ← טלפון).";document.getElementById("app").hidden=true;document.getElementById("web").hidden=true;}
else{const server=location.origin+"/?token="+encodeURIComponent(t);history.replaceState(null,"",location.pathname);
const intent="intent://connect?server="+encodeURIComponent(server)+"#Intent;scheme=kesherai;package=${APP_PACKAGE};S.browser_fallback_url="+encodeURIComponent(server)+";end";
document.getElementById("app").href=/Android/i.test(navigator.userAgent)?intent:"kesherai://connect?server="+encodeURIComponent(server);
document.getElementById("web").href=server;
if(/Android/i.test(navigator.userAgent))location.href=intent;else document.getElementById("m").textContent="";}
</script></body></html>`);
  });
}
