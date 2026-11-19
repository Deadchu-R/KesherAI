import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { RichText } from "./RichText";
import { PluginFrame, type GuestSceneInput } from "./plugins";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const TOKEN_KEY = "kesher-token";
/** Marks this browser as a guest of a shared project (the whole app shows only this page). */
export const GUEST_KEY = "kesher-guest";

/** Whether this browser should show the guest page: an invite link, or a guest who already joined. */
export function isGuest(): boolean {
  try {
    return location.hash.startsWith("#/join/") || localStorage.getItem(GUEST_KEY) === "1";
  } catch {
    return false;
  }
}

interface Me {
  name: string;
  project: string;
  role: "read" | "edit";
  left: number;
  dailyLimit: number;
}
interface ChatRow {
  id: string;
  title: string;
  updatedAt: string;
  mine: boolean;
}
interface Chat {
  id: string;
  title: string;
  mine: boolean;
  busy: boolean;
  messages: Array<{ seq: number; role: "user" | "assistant"; text: string }>;
}

/** An engine scene in the shared project's folder; `open` while the owner (or their device) has it open. */
interface SceneRow {
  engine: "godot" | "unity";
  project: string;
  scene: string;
  open: boolean;
}
/** The 3D editor a guest opens scenes in, and the key for its files. */
interface SceneEditor {
  pluginId: string;
  file: string;
  title: string;
  uses: string[];
  filesKey: string;
}

/**
 * The Scenes tab (RESEARCH_LOG "A scene together, for guests through share links"): the engine scenes in the project's
 * folder, the ones the owner has open now first. A guest joins only those: the others wait for the owner.
 */
function GuestScenes({ scenes, editor, onOpen }: { scenes: SceneRow[]; editor: SceneEditor | null; onOpen: (s: SceneRow) => void }) {
  if (!editor) return <p className="muted small">{L("עורך התלת ממד לא פעיל במחשב של הבעלים.", "The 3D editor is not on in the owner's KesherAI.")}</p>;
  return (
    <section className="stack guest-scenes">
      <p className="muted small">{L("פותחים סצנה שהבעלים פתוח בה עכשיו: רואים איפה כל אחד מסתכל ואפשר לעקוב אחריו. שום דבר לא זז ולא נשמר מכאן.", "Open a scene the owner has open now: see where everyone looks and follow them. Nothing is moved or saved from here.")}</p>
      {scenes.map((sc) => (
        <button key={`${sc.engine}|${sc.project}|${sc.scene}`} type="button" className="card guest-scene" onClick={() => onOpen(sc)}>
          <span className="row guest-scene-top">
            <b className="grow" dir="ltr">🧊 {sc.scene.split("/").pop()}</b>
            {sc.open ? <span className="pill small guest-live">● {L("פתוח עכשיו", "Open now")}</span> : <span className="muted small">{L("סגור", "Closed")}</span>}
          </span>
          <span className="muted small" dir="ltr">{sc.engine === "godot" ? "Godot" : "Unity"} · {sc.project === "." ? "" : `${sc.project}/`}{sc.scene.replace(/^res:\/\//, "")}</span>
        </button>
      ))}
    </section>
  );
}

/** Joining from an invite link: what it is for, a name, and the guest's own key kept in this browser. */
function Join({ token }: { token: string }) {
  const [info, setInfo] = useState<{ project: string; role: "read" | "edit"; google?: boolean; emailHint?: string } | null>(null);
  const [code, setCode] = useState<{ userCode: string; url: string } | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(poll.current), []);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ project: string; role: "read" | "edit"; google?: boolean; emailHint?: string }>(`/api/join/${encodeURIComponent(token)}`).then(setInfo, (e: Error) => setError(e.message));
  }, [token]);
  const signedIn = (key: string) => {
    localStorage.setItem(TOKEN_KEY, key);
    localStorage.setItem(GUEST_KEY, "1");
    location.hash = "#/";
    location.reload();
  };
  // An email invite: Google's sign-in as on a TV (a code at google.com/device), asked every 5 seconds.
  const google = async () => {
    setError("");
    try {
      const r = await api<{ userCode: string; url: string }>(`/api/join/${encodeURIComponent(token)}/google`, { method: "POST", body: { op: "start" } });
      setCode(r);
      const ask = () => {
        poll.current = setTimeout(() => {
          void api<{ waiting: boolean; key?: string }>(`/api/join/${encodeURIComponent(token)}/google`, { method: "POST", body: { op: "check" } }).then(
            (c) => (c.key ? signedIn(c.key) : ask()),
            (e: Error) => { setCode(null); setError(e.message); },
          );
        }, 5000);
      };
      ask();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const join = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ key: string }>(`/api/join/${encodeURIComponent(token)}`, { method: "POST", body: { name } });
      signedIn(r.key);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <main className="guest-page">
      <section className="card stack guest-join">
        <strong className="guest-title">KesherAI</strong>
        {error && <p className="error" role="alert" dir="auto">{error}</p>}
        {!info && !error && <p className="muted">{L("טוען…", "Loading…")}</p>}
        {info?.google && (
          <div className="stack">
            <p dir="auto">{L(`הוזמנת לפרויקט "${info.project}" (${info.role === "edit" ? "צפייה וכתיבה" : "צפייה"}).`, `You are invited to the project "${info.project}" (${info.role === "edit" ? "read and write" : "read"}).`)}</p>
            <p className="muted small" dir="auto">{L("ההזמנה לחשבון Google: ", "The invite is for the Google account ")}<span dir="ltr">{info.emailHint}</span></p>
            {code ? (
              <div className="card stack" role="status">
                <span className="small">{L("פתח את הדף של Google, התחבר עם החשבון המוזמן והקלד את הקוד:", "Open Google's page, sign in with the invited account and type the code:")}</span>
                <b className="trakt-user-code" dir="ltr">{code.userCode}</b>
                <a className="button primary" href={code.url} target="_blank" rel="noopener noreferrer" dir="ltr">{code.url.replace("https://", "")} ↗</a>
                <span className="muted small">{L("מחכה לאישור של Google… זה יזוהה לבד.", "Waiting for Google… it is noticed by itself.")}</span>
              </div>
            ) : (
              <button type="button" className="primary" onClick={() => void google()}>{L("התחבר עם Google", "Sign in with Google")}</button>
            )}
          </div>
        )}
        {info && !info.google && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void join(); }}>
            <p dir="auto">{L(`הוזמנת לפרויקט "${info.project}" (${info.role === "edit" ? "צפייה וכתיבה" : "צפייה"}).`, `You are invited to the project "${info.project}" (${info.role === "edit" ? "read and write" : "read"}).`)}</p>
            <label className="stack">
              <span className="small">{L("השם שלך", "Your name")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus dir="auto" required />
            </label>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? "…" : L("הצטרף", "Join")}</button>
            <p className="muted small">{L("הקישור עובד פעם אחת. אחרי ההצטרפות תראה רק את הפרויקט הזה.", "The link works once. After joining you see only this project.")}</p>
          </form>
        )}
      </section>
    </main>
  );
}

