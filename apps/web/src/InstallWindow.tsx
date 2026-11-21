import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { InstallDialog, installSize, type InstallView } from "./chat/InstallOffer";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One open request for the Install window, and how its promise ends. */
interface Ask {
  id: string;
  why: string;
  done: (installed: boolean) => void;
}

let current: Ask | null = null;
/** Requests waiting for the open window to close. */
const queue: Ask[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Opens the next waiting request, if any. */
const next = () => {
  current = queue.shift() ?? null;
  emit();
};

/**
 * Shows the Install window for something missing and waits for the answer (the editors' "Edit in…" when the other
 * editor is not installed; the action goes on after it). A second request while one is open waits for the first.
 *
 * @param id - The installable's id (installables.ts; an editor's id is its plugin id).
 * @param why - What the person was doing, one short line.
 * @returns true once it is installed; false when the person cancels.
 */
export function requestInstall(id: string, why: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ask: Ask = { id, why, done: (ok) => { resolve(ok); next(); } };
    if (current) queue.push(ask);
    else {
      current = ask;
      emit();
    }
  });
}

/**
 * Mounted once in the app: draws the Install window for {@link requestInstall}. The install runs on the computer (also
 * when pressed on the phone); the window waits for it to finish, and the promise then resolves.
 */
export function InstallWindowHost() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return current ? <InstallAsk key={current.id} ask={current} /> : null;
}

/** The window for one request: loads the facts, installs, polls until it is ready. */
function InstallAsk({ ask }: { ask: Ask }) {
  const [info, setInfo] = useState<InstallView | null>(null);
  const [state, setState] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void api<InstallView>(`/api/installables/${encodeURIComponent(ask.id)}`).then((v) => alive && setInfo(v), () => alive && ask.done(false));
    return () => void (alive = false);
  }, [ask]);
  const name = info ? (getLocale() === "he" ? he$(info.he) : info.en) : ask.id;
  const install = async () => {
    setState("starting");
    setError("");
    try {
      let v = await api<InstallView>(`/api/installables/${encodeURIComponent(ask.id)}/install`, { method: "POST", body: {} });
      // Editors need no download (a moment); anything bigger is waited for up to ten minutes here.
      for (let i = 0; i < 200 && !v.ready; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        v = await api<InstallView>(`/api/installables/${encodeURIComponent(ask.id)}`);
      }
      ask.done(v.ready);
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };
  return (
    <InstallDialog
      info={info}
      name={name}
      size={installSize(info)}
      starting={state === "starting"}
      error={error}
      why={ask.why}
      note={L("אחרי ההתקנה הפעולה ממשיכה לבד.", "When it is installed, what you were doing goes on by itself.")}
      onInstall={() => void install()}
      onCancel={() => ask.done(false)}
      onNavigate={() => ask.done(false)}
    />
  );
}
