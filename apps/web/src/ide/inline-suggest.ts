import * as monaco from "monaco-editor";
import { api } from "../api";

/**
 * Copilot-style suggestions in every code editor of KesherAI: a short pause
 * after typing asks the model chosen in Settings (Code suggestions) for what
 * comes next; it shows greyed out, Tab inserts it, Esc or typing on dismisses
 * it. Nothing is asked when no model is chosen there.
 */
let registered = false;
let off = false;
export function registerInlineSuggestions(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, {
    async provideInlineCompletions(model, pos, _ctx, token) {
      if (off) return { items: [] };
      // Wait for a pause in typing; a newer keystroke cancels this one.
      await new Promise((r) => setTimeout(r, 450));
      if (token.isCancellationRequested) return { items: [] };
      const line = model.getLineContent(pos.lineNumber);
      // Not in the middle of a word (the editor's own suggestions handle that).
      if (/\w/.test(line[pos.column - 1] ?? "")) return { items: [] };
      const full = model.getFullModelRange();
      const prefix = model.getValueInRange(new monaco.Range(1, 1, pos.lineNumber, pos.column));
      const suffix = model.getValueInRange(new monaco.Range(pos.lineNumber, pos.column, full.endLineNumber, full.endColumn));
      const ctl = new AbortController();
      token.onCancellationRequested(() => ctl.abort());
      const r = await api<{ text: string; off?: boolean }>("/api/code/complete", { method: "POST", body: { prefix, suffix, language: model.getLanguageId(), path: model.uri.path }, signal: ctl.signal }).catch(() => ({ text: "" }) as { text: string; off?: boolean });
      if (r.off) {
        // Turned off in Settings: ask again only after a while.
        off = true;
        setTimeout(() => (off = false), 60_000);
      }
      if (!r.text || token.isCancellationRequested) return { items: [] };
      return { items: [{ insertText: r.text, range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column) }] };
    },
    disposeInlineCompletions() {
      // nothing kept
    },
  });
}
