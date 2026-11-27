/**
 * The Claude connector's MCP Apps views (the MCP UI extension, SEP-1865): small self-contained HTML pages that Claude
 * shows in a sandboxed frame beside a tool's answer. A tool names its view in `_meta.ui.resourceUri`; `resources/list`
 * and `resources/read` (mcp.ts) serve these. Each page talks to the host only by `postMessage` JSON-RPC:
 * `ui/initialize` (theme and locale) → `ui/notifications/initialized` → the host sends `ui/notifications/tool-result`
 * (the tool's `structuredContent`) → buttons call `tools/call` through the host (Run, Queue, Stop, Assign) → the page
 * reports its height with `ui/notifications/size-changed`.
 *
 * No external loads (no fonts, scripts or images), no `innerHTML` with data (every value goes in as text), Hebrew or
 * English by the host's locale (right-to-left for Hebrew), KesherAI's hub colours (dark, with a light variant), and a
 * layout that works 390 px wide. A host without MCP Apps never loads these; the tools' text answers stand alone.
 */

/** The MIME type of an MCP App view. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** The views' addresses. */
export const VIEW_URIS = { board: "ui://kesher/board", quotas: "ui://kesher/quotas", task: "ui://kesher/task", approvals: "ui://kesher/approvals" } as const;

/** Shared look: the hub page's palette (apps/hub/public/app.css), a light variant, chips, buttons and bars. */
const CSS = `
:root{--bg:#121213;--panel:#1a1a1d;--line:#2a2a2e;--text:#ededee;--mut:#9a9aa2;--acc:#a5b4ff;--ok:#7fd6a4;--bad:#ff8a8a;--warn:#f0b37e;
--c-run-bg:#262a45;--c-run:#c3cbff;--c-ok-bg:#1f2a24;--c-bad-bg:#3a2224;--c-off-bg:#26262a;--c-off:#a9a9b0;--c-wait-bg:#2a2520;--track:#2a2a2e}
:root.light{--bg:#ffffff;--panel:#f6f6f8;--line:#e2e2e8;--text:#1b1b1f;--mut:#62626b;--acc:#4f5bd5;--ok:#1f8a52;--bad:#c23b3b;--warn:#a65d12;
--c-run-bg:#e6e9ff;--c-run:#3340a8;--c-ok-bg:#e3f4ea;--c-bad-bg:#fbe5e5;--c-off-bg:#ececf0;--c-off:#55555e;--c-wait-bg:#fbefe1;--track:#e2e2e8}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{padding:12px;display:flex;flex-direction:column;gap:10px;max-width:960px}
h1{font-size:15px;margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}h1 small{color:var(--mut);font-weight:400;font-size:12.5px}
h2{font-size:12px;margin:6px 0 0;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.grow{flex:1 1 auto;min-width:0}
.title{font-weight:600;overflow-wrap:anywhere}.mut{color:var(--mut);font-size:12.5px}.bad{color:var(--bad)}.ok{color:var(--ok)}
.chip{display:inline-flex;align-items:center;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;white-space:nowrap}
.c-run{background:var(--c-run-bg);color:var(--c-run)}.c-ok{background:var(--c-ok-bg);color:var(--ok)}.c-bad{background:var(--c-bad-bg);color:var(--bad)}
.c-off{background:var(--c-off-bg);color:var(--c-off)}.c-wait{background:var(--c-wait-bg);color:var(--warn)}
button,select{font:inherit;font-size:13px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text);padding:5px 11px;min-height:32px;cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#111}button:disabled{opacity:.55;cursor:default}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.track{height:8px;border-radius:99px;background:var(--track);overflow:hidden;flex:1 1 120px;min-width:80px}.track>i{display:block;height:100%;background:var(--ok)}
.track.low>i{background:var(--warn)}.track.out>i{background:var(--bad)}.track.acc>i{background:var(--acc)}
.status{min-height:18px;font-size:12.5px;color:var(--mut)}
ol.steps{margin:0;padding-inline-start:20px;display:flex;flex-direction:column;gap:3px}ol.steps li{overflow-wrap:anywhere}
.empty{color:var(--mut);padding:8px 2px}
pre.pre{margin:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:9px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}
.note{background:var(--c-wait-bg);color:var(--warn);border-radius:9px;padding:6px 10px;font-size:12.5px}
button.danger{color:var(--bad)}
`;

