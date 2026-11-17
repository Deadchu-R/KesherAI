import { useRef, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Base64 of a file, in pieces (a big file would overflow one call). */
async function base64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * "Bring in a file" for the documents, slides and sheets lists (canvas documents, others as options): a Word, PDF,
 * PowerPoint, Excel, CSV, Markdown or text file becomes KesherAI's own, and opens.
 */
export function ImportFile({ accept, label }: { accept: string; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f: File) => {
    if (f.size > 30 * 1024 * 1024) return toast(L("הקובץ גדול מ-30MB.", "The file is larger than 30 MB."));
    setBusy(true);
    try {
      const r = await api<{ hash: string }>("/api/import", { method: "POST", body: { name: f.name, data: await base64(f) } });
      location.hash = r.hash;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <>
    <button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? L("מייבא…", "Bringing in…") : label}</button>
    <input ref={input} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
  </>;
}
