import { useEffect, useRef, useState } from "react";
import { APPEARANCE_COLORS, APPEARANCE_FONTS, APPEARANCE_PRESETS, HOME_SECTIONS, PHONE_TABS, resolveAppearance, type Appearance, type AppearanceColor } from "@kesher/shared";
import { api, withToken } from "./api";
import { applyAppearance, saveAppearance, undoAppearance, useAppearance } from "./appearance";
import { getLocale, t } from "./i18n";
import { NAV_GROUPS, NAV_ICONS } from "./Sidebar";
import { toast } from "./library";
import { exportTheme, importTheme, lookFromPicture, lookFromTokens } from "./themeFiles";
import { ToolIcon } from "./ToolIcon";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

const COLOR_NAMES: Record<AppearanceColor, [string, string]> = {
  bg: ["רקע", "Background"],
  panel: ["כרטיסים", "Cards"],
  "panel-2": ["שדות ותפריטים", "Fields and menus"],
  raised: ["ריחוף", "Hover"],
  text: ["טקסט", "Text"],
  muted: ["טקסט משני", "Secondary text"],
  accent: ["צבע מבטא", "Accent"],
};

const HOME_NAMES: Record<string, [string, string]> = { ideas: ["רעיונות", "Ideas"], recent: ["צ'אטים אחרונים", "Recent chats"], pins: ["כלים שהצמדת", "Your pinned tools"] };
const TAB_NAMES: Record<string, [string, string]> = { chats: ["צ'אטים", "Chats"], new: ["חדש", "New"], tools: ["כלים", "Tools"], settings: ["הגדרות", "Settings"] };

/** The default colours (styles.css), for the pickers when nothing is set. */
const DEFAULTS: Record<AppearanceColor, string> = { bg: "#121213", panel: "#18181a", "panel-2": "#1f1f22", raised: "#29292d", text: "#ededee", muted: "#94949c", accent: "#98a3ff" };

/**
 * Settings → Appearance: ready-made looks, colours, font, sizes, spacing,
 * background and the order of the tool groups — or say it in words and the
 * local model changes it (the chat's change_look tool). Undo keeps the last ten.
 */