/** The host bridge and helpers every view shares (plain ES2017, no template literals: this sits inside one). */
const BRIDGE = `
var LANG="en",nextId=1,waiting={},lastArgs={},PC="";
function T(he,en){return LANG==="he"?he:en}
function h(tag,attrs){var el=document.createElement(tag);attrs=attrs||{};for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;
 if(k==="text")el.textContent=String(v);else if(k==="on")el.addEventListener("click",v);else el.setAttribute(k,v===true?"":String(v));}
 for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null||c===false)continue;el.appendChild(typeof c==="string"?document.createTextNode(c):c);}return el}
function rpc(method,params){var id=nextId++;parent.postMessage({jsonrpc:"2.0",id:id,method:method,params:params||{}},"*");
 return new Promise(function(res,rej){waiting[id]={res:res,rej:rej};setTimeout(function(){if(waiting[id]){delete waiting[id];rej(new Error(T("אין תשובה","No answer")))}},20000)})}
function notify(method,params){parent.postMessage({jsonrpc:"2.0",method:method,params:params||{}},"*")}
function ctx(c){if(!c)return;if(c.locale){LANG=/^he/i.test(c.locale)?"he":"en";document.documentElement.lang=LANG;document.documentElement.dir=LANG==="he"?"rtl":"ltr"}
 if(c.theme)document.documentElement.className=c.theme==="light"?"light":""}
function callTool(name,args){return rpc("tools/call",{name:name,arguments:args}).then(function(r){var sc=(r&&r.structuredContent)||{};
 var text=r&&r.content&&r.content[0]&&r.content[0].text||"";return {ok:!(r&&r.isError),sc:sc,text:text}})}
var STATE={"waiting":["c-wait","ממתינה","Waiting"],"waiting-run":["c-wait","מחכה להפעלה","Waits for Run"],"deferred":["c-off","נדחתה","Deferred"],
 "running":["c-run","רצה","Running"],"done":["c-ok","הושלמה","Done"],"partial":["c-wait","חלקית","Partial"],"failed":["c-bad","נכשלה","Failed"]};
function chip(state){var s=STATE[state]||["c-off",state,state];return h("span",{"class":"chip "+s[0],text:T(s[1],s[2])})}
var EXEC={antigravity:"Antigravity",opencode:"OpenCode Go",ghostcli:"GhostCLI",gemini:"Gemini",claude:"Claude",opus:"Claude"};
function execName(e){return e==="local"?T("מודל מקומי","Local model"):EXEC[e]||e}
function clock(ms){try{return new Date(ms).toLocaleTimeString(LANG==="he"?"he-IL":"en-GB",{hour:"2-digit",minute:"2-digit"})}catch(e){return ""}}
function stepsText(t){return t.steps?T("צעד "+t.steps+(t.estSteps?" מתוך ~"+t.estSteps:""),"step "+t.steps+(t.estSteps?" of ~"+t.estSteps:"")):t.estSteps?T("~"+t.estSteps+" צעדים","~"+t.estSteps+" steps"):""}
function actionButtons(t,after,statusEl){var box=h("div",{"class":"actions"});
 function act(action,label,primary,extra){return h("button",{"class":primary?"primary":null,text:label,on:function(ev){var b=ev.currentTarget;b.disabled=true;
  statusEl.textContent=T("שולח…","Sending…");var args={taskId:t.taskId,action:action};if(PC)args.device=PC;for(var k in (extra||{}))args[k]=extra[k];
  callTool("kesher_task_action",args).then(function(r){statusEl.textContent=r.text;statusEl.className="status "+(r.ok?"ok":"bad");b.disabled=false;if(r.ok&&after)after()},
  function(e){statusEl.textContent=e.message;statusEl.className="status bad";b.disabled=false})}})}
 var open=t.state==="waiting"||t.state==="waiting-run"||t.state==="deferred";
 if(open||t.state==="failed"||t.state==="partial")box.appendChild(act("run",T("הפעל","Run"),true));
 if(t.state==="waiting"||t.state==="waiting-run")box.appendChild(t.queuePos?act("unqueue",T("הוצא מהתור","Unqueue")):act("queue",T("לתור","Queue")));
 if(t.state==="running"||open)box.appendChild(act("stop",t.state==="running"?T("עצור","Stop"):T("בטל","Cancel")));
 if(t.state!=="running"){var sel=h("select",{"aria-label":T("מי עושה","Who does it")});["antigravity","local","opencode","ghostcli","gemini","claude"].forEach(function(e){if(e!==t.executor)sel.appendChild(h("option",{value:e,text:execName(e)}))});
  box.appendChild(sel);box.appendChild(h("button",{text:T("העבר","Assign"),on:function(ev){var b=ev.currentTarget;b.disabled=true;statusEl.textContent=T("שולח…","Sending…");
   var args={taskId:t.taskId,action:"assign",to:sel.value};if(PC)args.device=PC;callTool("kesher_task_action",args).then(function(r){statusEl.textContent=r.text;statusEl.className="status "+(r.ok?"ok":"bad");b.disabled=false;if(r.ok&&after)after()},
   function(e){statusEl.textContent=e.message;statusEl.className="status bad";b.disabled=false})}}))}
 return box}
var root;function paint(node){root.replaceChildren(node)}
function boot(name,onResult){root=document.getElementById("app");
 window.addEventListener("message",function(e){if(e.source!==parent)return;var m=e.data;if(!m||m.jsonrpc!=="2.0")return;
  if(m.id!==undefined&&!m.method){var w=waiting[m.id];if(w){delete waiting[m.id];m.error?w.rej(new Error(m.error.message||"error")):w.res(m.result)}return}
  if(m.method==="ui/notifications/tool-input"){lastArgs=(m.params&&m.params.arguments)||{};return}
  if(m.method==="ui/notifications/tool-result"){var sc=(m.params&&m.params.structuredContent)||{};if(sc.pc)PC=sc.pc;onResult(sc,m.params||{});return}
  if(m.method==="ui/notifications/host-context-changed"){ctx(m.params);return}
  if(m.method==="ui/resource-teardown"&&m.id!==undefined)parent.postMessage({jsonrpc:"2.0",id:m.id,result:{}},"*")});
 if(window.ResizeObserver)new ResizeObserver(function(){notify("ui/notifications/size-changed",{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})}).observe(document.body);
 paint(h("div",{"class":"empty",text:"…"}));
 rpc("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:name,version:"1.0.0"},appCapabilities:{}}).then(function(r){ctx(r&&r.hostContext);notify("ui/notifications/initialized")},function(){notify("ui/notifications/initialized")})}
`;

