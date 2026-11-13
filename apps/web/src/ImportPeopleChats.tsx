/**
 * Settings → Import: a chat with people from WhatsApp or Instagram, brought in so a model (a persona that
 * analyses relationships, for example) can read it. WhatsApp: the .txt (or zip) from "Export chat". Instagram:
 * the zip of "Download your information" in JSON format (pick the chat from the list), or one chat's
 * message_N.json files. The chat becomes a knowledge base on this computer; nothing is sent anywhere.
 */
import { useRef, useState } from "react";
import { unzip } from "fflate";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Done { name: string; messages: number; from: string; to: string; people: Array<{ name: string; messages: number }>; replaced: boolean }
/** One Instagram thread found in a zip. */
interface Thread { folder: string; files: Record<string, Uint8Array>; bytes: number }

const text = (b: Uint8Array) => new TextDecoder().decode(b);
/** "WhatsApp Chat with Dana.txt" / "צ'אט WhatsApp עם דנה.txt" → "Dana". */
const waTitle = (file: string) => file.replace(/^.*[\\/]/, "").replace(/\.(txt|zip)$/i, "").replace(/^(WhatsApp Chat( with)?|צ'אט WhatsApp עם|שיחת WhatsApp עם|_chat)\s*[-–]?\s*/i, "").trim();

function unzipSome(file: File, filter: (name: string) => boolean): Promise<Record<string, Uint8Array>> {
  return file.arrayBuffer().then((buf) => new Promise((resolve, reject) => unzip(new Uint8Array(buf), { filter: (f) => filter(f.name) }, (err, files) => (err ? reject(err) : resolve(files)))));
}

/** The card. */
export function ImportPeopleChats() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState("");

  const send = async (body: { source: "whatsapp" | "instagram"; title: string; text?: string; parts?: unknown[] }) => {
    setDone(await api<Done>("/api/import/people-chat", { method: "POST", body }));
    setThreads([]);
  };
  const importThread = async (t: Thread) => {
    setBusy(true);
    setError("");
    try {
      await send({ source: "instagram", title: "", parts: Object.values(t.files).map((b) => JSON.parse(text(b)) as unknown) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (files: File[]) => {
    setBusy(true);
    setError("");
    setDone(null);
    setThreads([]);
    try {
      const first = files[0]!;
      if (/\.zip$/i.test(first.name)) {
        const found = await unzipSome(first, (n) => /\.txt$/i.test(n) || /messages\/(inbox|message_requests)\/[^/]+\/message_\d+\.json$/i.test(n));
        const txt = Object.keys(found).find((n) => /\.txt$/i.test(n));
        if (txt) {
          await send({ source: "whatsapp", title: waTitle(/_chat\.txt$/i.test(txt) ? first.name : txt), text: text(found[txt]!) });
        } else {
          const by = new Map<string, Thread>();
          for (const [name, data] of Object.entries(found)) {
            const folder = /messages\/(?:inbox|message_requests)\/([^/]+)\//i.exec(name)?.[1] ?? "";
            const t = by.get(folder) ?? { folder, files: {}, bytes: 0 };
            t.files[name] = data;
            t.bytes += data.length;
            by.set(folder, t);
          }
          const list = [...by.values()].sort((a, b) => b.bytes - a.bytes);
          if (!list.length) throw new Error(L("לא מצאתי בקובץ ה-zip שיחת WhatsApp (.txt) או שיחות Instagram (messages/inbox, בפורמט JSON).", "The zip has no WhatsApp chat (.txt) and no Instagram chats (messages/inbox, in JSON format)."));
          if (list.length === 1) await importThread(list[0]!);
          else setThreads(list);
        }
      } else if (/\.json$/i.test(first.name)) {
        const parts = await Promise.all(files.filter((f) => /\.json$/i.test(f.name)).map((f) => f.text().then((t) => JSON.parse(t) as unknown)));
        await send({ source: "instagram", title: "", parts });
      } else {
        await send({ source: "whatsapp", title: waTitle(first.name), text: await first.text() });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  // The folder is "<name>_<number>": show the name.
  const shown = threads.filter((t) => t.folder.toLowerCase().includes(filter.toLowerCase())).slice(0, 40);
  return (
    <section className="card stack">
      <h2>{L("ייבוא שיחות עם אנשים (WhatsApp, Instagram)", "Import chats with people (WhatsApp, Instagram)")}</h2>
      <p className="muted">{L("מביא שיחה שלמה לקשר כדי שמודל יקרא וינתח אותה. השיחה נשמרת במחשב הזה כבסיס ידע, ושום דבר לא נשלח החוצה. אלה גם המילים של אנשים אחרים: אם תבחרו מודל ענן, הקטעים שהצ'אט קורא נשלחים לספק שלו.", "Brings a whole chat into KesherAI so a model can read and analyse it. It is kept on this computer as a knowledge base, and nothing is sent out. These are other people's words too: with a cloud model, the passages a chat reads go to its provider.")}</p>
      <ul className="muted small">
        <li><strong>WhatsApp</strong>: {L("בשיחה: ⋮ ← עוד ← ייצוא צ'אט ← בלי מדיה. העלו את קובץ ה-txt או ה-zip.", "In the chat: ⋮ → More → Export chat → Without media. Upload the .txt or the zip.")}</li>
        <li><strong>Instagram</strong>: {L("הגדרות ← מרכז החשבונות ← המידע וההרשאות שלך ← הורדת המידע שלך, רק \"הודעות\", בפורמט JSON. העלו את ה-zip ובחרו שיחה, או את קובצי message_1.json של שיחה אחת.", "Settings → Accounts Center → Your information and permissions → Download your information, only \"Messages\", in JSON format. Upload the zip and choose a chat, or one chat's message_1.json files.")}</li>
      </ul>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? L("מייבא…", "Importing…") : L("בחר קובץ (txt, zip, json)", "Choose a file (txt, zip, json)")}</button>
        <input ref={input} type="file" multiple accept=".txt,.zip,.json,text/plain,application/zip,application/json" hidden onChange={(e) => e.target.files?.length && void pick([...e.target.files])} />
      </div>
      {threads.length > 0 && (
        <div className="stack">
          <p>{L(`נמצאו ${threads.length} שיחות. בחרו איזו לייבא:`, `${threads.length} chats were found. Choose one to import:`)}</p>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={L("חיפוש לפי שם", "Search by name")} aria-label={L("חיפוש לפי שם", "Search by name")} />
          <div className="list">
            {shown.map((t) => (
              <div key={t.folder} className="row">
                <span className="grow" dir="auto">{t.folder.replace(/_\d+$/, "")}</span>
                <span className="muted small" dir="ltr">{t.bytes > 1024 * 1024 ? `${(t.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(t.bytes / 1024))} KB`}</span>
                <button type="button" disabled={busy} onClick={() => void importThread(t)}>{L("ייבא", "Import")}</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {done && (
        <div className="stack">
          <p className="pill good" style={{ alignSelf: "flex-start" }}>{done.replaced ? L("השיחה עודכנה", "The chat was updated") : L("השיחה יובאה", "The chat was imported")}: <span dir="auto">{done.name}</span></p>
          <p dir="auto">{L(`${done.messages} הודעות, מ-${done.from || "?"} עד ${done.to || "?"}.`, `${done.messages} messages, from ${done.from || "?"} to ${done.to || "?"}.`)} {done.people.slice(0, 5).map((p) => `${p.name} (${p.messages})`).join(", ")}</p>
          <p className="muted small">{L("היא מופיעה בדף \"ידע\". בצ'אט חדש, בחרו את הפרסונה שמנתחת ובקשו ממנה לקרוא את השיחה הזאת לפי השם שלה: המודל מחפש בה וקורא את הסיכום שלה. האינדקס נבנה ברקע, ובשיחה ארוכה זה לוקח כמה דקות.", "It shows on the Knowledge page. In a new chat, choose the persona that analyses and ask it to read this chat by its name: the model searches it and reads its summary. The index is built in the background; for a long chat that takes a few minutes.")}</p>
          <div className="row"><a className="button" href="#/knowledge">{L("לדף הידע", "Open Knowledge")}</a><a className="button" href="#/">{L("צ'אט חדש", "New chat")}</a></div>
        </div>
      )}
      {error && <p className="error" dir="auto">{error}</p>}
    </section>
  );
}
