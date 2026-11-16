import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { desktop, toast } from "./library";
import { COMPUTERS_EVENT } from "./computers";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Tab { key: string; name: string; online: boolean; open: () => Promise<{ error?: string }> }

/**
 * Tabs for the user's other computers, in the top bar (desktop app only, and only when there is another computer).
 * This one is the selected tab; another opens in its own window, or comes to the front if it is open already.
 */
export function ComputerTabs({ host }: { host: string }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  useEffect(() => {
    const bridge = desktop();
    if (!bridge || isRemote()) return;
    let alive = true;
    const load = async () => {
      const [mine, linked] = await Promise.all([
        api<{ devices: Array<{ id: string; name: string; online: boolean; me: boolean }> }>("/api/devices").catch(() => ({ devices: [] })),
        bridge.computers?.().catch(() => []) ?? Promise.resolve([]),
      ]);
      if (!alive) return;
      setTabs([
        ...mine.devices.filter((d) => !d.me && bridge.openDevice).map((d) => ({ key: `d:${d.id}`, name: d.name, online: d.online, open: () => bridge.openDevice!(d.id) })),
        ...linked.filter(() => !!bridge.openComputer).map((c) => ({ key: `c:${c.origin}`, name: c.name, online: true, open: () => bridge.openComputer!(c.origin) })),
      ]);
    };
    void load();
    const id = setInterval(load, 60_000);
    addEventListener(COMPUTERS_EVENT, load);
    return () => {
      alive = false;
      clearInterval(id);
      removeEventListener(COMPUTERS_EVENT, load);
    };
  }, []);
  if (!tabs.length) return null;
  return (
    <nav className="pc-tabs" role="tablist" aria-label={L("המחשבים שלי", "My computers")}>
      <button type="button" role="tab" aria-selected="true" className="on">
        <span className="hub-led ok" aria-hidden />
        <span dir="auto">{L("המחשב הזה", "This computer")}{host ? ` · ${host}` : ""}</span>
      </button>
      {tabs.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected="false"
          disabled={!o.online}
          title={o.online ? L("נפתח בחלון משלו", "Opens in its own window") : L("לא זמין כרגע", "Not reachable now")}
          onClick={() => void o.open().then((r) => r.error && toast(r.error), (e: Error) => toast(e.message))}
        >
          <span className={`hub-led ${o.online ? "ok" : "off"}`} aria-hidden />
          <span dir="auto">{o.name}</span>
          <span className="muted" aria-hidden>{o.online ? "↗" : L("· לא זמין", "· offline")}</span>
        </button>
      ))}
    </nav>
  );
}