/** The task board: rows with status chips and Run / Queue / Stop / Assign, which call kesher_task_action through the host. */
const BOARD_JS = `
function refresh(){callTool("kesher_tasks",lastArgs).then(function(r){render(r.sc)},function(){})}
function render(sc){var tasks=(sc.tasks||[]).slice().reverse();var wrap=h("main",{});
 wrap.appendChild(h("h1",{},T("משימות","Tasks"),sc.pc?h("small",{text:"· "+sc.pc+" · "+tasks.length}):null));
 if(!tasks.length)wrap.appendChild(h("div",{"class":"empty",text:sc.error||T("אין משימות כאן.","No tasks here.")}));
 tasks.forEach(function(t){var status=h("div",{"class":"status"});
  var meta=[execName(t.executor),t.model,stepsText(t),t.queuePos?T("מקום "+t.queuePos+" בתור","#"+t.queuePos+" in line"):""].filter(Boolean).join(" · ");
  wrap.appendChild(h("div",{"class":"card"},h("div",{"class":"row"},chip(t.state),h("span",{"class":"title grow",text:t.title})),
   h("div",{"class":"mut",dir:"auto",text:meta+" · "+t.taskId}),actionButtons(t,refresh,status),status))});
 paint(wrap)}
boot("kesher-board",render);
`;

