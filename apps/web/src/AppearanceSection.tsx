import { useEffect, useRef, useState } from "react";
import { APPEARANCE_COLORS, APPEARANCE_FONTS, APPEARANCE_PRESETS, resolveAppearance, type Appearance, type AppearanceColor } from "@kesher/shared";
import { api, withToken } from "./api";
import { applyAppearance, saveAppearance, undoAppearance, useAppearance } from "./appearance";
import { getLocale, t } from "./i18n";
import { NAV_GROUPS } from "./Sidebar";
import { toast } from "./library";

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
  const timer = useRef<number | undefined>(undefined);
  const look = resolveAppearance(saved);

  useEffect(() => {
    void api<{ canUndo: boolean }>("/api/appearance").then((r) => setCanUndo(r.canUndo), () => undefined);
  }, []);

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
  const move = (id: string, d: -1 | 1) => {
    const o = [...groupOrder];
    const i = o.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    patch({ navOrder: o }, true);
  };
  /** A picture from this computer or phone: made smaller (at most 2560 px wide) and kept in the library. */
  const pickPicture = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.86).split(",")[1]!;
      const { assetId } = await api<{ assetId: string }>("/api/appearance/background", { method: "POST", body: { data, mimeType: "image/jpeg" } });
      patch({ background: { kind: "image", assetId, dim: 55 } }, true);
    } catch (e) {
      toast((e as Error).message || L("לא הצלחתי לקרוא את התמונה.", "Could not read that picture."));
    }
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
        <button type="button" onClick={() => change({}, true)}>{L("חזרה לברירת המחדל", "Default look")}</button>
      </div>

      <div className="look-words">
        <label htmlFor="look-words">{L("תגיד במילים, והמודל המקומי ישנה", "Say it in words, and the local model changes it")}</label>
        <div className="row">
          <input id="look-words" className="grow" dir="auto" value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => e.key === "Enter" && askInWords()} placeholder={L("למשל: בהיר וחמים, טקסט גדול יותר, פינות מרובעות, עבודה למעלה", "e.g. light and warm, bigger text, square corners, Work on top")} />
          <button type="button" className="primary" disabled={!words.trim()} onClick={askInWords}>{L("שנה", "Change")}</button>
        </div>
        <small className="muted">{L("למשל: \"עצב בסגנון וואן פיס\" או \"תצייר רקע של ים בשקיעה ותשים אותו\". נפתח צ'אט עם הבקשה. אפשר גם לבקש בכל צ'אט, ולהגיד \"בטל\" כדי לחזור.", "Opens a chat with the request. You can also ask in any chat, and say \"undo\" to go back.")}</small>
      </div>

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
    </section>
  );
}
