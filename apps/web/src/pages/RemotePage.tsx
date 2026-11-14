import { useEffect, useRef, useState } from "react";
import { api, isRemote, withToken } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status { enabled: boolean; hasPin: boolean; active: boolean; since?: string; device?: string; locked: boolean; waiting?: Array<{ code: string; device: string; at: string }>; trusted?: Array<{ id: string; name: string; at: string }> }

/** This phone's own random id (asked for "Always"; kept on the phone). */
function deviceId(): string {
  try {
    let id = localStorage.getItem("kesher.remoteDeviceId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("kesher.remoteDeviceId", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** The owner's answer to a phone asking for control. */
export function decideRemote(code: string, d: "once" | "always" | "deny"): Promise<unknown> {
  return api(`/api/remote-desktop/decide/${code}?d=${d}`, { method: "POST" });
}
type Input = { kind: "click" | "double" | "right"; x: number; y: number } | { kind: "scroll"; x: number; y: number; amount: number } | { kind: "type"; text: string } | { kind: "key"; combo: string };

/**
 * "Control the computer" (like Chrome Remote Desktop). On the computer: switch it on and set a PIN. On the phone:
 * the PIN, then the screen as pictures; tap = click, double tap = double click, long press = right click; keys,
 * text and scrolling below.
 */
export function RemotePage() {
  return isRemote() ? <RemoteControl /> : <RemoteSetup />;
}

/** On the computer: on/off and the PIN. */
function RemoteSetup() {
  const [st, setSt] = useState<Status | null>(null);
  const [pin, setPin] = useState("");
  const load = () => void api<Status>("/api/remote-desktop").then(setSt, () => undefined);
  useEffect(load, []);
  const save = (body: { enabled?: boolean; pin?: string }) =>
    void api<Status>("/api/remote-desktop/settings", { method: "PUT", body }).then((x) => { setSt(x); setPin(""); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  if (!st) return null;
  return (
    <div className="page stack">
      <h1>{L("שליטה במחשב מהטלפון", "Control this computer from the phone")}</h1>
      <p className="muted">{L("כמו Google Remote Desktop: מהטלפון (אפליקציית KesherAI, מחוברת למחשב הזה) רואים את המסך ולוחצים, מקלידים וגוללים. צריך את הקוד שקובעים כאן. כבוי כברירת מחדל.", "Like Google Remote Desktop: from the phone (the KesherAI app, paired with this computer) see the screen and tap, type and scroll. It needs the PIN set here. Off by default.")}</p>
      <section className="card stack">
        <label className="stack small">
          {st.hasPin ? L("קוד חדש (6–12 ספרות)", "A new PIN (6-12 digits)") : L("קוד (6–12 ספרות)", "PIN (6-12 digits)")}
          <input type="password" inputMode="numeric" autoComplete="new-password" dir="ltr" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))} />
        </label>
        <button type="button" style={{ alignSelf: "start" }} disabled={pin.length < 6} onClick={() => save({ pin })}>{L("שמור קוד", "Save the PIN")}</button>
        <label className="check">
          <input type="checkbox" checked={st.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          {L("לאפשר שליטה מהטלפון", "Allow control from the phone")}
        </label>
        {st.active && (
          <p className="row">
            <span className="grow">{L(`📱 הטלפון שולט עכשיו (מ-${new Date(st.since!).toLocaleTimeString()})`, `📱 The phone is in control now (since ${new Date(st.since!).toLocaleTimeString()})`)}</span>
            <button type="button" className="danger" onClick={() => void api<Status>("/api/remote-desktop/end", { method: "POST" }).then(setSt)}>{L("נתק", "Disconnect")}</button>
          </p>
        )}
        {(st.waiting ?? []).map((w) => (
          <div key={w.code} className="card row wrap">
            <span className="grow">{L(`📱 ${w.device} מבקש לשלוט במחשב`, `📱 ${w.device} asks to control the computer`)}</span>
            <button type="button" className="primary" onClick={() => void decideRemote(w.code, "once").then(load)}>{L("אשר פעם אחת", "Allow once")}</button>
            <button type="button" onClick={() => void decideRemote(w.code, "always").then(load)}>{L("תמיד", "Always")}</button>
            <button type="button" className="danger" onClick={() => void decideRemote(w.code, "deny").then(load)}>{L("דחה", "Deny")}</button>
          </div>
        ))}
        {(st.trusted ?? []).length > 0 && (
          <div className="stack small">
            <span>{L("טלפונים שאושרו תמיד (נכנסים בלי קוד ובלי לשאול):", "Phones allowed for good (no PIN, no asking):")}</span>
            {st.trusted!.map((t) => (
              <div key={t.id} className="row">
                <span className="grow">{t.name} · {new Date(t.at).toLocaleDateString()}</span>
                <button type="button" onClick={() => void api(`/api/remote-desktop/trusted/${t.id}`, { method: "DELETE" }).then(load)}>{L("הסר", "Remove")}</button>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">{L("בלי קוד: הטלפון מבקש, ומאשרים כאן או בהתראה בטלפון שלכם (פעם אחת / תמיד / דחה). ", "Without a PIN: the phone asks, and you answer here or in the notification on your phone (once / always / deny). ")}{L("חמש טעויות בקוד נועלות ל-10 דקות. סשן נגמר אחרי 15 דקות בלי פעולה. כשהטלפון שולט, מופיע פס למעלה בחלון של KesherAI עם “נתק”.", "Five wrong PINs lock it for 10 minutes. A session ends after 15 idle minutes. While the phone is in control, a bar at the top of KesherAI's window has “Disconnect”.")}</p>
      </section>
    </div>
  );
}

/** On the phone: the PIN, then the screen. */
function RemoteControl() {
  const [token, setToken] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("kesher.remoteDesktop");
    } catch {
      return null;
    }
  });
  const [pin, setPin] = useState("");
  const [asking, setAsking] = useState(false);
  const begin = (t: string) => {
    setToken(t);
    try {
      sessionStorage.setItem("kesher.remoteDesktop", t);
    } catch {
      // only this page
    }
  };
  // Without the PIN: ask, then wait for the owner's answer (or start at once on a phone allowed for good).
  const ask = async () => {
    setAsking(true);
    try {
      const me = deviceId();
      const r = await api<{ id: string; token?: string }>("/api/remote-desktop/request", { method: "POST", body: { device: navigator.userAgent.includes("Android") ? "Android phone" : "Phone", deviceId: me } });
      if (r.token) return begin(r.token);
      for (let i = 0; i < 150; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const p = await api<{ state: string; token?: string }>(`/api/remote-desktop/request/${r.id}?deviceId=${encodeURIComponent(me)}`);
        if (p.state === "approved" && p.token) return begin(p.token);
        if (p.state !== "waiting") return toast(p.state === "denied" ? L("בעל המחשב דחה.", "The owner said no.") : L("הבקשה פגה.", "The request ran out."));
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const press = useRef<{ t: number; timer?: ReturnType<typeof setTimeout>; long: boolean; lastTap: number }>({ t: 0, long: false, lastTap: 0 });

  const stop = (msg?: string) => {
    setToken(null);
    try {
      sessionStorage.removeItem("kesher.remoteDesktop");
    } catch {
      // nothing kept
    }
    if (msg) toast(msg);
  };
  // Pictures one after another, as fast as the computer makes them.
  useEffect(() => {
    if (!token) return;
    let live = true;
    let url: string | null = null;
    const loop = async () => {
      while (live) {
        const started = Date.now();
        try {
          const res = await fetch(withToken(`/api/remote-desktop/frame?s=${token}&w=${Math.round(Math.min(1920, innerWidth * devicePixelRatio * zoom))}`));
          if (!res.ok) {
            stop(((await res.json().catch(() => ({}))) as { error?: string }).error ?? L("הסשן נגמר.", "The session ended."));
            return;
          }
          const next = URL.createObjectURL(await res.blob());
          if (url) URL.revokeObjectURL(url);
          url = next;
          setSrc(next);
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
        }
        await new Promise((r) => setTimeout(r, Math.max(150, 400 - (Date.now() - started))));
      }
    };
    void loop();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, zoom]);

  const send = (input: Input) =>
    void api("/api/remote-desktop/input", { method: "POST", body: { s: token, input } }).catch((e: Error) => stop(e.message));
  const at = (e: React.PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * img.current!.naturalWidth), y: Math.round(((e.clientY - r.top) / r.height) * img.current!.naturalHeight) };
  };

  if (!token)
    return (
      <div className="page stack">
        <h1>{L("שליטה במחשב", "Control the computer")}</h1>
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void api<{ token: string }>("/api/remote-desktop/session", { method: "POST", body: { pin, device: navigator.userAgent.includes("Android") ? "Android" : "phone" } }).then((r) => { setToken(r.token); setPin(""); try { sessionStorage.setItem("kesher.remoteDesktop", r.token); } catch { /* only this page */ } }, (err: Error) => toast(err.message)); }}>
          <label className="stack small">
            {L("הקוד שנקבע במחשב", "The PIN set on the computer")}
            <input type="password" inputMode="numeric" autoComplete="off" dir="ltr" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))} />
          </label>
          <button type="submit" className="primary" disabled={pin.length < 6}>{L("התחבר", "Connect")}</button>
          <button type="button" disabled={asking} onClick={() => void ask()}>{asking ? L("מחכה לאישור של בעל המחשב…", "Waiting for the computer's owner…") : L("בלי קוד: לבקש אישור מבעל המחשב", "No PIN: ask the computer's owner")}</button>
          <p className="muted small">{L("צריך להדליק את זה במחשב עצמו: בתפריט ← שליטה מרחוק (קוד ו״לאפשר שליטה מהטלפון״).", "Switch it on at the computer first: the menu → Remote control (a PIN and “Allow control from the phone”).")}</p>
        </form>
      </div>
    );

  return (
    <div className="remote-desk">
      <div className="remote-screen" style={{ overflow: zoom > 1 ? "auto" : "hidden" }}>
        {src ? (
          <img
            ref={img}
            src={src}
            alt={L("המסך של המחשב", "The computer's screen")}
            style={{ width: `${zoom * 100}%` }}
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              const p = press.current;
              p.t = Date.now();
              p.long = false;
              const pos = at(e);
              p.timer = setTimeout(() => {
                p.long = true;
                send({ kind: "right", ...pos });
              }, 550);
            }}
            onPointerUp={(e) => {
              const p = press.current;
              clearTimeout(p.timer);
              if (p.long || Date.now() - p.t > 550) return;
              const pos = at(e);
              // A second tap within 300 ms makes the first a double click.
              if (Date.now() - p.lastTap < 300) {
                p.lastTap = 0;
                send({ kind: "double", ...pos });
              } else {
                p.lastTap = Date.now();
                send({ kind: "click", ...pos });
              }
            }}
            onPointerCancel={() => clearTimeout(press.current.timer)}
          />
        ) : (
          <p className="muted">{L("מתחבר…", "Connecting…")}</p>
        )}
      </div>
      <div className="remote-keys row wrap">
        <form className="row grow" onSubmit={(e) => { e.preventDefault(); if (text) send({ kind: "type", text }); setText(""); }}>
          <input className="grow" dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("להקליד במחשב…", "Type on the computer…")} aria-label={L("טקסט להקלדה", "Text to type")} />
          <button type="submit">↵</button>
        </form>
        {[["Enter", "enter"], ["⌫", "backspace"], ["Esc", "escape"], ["Tab", "tab"], ["Ctrl+C", "ctrl+c"], ["Ctrl+V", "ctrl+v"], ["Ctrl+Z", "ctrl+z"]].map(([label, combo]) => (
          <button key={combo} type="button" onClick={() => send({ kind: "key", combo: combo! })}>{label}</button>
        ))}
        <button type="button" aria-label={L("גלול למעלה", "Scroll up")} onClick={() => send({ kind: "scroll", x: (img.current?.naturalWidth ?? 0) / 2, y: (img.current?.naturalHeight ?? 0) / 2, amount: -5 })}>▲</button>
        <button type="button" aria-label={L("גלול למטה", "Scroll down")} onClick={() => send({ kind: "scroll", x: (img.current?.naturalWidth ?? 0) / 2, y: (img.current?.naturalHeight ?? 0) / 2, amount: 5 })}>▼</button>
        <button type="button" onClick={() => setZoom(zoom === 1 ? 2 : 1)}>{zoom === 1 ? "🔍 ×2" : "🔍 ×1"}</button>
        <button type="button" className="danger" onClick={() => void api("/api/remote-desktop/end", { method: "POST" }).finally(() => stop())}>{L("נתק", "Disconnect")}</button>
      </div>
    </div>
  );
}