/** The quotas: one card per provider with a bar per window and when it fills again. */
const QUOTAS_JS = `
var QSTATE={ok:["c-ok","יש","OK"],low:["c-wait","נמוך","Low"],out:["c-bad","נגמר","Used up"],off:["c-off","כבוי","Off"],unknown:["c-off","לא ידוע","Unknown"]};
function share(b){if(typeof b.left==="number")return b.left;if(typeof b.used==="number"&&b.limit)return Math.max(0,1-b.used/b.limit);return null}
function render(sc){var qs=sc.quotas||[];var wrap=h("main",{});
 wrap.appendChild(h("h1",{},T("מכסות","Quotas"),sc.pc?h("small",{text:"· "+sc.pc}):null));
 if(!qs.length)wrap.appendChild(h("div",{"class":"empty",text:sc.error||T("המחשב לא דיווח מכסות.","The PC reported no quotas.")}));
 ["tasks","chat"].forEach(function(g){var rows=qs.filter(function(q){return (q.group||"tasks")===g});if(!rows.length)return;
  wrap.appendChild(h("h2",{text:g==="tasks"?T("סוכני משימות","Task agents"):T("עוזרי צ'אט","Chat helpers")}));
  rows.forEach(function(q){var s=QSTATE[q.state]||QSTATE.unknown;var card=h("div",{"class":"card"},h("div",{"class":"row"},h("span",{"class":"title grow",text:q.name}),h("span",{"class":"chip "+s[0],text:T(s[1],s[2])})));
   (q.bars||[]).forEach(function(b){var f=share(b);var pct=f==null?null:Math.round(f*100);
    var label=pct!=null?T(pct+"% נשאר",pct+"% left"):(typeof b.used==="number"?T("נוצלו "+b.used,"used "+b.used):T("לא ידוע","unknown"));
    var track=h("div",{"class":"track"+(f!=null&&f<=0?" out":f!=null&&f<0.2?" low":""),role:"img","aria-label":b.label+" "+label},h("i",{style:"width:"+(pct==null?0:pct)+"%"}));
    card.appendChild(h("div",{"class":"row"},h("span",{"class":"mut",style:"min-width:64px",text:b.label}),track,h("span",{"class":"mut",text:label+(b.resetAt?" · "+T("חוזר ב-","back at ")+clock(b.resetAt):"")})))});
   var extra=[q.model,q.today?T("היום: "+q.today.runs+" ריצות","today: "+q.today.runs+" runs"):"",q.until?T("עד ","until ")+clock(q.until):"",q.readAt?T("נקרא ב-","read at ")+clock(q.readAt):""].filter(Boolean).join(" · ");
   if(extra)card.appendChild(h("div",{"class":"mut",dir:"auto",text:extra}));wrap.appendChild(card)})});
 paint(wrap)}
boot("kesher-quotas",render);
`;

/** One task: chip, progress bar (steps of the estimate), result or cause, the newest steps, and its actions. */
const TASK_JS = `
function refresh(){if(!cur)return;var a={taskId:cur.taskId};if(PC)a.device=PC;callTool("kesher_task",a).then(function(r){render(r.sc)},function(){})}
var cur=null;
function render(sc){var t=sc.task;var wrap=h("main",{});cur=t||null;
 if(!t){wrap.appendChild(h("div",{"class":"empty",text:sc.error||sc.text||T("אין משימה.","No task.")}));return paint(wrap)}
 wrap.appendChild(h("h1",{},chip(t.state),h("span",{"class":"grow",dir:"auto",text:t.title})));
 wrap.appendChild(h("div",{"class":"mut",dir:"auto",text:[execName(t.executor),t.model,t.branch,t.taskId,sc.pc].filter(Boolean).join(" · ")}));
 if(t.estSteps||t.steps){var f=t.estSteps?Math.min(1,(t.steps||0)/t.estSteps):(t.state==="done"?1:0);if(t.state==="done")f=1;
  wrap.appendChild(h("div",{"class":"row"},h("div",{"class":"track acc",role:"progressbar","aria-valuemin":"0","aria-valuemax":"100","aria-valuenow":String(Math.round(f*100))},h("i",{style:"width:"+Math.round(f*100)+"%"})),h("span",{"class":"mut",text:stepsText(t)})))}
 var times=[t.startedAt?T("התחילה ","started ")+clock(t.startedAt):"",t.endedAt?T("הסתיימה ","ended ")+clock(t.endedAt):""].filter(Boolean).join(" · ");if(times)wrap.appendChild(h("div",{"class":"mut",text:times}));
 if(t.result||t.cause)wrap.appendChild(h("div",{"class":"card"},h("div",{"class":"mut",text:t.cause&&t.state!=="done"?T("למה נעצרה","Why it stopped"):T("תוצאה","Result")}),h("div",{dir:"auto",text:t.result||t.cause})));
 var steps=t.stepLog||[];var list=h("ol",{"class":"steps"});steps.forEach(function(s){list.appendChild(h("li",{"class":s.error?"bad":null,dir:"auto",text:s.tool+(s.target?" · "+s.target:"")+(s.at?" · "+clock(s.at):"")}))});
 wrap.appendChild(h("div",{"class":"card"},h("div",{"class":"mut",text:T("צעדים אחרונים","Latest steps")}),steps.length?list:h("div",{"class":"empty",text:T("עוד אין צעדים.","No steps yet.")})));
 var status=h("div",{"class":"status"});wrap.appendChild(actionButtons(t,refresh,status));wrap.appendChild(status);paint(wrap)}
boot("kesher-task",render);
`;

