import { useEffect, useRef, useState } from "react";
import { withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { overlayPercent, type ActedOn, type Frame, type StepAction } from "./step-fold";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What a step did, drawn over the picture: a ring at the click, a chip with the typed text, or an arrow for a scroll. */
function ActionMark({ action, frame, big }: { action: StepAction; frame: Frame; big?: boolean }) {
  const pos = overlayPercent({ x: action.x ?? frame.w / 2, y: action.y ?? frame.h / 2 }, frame);
  const arrow = { up: "↑", down: "↓", left: "←", right: "→" }[action.dir ?? "down"];
  return (
    <span className={`shot-mark ${action.kind}${big ? " big" : ""}`} style={{ left: `${pos.left}%`, top: `${pos.top}%` }} aria-hidden>
      {action.kind === "type" ? <bdi className="shot-typed" dir="auto">{action.text}</bdi> : action.kind === "scroll" ? arrow : null}
    </span>
  );
}

/**
 * A screenshot as a small thumbnail (at most 240 px wide, loaded lazily, so a phone on a remote connection only
 * fetches what is on screen). Tap or Enter opens it large with the step's action drawn on it.
 *
 * @param props.id - The picture's asset id.
 * @param props.alt - A short description.
 * @param props.acted - The action this picture was acted on with, when the step has coordinates.
 */
export function ShotThumb({ id, alt, acted }: { id: string; alt: string; acted?: ActedOn | undefined }) {
  const [open, setOpen] = useState(false);
  const [natural, setNatural] = useState<Frame>();
  const frame = acted?.frame ?? natural;
  const src = withToken(`/api/assets/${id}`);
  return (
    <>
      <button type="button" className="shot-thumb" onClick={() => setOpen(true)} aria-label={`${L("הגדלה", "Enlarge")}: ${alt}`} aria-haspopup="dialog">
        <span className="shot-frame" dir="ltr">
          <img src={src} alt="" loading="lazy" decoding="async" onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {acted && frame && <ActionMark action={acted.action} frame={frame} />}
        </span>
      </button>
      {open && <ShotLightbox src={src} alt={alt} {...(acted ? { action: acted.action } : {})} {...(frame ? { frame } : {})} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The picture large, over the chat, with the action on it. Esc, a tap outside the picture or Close ends it; focus
 * goes to Close when it opens and back to the thumbnail when it ends.
 */
export function ShotLightbox({ src, alt, action, frame, onClose }: { src: string; alt: string; action?: StepAction; frame?: Frame; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const [natural, setNatural] = useState<Frame>();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      before?.focus?.();
    };
  }, [onClose]);
  const f = frame ?? natural;
  return (
    <div className="shot-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <button ref={close} type="button" className="shot-close" onClick={onClose} aria-label={L("סגירה", "Close")}>✕</button>
      <span className="shot-frame big" dir="ltr" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {action && f && <ActionMark action={action} frame={f} big />}
      </span>
    </div>
  );
}