/**
 * The whole app for a guest of a shared project (docs/COLLABORATION.md, design ProjectGuestPhone): the project's chats
 * to read and, with "edit", chats of their own to write in. It uses only /api/guest/* (all a guest key opens).
 */
export function GuestApp() {
  const join = /^#\/join\/([A-Za-z0-9_-]{32,64})$/.exec(location.hash)?.[1];
  const [me, setMe] = useState<Me | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [open, setOpen] = useState<Chat | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [tab, setTab] = useState<"chats" | "scenes">("chats");
  const [scenes, setScenes] = useState<{ scenes: SceneRow[]; editor: SceneEditor | null }>({ scenes: [], editor: null });
  const [scene, setScene] = useState<SceneRow | null>(null);

  const loadScenes = useCallback(async () => {
    setScenes(await api<{ scenes: SceneRow[]; editor: SceneEditor | null }>("/api/guest/scenes").catch(() => ({ scenes: [], editor: null })));
  }, []);
  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/guest/me"));
      setChats((await api<{ chats: ChatRow[] }>("/api/guest/chats")).chats);
      await loadScenes();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [loadScenes]);
  // While the Scenes list is shown, which are open now is asked again every 15 seconds (not while the tab is hidden).
  useEffect(() => {
    if (tab !== "scenes" || scene) return;
    const t = setInterval(() => { if (!document.hidden) void loadScenes(); }, 15_000);
    return () => clearInterval(t);
  }, [tab, scene, loadScenes]);
  const read = useCallback(async (id: string) => {
    clearTimeout(timer.current);
    try {
      const c = await api<Chat>(`/api/guest/chats/${encodeURIComponent(id)}`);
      setOpen(c);
      // While the model answers, read again every 2.5 seconds.
      if (c.busy) timer.current = setTimeout(() => void read(id), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!join) void load();
    return () => clearTimeout(timer.current);
  }, [join, load]);

  if (join) return <Join token={join} />;
  // A scene: the 3D editor in guest mode, the whole screen, with a way back.
  if (scene && scenes.editor && me) {
    const guest: GuestSceneInput = { engine: scene.engine, project: scene.project, scene: scene.scene, role: me.role, filesKey: scenes.editor.filesKey };
    return (
      <main className="guest-scene-page">
        <header className="guest-bar row">
          <button type="button" className="ghost" onClick={() => { setScene(null); void loadScenes(); }} aria-label={L("חזרה", "Back")}>{getLocale() === "he" ? "→" : "←"}</button>
          <strong className="grow" dir="ltr">{scene.scene.split("/").pop()}</strong>
          <span className="pill small">{L("אורח", "Guest")} · {me.role === "edit" ? L("בחירה", "can select") : L("צפייה", "watching")}</span>
        </header>
        <div className="guest-scene-frame">
          <PluginFrame pluginId={scenes.editor.pluginId} file={scenes.editor.file} title={scenes.editor.title} uses={scenes.editor.uses} guest={guest} />
        </div>
      </main>
    );
  }
  const leave = () => {
    if (!confirm(L("לצאת מהפרויקט בדפדפן הזה? כדי לחזור צריך הזמנה חדשה.", "Leave the project in this browser? To come back you need a new invite."))) return;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(GUEST_KEY);
    location.hash = "#/";
    location.reload();
  };
  const newChat = async () => {
    try {
      const r = await api<{ id: string }>("/api/guest/chats", { method: "POST" });
      await load();
      await read(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const send = async () => {
    if (!open || !text.trim()) return;
    try {
      const r = await api<{ left: number }>(`/api/guest/chats/${encodeURIComponent(open.id)}/messages`, { method: "POST", body: { text } });
      setText("");
      setMe((m) => (m ? { ...m, left: r.left } : m));
      setTimeout(() => void read(open.id), 600);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <main className="guest-page">
      <header className="guest-bar row">
        {open && <button type="button" className="ghost" onClick={() => { clearTimeout(timer.current); setOpen(null); void load(); }} aria-label={L("חזרה", "Back")}>→</button>}
        <strong className="grow" dir="auto">{open ? open.title : (me?.project ?? "KesherAI")}</strong>
        {me && <span className="pill small">{L("אורח", "Guest")} · {me.role === "edit" ? L("כתיבה", "write") : L("צפייה", "read")}</span>}
        <button type="button" className="ghost small" onClick={leave}>{L("יציאה", "Leave")}</button>
      </header>
      {error && <p className="error" role="alert" dir="auto">{error}</p>}
      {!open && scenes.scenes.length > 0 && (
        <nav className="tabs guest-tabs" aria-label={L("חלקי הפרויקט", "Parts of the project")}>
          <button type="button" className={tab === "chats" ? "on" : ""} onClick={() => setTab("chats")}>💬 {L("צ'אטים", "Chats")}</button>
          <button type="button" className={tab === "scenes" ? "on" : ""} onClick={() => { setTab("scenes"); void loadScenes(); }}>🧊 {L("סצנות", "Scenes")}{scenes.scenes.some((x) => x.open) ? " ●" : ""}</button>
        </nav>
      )}
      {!open && tab === "scenes" && scenes.scenes.length > 0 ? (
        <GuestScenes scenes={scenes.scenes} editor={scenes.editor} onOpen={setScene} />
      ) : !open ? (
        <section className="stack guest-list">
          {me && <p className="muted small" dir="auto">{L(`${me.name}, שיתפו איתך את הפרויקט הזה ב-KesherAI.`, `${me.name}, this project was shared with you in KesherAI.`)}</p>}
          {chats.length === 0 && <p className="muted">{L("אין עדיין צ'אטים בפרויקט.", "No chats in this project yet.")}</p>}
          {chats.map((c) => (
            <button key={c.id} type="button" className="card guest-chat" onClick={() => void read(c.id)}>
              <b dir="auto">💬 {c.title}</b>
              <span className="muted small">{new Date(c.updatedAt).toLocaleString()}{c.mine ? ` · ${L("שלך", "yours")}` : ""}</span>
            </button>
          ))}
          {me?.role === "edit" && <button type="button" className="primary" onClick={() => void newChat()}>＋ {L("צ'אט חדש בפרויקט", "New chat in the project")}</button>}
          {me && <p className="muted small">{L(`נשארו לך היום ${me.left} מתוך ${me.dailyLimit} תשובות.`, `${me.left} of ${me.dailyLimit} answers left today.`)}</p>}
        </section>
      ) : (
        <section className="stack guest-chat-view">
          {open.messages.map((m) => (
            <div key={m.seq} className={m.role === "user" ? "msg user" : "msg"} dir="auto">
              {m.role === "user" ? m.text : <RichText text={m.text} />}
            </div>
          ))}
          {open.busy && <p className="muted small" role="status">{L("עונה…", "Answering…")}</p>}
          {open.mine && me?.role === "edit" ? (
            <form className="row guest-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} dir="auto" placeholder={L("כתוב הודעה…", "Write a message…")} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <button type="submit" className="primary" disabled={!text.trim() || open.busy}>{L("שלח", "Send")}</button>
            </form>
          ) : (
            <p className="muted small">{me?.role === "edit" ? L("אפשר לכתוב רק בצ'אטים שפתחת. ", "You can write only in chats you started. ") : L("יש לך הרשאת צפייה בלבד.", "You can read only.")}</p>
          )}
        </section>
      )}
    </main>
  );
}