/**
 * The approvals: one card per waiting approval (which tool, why, a short preview) with Allow, Allow for 10 minutes and
 * Deny. The buttons call kesher_approve through the host; the PC still checks the user's own switch and never lets a
 * dangerous command or screen control through (such a card shows only Deny).
 */
const APPROVALS_JS = `
var canAnswer=true;
function refresh(){var a={};if(PC)a.device=PC;callTool("kesher_approvals",a).then(function(r){render(r.sc)},function(){})}
function decide(a,decision,minutes,status,btn){btn.disabled=true;status.className="status";status.textContent=T("שולח…","Sending…");
 var args={conversationId:a.conversationId,requestId:a.requestId,decision:decision};if(minutes)args.forMinutes=minutes;if(PC)args.device=PC;
 callTool("kesher_approve",args).then(function(r){status.textContent=r.text;status.className="status "+(r.ok?"ok":"bad");btn.disabled=false;if(r.ok)setTimeout(refresh,600)},
  function(e){status.textContent=e.message;status.className="status bad";btn.disabled=false})}
function render(sc){var items=sc.approvals||[];canAnswer=sc.canAnswer===true;var wrap=h("main",{});
 wrap.appendChild(h("h1",{},T("אישורים","Approvals"),sc.pc?h("small",{text:"· "+sc.pc+" · "+items.length}):null));
 if(!canAnswer&&items.length)wrap.appendChild(h("div",{"class":"note",text:T("KesherAI לא מרשה ל-Claude לאשר (הגדרות ← שימוש ב-KesherAI מאפליקציות אחרות). אפשר רק לדחות.","KesherAI does not let Claude allow cards (Settings, Use KesherAI from other apps). Deny still works.")}));
 if(!items.length)wrap.appendChild(h("div",{"class":"empty",text:sc.error||T("שום דבר לא מחכה לאישור.","Nothing waits for approval.")}));
 items.forEach(function(a){var status=h("div",{"class":"status"});var box=h("div",{"class":"actions"});
  var allow=h("button",{"class":"primary",text:T("אשר","Allow"),on:function(ev){decide(a,"allow",0,status,ev.currentTarget)}});
  var ten=h("button",{text:T("אשר ל-10 דקות","Allow for 10 minutes"),on:function(ev){decide(a,"allow",10,status,ev.currentTarget)}});
  var deny=h("button",{"class":"danger",text:T("דחה","Deny"),on:function(ev){decide(a,"deny",0,status,ev.currentTarget)}});
  if(!a.locked&&canAnswer){box.appendChild(allow);if(a.forWhile)box.appendChild(ten)}box.appendChild(deny);
  wrap.appendChild(h("div",{"class":"card"},h("div",{"class":"row"},h("span",{"class":"chip c-wait",text:a.tool}),h("span",{"class":"title grow",dir:"auto",text:a.title||T("שיחה","Chat")})),
   h("div",{"class":"mut",dir:"auto",text:[a.who,a.reason,a.at?clock(Date.parse(a.at)):""].filter(Boolean).join(" · ")}),
   a.preview?h("pre",{"class":"pre",dir:"auto",text:a.preview}):null,
   a.locked?h("div",{"class":"note",text:T("רק אתה יכול לאשר את זה, ב-KesherAI (פקודה מסוכנת או שליטה במסך).","Only you can allow this one, in KesherAI (a dangerous command or screen control).")}):null,
   box,status))});
 paint(wrap)}
boot("kesher-approvals",render);
`;

/** One whole view page. */
function page(title: string, js: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><div id="app"></div><script>${BRIDGE}${js}</script></body></html>`;
}

/** The views, as `resources/list` lists them and `resources/read` serves them. */
export const VIEWS: ReadonlyArray<{ uri: string; name: string; description: string; html: string }> = [
  { uri: VIEW_URIS.board, name: "Kesher task board", description: "The PC's task inbox with Run, Queue, Stop and Assign.", html: page("Kesher tasks", BOARD_JS) },
  { uri: VIEW_URIS.quotas, name: "Kesher quotas", description: "What is left of each provider the PC's agents use.", html: page("Kesher quotas", QUOTAS_JS) },
  { uri: VIEW_URIS.task, name: "Kesher task", description: "One task: progress, result and its latest steps.", html: page("Kesher task", TASK_JS) },
  { uri: VIEW_URIS.approvals, name: "Kesher approvals", description: "Approval cards waiting on the PC, with Allow, Allow for 10 minutes and Deny.", html: page("Kesher approvals", APPROVALS_JS) },
];