export function AppearanceSection() {
  const saved = useAppearance();
  const [canUndo, setCanUndo] = useState(false);
  const [words, setWords] = useState("");
  const [cssDraft, setCssDraft] = useState<string | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const look = resolveAppearance(saved);

  const [myLooks, setMyLooks] = useState<Array<{ name: string; appearance: Appearance }>>([]);
  const [lookName, setLookName] = useState("");
  const [picStyle, setPicStyle] = useState("");
  const [picBusy, setPicBusy] = useState(false);
  const findPictures = () => {
    const style = picStyle.trim();
    if (!style || picBusy) return;
    setPicBusy(true);
    void api<{ appearance: Appearance; canUndo: boolean; credits: string[] }>("/api/appearance/pictures", { method: "POST", body: { style } })
      .then((r) => {
        applyAppearance(r.appearance);
        setCanUndo(r.canUndo);
        toast(L(`נמצאו תמונות: ${r.credits.join(" · ")}`, `Found pictures: ${r.credits.join(" · ")}`));
      }, (e: Error) => toast(e.message))
      .finally(() => setPicBusy(false));
  };

  useEffect(() => {
    void api<{ canUndo: boolean }>("/api/appearance").then((r) => setCanUndo(r.canUndo), () => undefined);
    void api<{ looks: Array<{ name: string; appearance: Appearance }> }>("/api/appearance/saved").then((r) => setMyLooks(r.looks), () => undefined);
  }, []);
  const saveLook = () => {
    const name = lookName.trim() || saved.name || L("המראה שלי", "My look");
    void api<{ looks: Array<{ name: string; appearance: Appearance }> }>("/api/appearance/saved", { method: "POST", body: { name } }).then((r) => {
      setMyLooks(r.looks);
      setLookName("");
      toast(L(`נשמר: ${name}`, `Saved: ${name}`));
    }, (e: Error) => toast(e.message));
  };
  const deleteLook = (name: string) =>
    void api<{ looks: Array<{ name: string; appearance: Appearance }> }>(`/api/appearance/saved?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) => setMyLooks(r.looks), (e: Error) => toast(e.message));
  const swatch = (a: Appearance) => {
    const c = { ...DEFAULTS, ...APPEARANCE_PRESETS.find((p) => p.id === (a.preset ?? "graphite"))?.look.colors, ...a.colors };
    const bg = a.background;
    const background = bg?.kind === "gradient" ? `linear-gradient(${bg.angle ?? 160}deg, ${bg.from}, ${bg.to})` : bg?.kind === "image" ? `center / cover url("${withToken(`/api/assets/${bg.assetId}`)}"), ${c.bg}` : c.bg;
    return (
      <span className="look-swatch" style={{ background }}>
        <i style={{ background: c.panel }} />
        <i style={{ background: c.accent }} />
        <b style={{ color: c.text }}>Aa</b>
      </span>
    );
  };

  /** Shows a change at once; saves it a moment later (sliders and colour pickers send many). */
  const change = (next: Appearance, now = false) => {
    applyAppearance(next);
    window.clearTimeout(timer.current);
    const save = () => void saveAppearance(next).then(setCanUndo, (e: Error) => toast(e.message));
    if (now) save();
    else timer.current = window.setTimeout(save, 450);
  };
  const patch = (p: Partial<Appearance>, now = false) => change({ ...saved, ...p }, now);
  const setColor = (k: AppearanceColor, v: string) => patch({ colors: { ...saved.colors, [k]: v } });
  const groupOrder = [...(look.navOrder ?? []), ...NAV_GROUPS.map((g) => g.id)].filter((id, i, a) => a.indexOf(id) === i && NAV_GROUPS.some((g) => g.id === id));
  const homeOrder = [...(look.homeOrder ?? []), ...HOME_SECTIONS].filter((x, i, a) => a.indexOf(x) === i);
  const tabsOrder = look.tabsOrder ?? [...PHONE_TABS];
  const moveIn = <T,>(list: T[], id: T, d: -1 | 1, done: (o: T[]) => void) => {
    const o = [...list];
    const i = o.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    done(o);
  };
  const move = (id: string, d: -1 | 1) => {
    const o = [...groupOrder];
    const i = o.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    patch({ navOrder: o }, true);
  };
  /** A picture from this computer or phone: made smaller and kept in the library. Returns its id. */
  const uploadPicture = async (file: File | undefined, max = 2560): Promise<string | undefined> => {
    if (!file) return undefined;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      // Icons keep see-through parts (PNG); backgrounds are smaller as JPEG.
      const mimeType = max <= 512 ? "image/png" : "image/jpeg";
      const data = canvas.toDataURL(mimeType, 0.86).split(",")[1]!;
      return (await api<{ assetId: string }>("/api/appearance/background", { method: "POST", body: { data, mimeType } })).assetId;
    } catch (e) {
      toast((e as Error).message || L("לא הצלחתי לקרוא את התמונה.", "Could not read that picture."));
      return undefined;
    }
  };
  const pickPicture = async (file: File | undefined) => {
    const assetId = await uploadPicture(file);
    if (assetId) patch({ background: { kind: "image", assetId, dim: 55 } }, true);
  };
  const askInWords = () => {
    const text = words.trim();
    if (!text) return;
    location.hash = `#/?ask=${encodeURIComponent(L(`שנה את המראה של KesherAI: ${text}`, `Change how KesherAI looks: ${text}`))}`;
  };

  return (
    <section className="card stack look">
      <div className="row">
        <h2 className="grow">{L("מראה", "Appearance")}</h2>
        <button type="button" disabled={!canUndo} onClick={() => void undoAppearance().then(setCanUndo, (e: Error) => toast(e.message))}>{L("בטל שינוי", "Undo")}</button>
        <button type="button" onClick={() => { change({}, true); toast(L("העיצוב אופס לברירת המחדל. \"בטל שינוי\" מחזיר.", "Back to the default look. Undo brings yours back.")); }}>↺ {L("איפוס עיצוב לברירת מחדל", "Reset to the default look")}</button>
      </div>

      <small className="muted">{L("כל שינוי כאן חל מיד ונשמר לבד, בלי כפתור אישור. \"בטל שינוי\" מחזיר צעד אחורה.", "Every change here applies at once and saves itself; no Apply button needed. Undo goes back a step.")}</small>

      <div className="look-words">
        <label htmlFor="look-words">{L("תגיד במילים, והמודל המקומי ישנה", "Say it in words, and the local model changes it")}</label>
        <div className="row">
          <input id="look-words" className="grow" dir="auto" value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => e.key === "Enter" && askInWords()} placeholder={L("למשל: בהיר וחמים, טקסט גדול יותר, פינות מרובעות, עבודה למעלה", "e.g. light and warm, bigger text, square corners, Work on top")} />
          <button type="button" className="primary" disabled={!words.trim()} onClick={askInWords}>{L("שנה", "Change")}</button>
        </div>
        <small className="muted">{L("למשל: \"עצב בסגנון וואן פיס\" או \"תצייר רקע של ים בשקיעה ותשים אותו\". נפתח צ'אט עם הבקשה. אפשר גם לבקש בכל צ'אט, ולהגיד \"בטל\" כדי לחזור.", "Opens a chat with the request. You can also ask in any chat, and say \"undo\" to go back.")}</small>
      </div>

      <h3>{L("רקע ואייקונים מהאינטרנט", "Background and icons from the web")}</h3>
      <div className="row">
        <input className="grow" dir="auto" maxLength={80} value={picStyle} onChange={(e) => setPicStyle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && findPictures()} placeholder={L("למשל: One Piece, Naruto, Tokyo night (באנגלית עובד הכי טוב)", "e.g. One Piece, Naruto, Tokyo night")} aria-label={L("מה לחפש", "What to look for")} />
        <button type="button" className="primary" disabled={picBusy || !picStyle.trim()} onClick={findPictures}>{picBusy ? L("מחפש…", "Searching…") : L("מצא ושים", "Find and use")}</button>
      </div>
      <small className="muted">{L("KesherAI מחפש ברשת (חיפוש תמונות עם סינון בטוח) טפט לרקע ואייקונים לכלים, ושם אותם מיד. התמונות נשמרות במחשב שלך, לשימוש שלך. \"בטל שינוי\" מחזיר. אפשר גם להעלות תמונה משלך למטה.", "KesherAI searches the web (picture search, safe search on) for a wallpaper and tool icons and applies them at once. They are kept on your computer, for your own screen. Undo brings back the previous look. You can also upload your own picture below.")}</small>

      <h3>{L("המראות שלי", "My looks")}</h3>
      <div className="row">
        <input className="grow" dir="auto" maxLength={60} value={lookName} onChange={(e) => setLookName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveLook()} placeholder={saved.name ?? L("שם למראה, למשל: וואן פיס", "A name, e.g. One Piece")} aria-label={L("שם למראה", "Look name")} />
        <button type="button" className="primary" onClick={saveLook}>{L("שמור את המראה הנוכחי", "Save this look")}</button>
      </div>
      {myLooks.length > 0 ? (
        <div className="look-presets">
          {myLooks.map((l) => (
            <span key={l.name} className="look-mine">
              <button type="button" className="look-preset" onClick={() => change(l.appearance, true)} title={L("החל", "Apply")}>
                {swatch(l.appearance)}
                <span>{l.name}</span>
              </button>
              <button type="button" className="look-mine-del" aria-label={L(`מחק את ${l.name}`, `Delete ${l.name}`)} onClick={() => deleteLook(l.name)}>✕</button>
            </span>
          ))}
        </div>
      ) : (
        <small className="muted">{L("עוד לא שמרת מראות. עצב כמו שאתה אוהב ושמור בשם, כדי לחזור אליו בלחיצה.", "No saved looks yet. Make one you like and save it by name to come back to it in one tap.")}</small>
      )}

      <h3>{L("מראות מוכנים", "Ready-made looks")}</h3>
      <div className="look-presets">
        {APPEARANCE_PRESETS.map((p) => {
          const c = { ...DEFAULTS, ...p.look.colors };
          const on = (saved.preset ?? "graphite") === p.id && !saved.colors;
          return (
            <button key={p.id} type="button" className={`look-preset${on ? " on" : ""}`} aria-pressed={on} onClick={() => change({ ...saved, preset: p.id, colors: undefined, background: p.look.background }, true)}>
              <span className="look-swatch" style={{ background: p.look.background?.kind === "gradient" ? `linear-gradient(${p.look.background.angle ?? 160}deg, ${p.look.background.from}, ${p.look.background.to})` : c.bg }}>
                <i style={{ background: c.panel }} />
                <i style={{ background: c.accent }} />
                <b style={{ color: c.text }}>Aa</b>
              </span>
              <span>{getLocale() === "he" ? p.title.he : p.title.en}</span>
            </button>
          );
        })}
      </div>

      <h3>{L("צבעים", "Colours")}</h3>
      <div className="look-colors">
        {APPEARANCE_COLORS.map((k) => (
          <label key={k} className="look-color">
            <input type="color" value={look.colors?.[k] ?? DEFAULTS[k]} onChange={(e) => setColor(k, e.target.value)} />
            <span>{L(...COLOR_NAMES[k])}</span>
          </label>
        ))}
      </div>

      <h3>{L("טקסט וצורה", "Text and shape")}</h3>
      <div className="look-grid">
        <label>
          {L("גופן", "Font")}
          <select value={look.font ?? "rubik"} onChange={(e) => patch({ font: e.target.value }, true)}>
            {APPEARANCE_FONTS.map((f) => <option key={f.id} value={f.id}>{f.title}{f.hebrew ? "" : L(" (בלי אותיות עבריות)", "")}</option>)}
          </select>
        </label>
        <label>
          {L("גודל טקסט", "Text size")} <small className="muted">{`⁦${look.fontSize ?? 15}px⁩`}</small>
          <input type="range" min={12} max={20} value={look.fontSize ?? 15} onChange={(e) => patch({ fontSize: Number(e.target.value) })} />
        </label>
        <label>
          {L("עיגול פינות", "Corners")} <small className="muted">{`⁦${look.radius ?? 16}px⁩`}</small>
          <input type="range" min={0} max={28} value={look.radius ?? 16} onChange={(e) => patch({ radius: Number(e.target.value) })} />
        </label>
        <div className="look-field">
          <span>{L("מרווחים", "Spacing")}</span>
          <div className="seg" role="group">
            {(["compact", "normal", "roomy"] as const).map((d) => (
              <button key={d} type="button" className={(look.density ?? "normal") === d ? "on" : ""} aria-pressed={(look.density ?? "normal") === d} onClick={() => patch({ density: d }, true)}>
                {d === "compact" ? L("צפוף", "Compact") : d === "normal" ? L("רגיל", "Normal") : L("מרווח", "Roomy")}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="look-field">
        <span>{L("תנועה", "Motion")}</span>
        <div className="seg" role="group">
          {(["none", "subtle", "lively"] as const).map((m) => (
            <button key={m} type="button" className={(look.motion ?? "subtle") === m ? "on" : ""} aria-pressed={(look.motion ?? "subtle") === m} onClick={() => patch({ motion: m }, true)}>
              {m === "none" ? L("בלי", "None") : m === "subtle" ? L("עדינה", "Subtle") : L("חיה", "Lively")}
            </button>
          ))}
        </div>
        <small className="muted">{L("\"חיה\": רקע שזז לאט, כרטיסים שמתרוממים ומעברי דפים. מי שביקש מהמערכת פחות תנועה לא יקבל אנימציות.", "\"Lively\": a slowly moving background, cards that lift and page transitions. If your system asks for less motion, there is none.")}</small>
      </div>

      <h3>{L("רקע", "Background")}</h3>
      <div className="row wrap">
        <div className="seg" role="group">
          <button type="button" className={look.background?.kind !== "gradient" ? "on" : ""} onClick={() => patch({ background: { kind: "plain" } }, true)}>{L("אחיד", "Plain")}</button>
          <label className={`look-pick${look.background?.kind === "image" ? " on" : ""}`}>
            {L("תמונה…", "Picture…")}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pickPicture(e.target.files?.[0])} />
          </label>
          <button type="button" className={look.background?.kind === "gradient" ? "on" : ""} onClick={() => patch({ background: { kind: "gradient", from: "#1c1d2b", to: look.colors?.bg ?? DEFAULTS.bg, angle: 160 } }, true)}>{L("מעבר צבע", "Gradient")}</button>
        </div>
        {look.background?.kind === "image" && (
          <>
            <img className="look-thumb" src={withToken(`/api/assets/${look.background.assetId}`)} alt="" />
            <label className="look-dim">
              {L("כמה לעמעם", "How much to dim")} <small className="muted">{`\u2066${look.background.dim ?? 55}%\u2069`}</small>
              <input type="range" min={0} max={90} value={look.background.dim ?? 55} onChange={(e) => look.background?.kind === "image" && patch({ background: { ...look.background, dim: Number(e.target.value) } })} />
            </label>
          </>
        )}
        {look.background?.kind === "gradient" && (
          <>
            <label className="look-color"><input type="color" value={look.background.from} onChange={(e) => look.background?.kind === "gradient" && patch({ background: { ...look.background, from: e.target.value } })} /><span>{L("מ-", "From")}</span></label>
            <label className="look-color"><input type="color" value={look.background.to} onChange={(e) => look.background?.kind === "gradient" && patch({ background: { ...look.background, to: e.target.value } })} /><span>{L("עד", "To")}</span></label>
          </>
        )}
      </div>

      <h3>{L("סדר הקבוצות בכל הכלים", "Order of the groups in All tools")}</h3>
      <ol className="look-order">
        {groupOrder.map((id, i) => {
          const g = NAV_GROUPS.find((x) => x.id === id)!;
          const hidden = look.navHide?.includes(id);
          return (
            <li key={id} className={hidden ? "off" : ""}>
              <span className="grow">{g.icon} {t(g.label)}</span>
              <button type="button" aria-label={L("למעלה", "Up")} disabled={i === 0} onClick={() => move(id, -1)}>↑</button>
              <button type="button" aria-label={L("למטה", "Down")} disabled={i === groupOrder.length - 1} onClick={() => move(id, 1)}>↓</button>
              <label className="row small"><input type="checkbox" checked={!hidden} onChange={(e) => patch({ navHide: e.target.checked ? (look.navHide ?? []).filter((x) => x !== id) : [...(look.navHide ?? []), id] }, true)} /> {L("מוצג", "Shown")}</label>
            </li>
          );
        })}
      </ol>

      <h3>{L("מסך הפתיחה (מתחת לתיבת ההודעה)", "Start screen (under the message box)")}</h3>
      <ol className="look-order">
        {homeOrder.map((id, i) => {
          const hidden = look.homeHide?.includes(id);
          return (
            <li key={id} className={hidden ? "off" : ""}>
              <span className="grow">{HOME_NAMES[id] ? L(...HOME_NAMES[id]) : id}</span>
              <button type="button" aria-label={L("למעלה", "Up")} disabled={i === 0} onClick={() => moveIn(homeOrder, id, -1, (o) => patch({ homeOrder: o }, true))}>↑</button>
              <button type="button" aria-label={L("למטה", "Down")} disabled={i === homeOrder.length - 1} onClick={() => moveIn(homeOrder, id, 1, (o) => patch({ homeOrder: o }, true))}>↓</button>
              <label className="row small"><input type="checkbox" checked={!hidden} onChange={(e) => patch({ homeHide: e.target.checked ? (look.homeHide ?? []).filter((x) => x !== id) : [...(look.homeHide ?? []), id] }, true)} /> {L("מוצג", "Shown")}</label>
            </li>
          );
        })}
      </ol>

      <h3>{L("הפס התחתון בטלפון", "The phone's bottom bar")}</h3>
      <ol className="look-order">
        {tabsOrder.map((id, i) => (
          <li key={id}>
            <span className="grow">{L(...(TAB_NAMES[id] ?? [id, id]))}</span>
            <button type="button" aria-label={L("קודם", "Earlier")} disabled={i === 0} onClick={() => moveIn(tabsOrder, id, -1, (o) => patch({ tabsOrder: o }, true))}>↑</button>
            <button type="button" aria-label={L("אחר כך", "Later")} disabled={i === tabsOrder.length - 1} onClick={() => moveIn(tabsOrder, id, 1, (o) => patch({ tabsOrder: o }, true))}>↓</button>
          </li>
        ))}
      </ol>

      <details className="look-more">
        <summary>{L("אייקונים משלך", "Your own icons")}</summary>
        <p className="muted small">{L("לכל כלי: אימוג'י, או תמונה מהמחשב או מהטלפון (לשימוש שלך).", "For each tool: an emoji, or a picture from your computer or phone (for your own use).")}</p>
        <div className="look-icons">
          {NAV_GROUPS.flatMap((g) => g.items).map(([href, key]) => (
            <div key={href} className="look-icon-row">
              <span className="look-icon-now" aria-hidden="true"><ToolIcon href={href} fallback={NAV_ICONS[href] ?? "•"} /></span>
              <span className="grow">{t(key)}</span>
              <input className="look-emoji" aria-label={L("אימוג'י", "Emoji")} maxLength={8} placeholder="🙂" value={saved.icons?.[href] && "emoji" in saved.icons[href]! ? (saved.icons[href] as { emoji: string }).emoji : ""} onChange={(e) => {
                const icons = { ...saved.icons };
                if (e.target.value.trim()) icons[href] = { emoji: e.target.value.trim() };
                else delete icons[href];
                patch({ icons });
              }} />
              <label className="look-pick small">🖼<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void uploadPicture(e.target.files?.[0], 256).then((assetId) => assetId && patch({ icons: { ...saved.icons, [href]: { assetId } } }, true))} /></label>
              {saved.icons?.[href] && <button type="button" aria-label={L("ברירת מחדל", "Default")} onClick={() => { const icons = { ...saved.icons }; delete icons[href]; patch({ icons }, true); }}>↺</button>}
            </div>
          ))}
        </div>
      </details>

      <details className="look-more">
        <summary>{L("CSS משלך (מתקדם)", "Your own CSS (advanced)")}</summary>
        <p className="muted small">{L("למראה בלבד: נשמרים רק כללים, ‎@media‏ ו-‎@keyframes. נמחקים ‎@import, כתובות חיצוניות, קוד ו-position: fixed; תמונות רק מהספרייה (url(\"/api/assets/…\")). אישורים ואזהרות תמיד נשארים גלויים ובצבעים הרגילים.", "Looks only: rules, @media and @keyframes stay; @import, outside addresses, code and position: fixed are removed; pictures only from your library (url(\"/api/assets/…\")). Approvals and warnings always stay visible, in the usual colours.")}</p>
        <textarea className="look-css" dir="ltr" spellCheck={false} rows={8} value={cssDraft ?? saved.css ?? ""} onChange={(e) => setCssDraft(e.target.value)} placeholder={".card { border-width: 2px; }\n@keyframes glow { from { opacity: .8 } to { opacity: 1 } }"} />
        <div className="row">
          <button type="button" className="primary" disabled={cssDraft === null} onClick={() => {
            const next = { ...saved, css: cssDraft ?? "" };
            void saveAppearance(next).then((u) => {
              setCanUndo(u);
              setCssDraft(null);
            }, (e: Error) => toast(e.message));
          }}>{L("החל", "Apply")}</button>
          {saved.css && <button type="button" onClick={() => { setCssDraft(null); patch({ css: "" }, true); }}>{L("מחק את ה-CSS", "Remove the CSS")}</button>}
        </div>
      </details>

      <h3>{L("ערכות ועיצובים", "Themes and designs")}</h3>
      <div className="row wrap">
        <button type="button" onClick={() => void exportTheme(saved).then((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${(saved.name ?? "kesher-look").replace(/[^\w\u0590-\u05ff-]+/g, "-")}.kesher-theme.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }, (e: Error) => toast(e.message))}>{L("שמור כקובץ ערכה", "Save as a theme file")}</button>
        <label className="look-pick">{L("פתח קובץ ערכה…", "Open a theme file…")}<input type="file" accept=".json,application/json" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          void importTheme(f).then((look) => {
            if (look.css && !confirm(L("בערכה יש CSS משלה. הוא ינוקה (למראה בלבד) לפני שיופעל. להמשיך?", "This theme has its own CSS. It is cleaned (looks only) before it applies. Go on?"))) return;
            change(look, true);
          }, (err: Error) => toast(err.message));
        }} /></label>
        <label className="look-pick">{L("ייבוא מפיגמא (Variables / Tokens JSON)…", "Import from Figma (Variables / Tokens JSON)…")}<input type="file" accept=".json,application/json" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          void f.text().then((txt) => {
            const r = lookFromTokens(txt);
            if (!r.found.length) throw new Error(L("לא מצאתי בקובץ צבעים שאני מבין.", "No colours I understand in that file."));
            setFound(r.found);
            change({ ...saved, ...r.look, colors: { ...saved.colors, ...r.look.colors } }, true);
          }).catch((err: Error) => toast(err.message));
        }} /></label>
        <label className="look-pick">{L("צבעים מתמונה של עיצוב…", "Colours from a picture of a design…")}<input type="file" accept="image/*" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void lookFromPicture(f).then((l) => change({ ...saved, preset: undefined, colors: l.colors }, true), (err: Error) => toast(err.message));
        }} /></label>
      </div>
      {found.length > 0 && <p className="muted small" dir="ltr">{found.slice(0, 12).join(" · ")}</p>}
      <small className="muted">{L("מפיגמא: ייצא את ה-Variables (למשל בתוסף \"Export/Import Variables\" או Tokens Studio) כקובץ JSON. צבעים לפי שמות כמו background, surface, text, primary.", "From Figma: export the Variables (for example with the \"Export/Import Variables\" plugin or Tokens Studio) as JSON. Colours are matched by names like background, surface, text, primary.")}</small>
    </section>
  );
}
