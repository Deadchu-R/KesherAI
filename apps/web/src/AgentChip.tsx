import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from "./ui/Menu";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface AgentOption { id: string; name: string; category?: string; current: string; choices: Array<{ value: string; name: string; description?: string }> }

/**
 * The model chip of a code chat answered by an outside agent (Antigravity): its own choices — the models on
 * the user's account and its thinking level — read from the agent when the menu opens.
 *
 * @param props.convId - The chat.
 * @param props.modelId - e.g. "agent/antigravity".
 */
export function AgentChip({ convId, modelId }: { convId?: string; modelId: string }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<AgentOption[] | null>(null);
  const [err, setErr] = useState("");
  const name = modelId === "agent/antigravity" ? "Antigravity" : modelId.slice(6);
  useEffect(() => {
    if (!open || !convId || opts) return;
    setErr("");
    void api<{ options: AgentOption[] }>(`/api/conversations/${convId}/agent-options`).then((r) => setOpts(r.options), (e: Error) => setErr(e.message));
  }, [open, convId, opts]);
  const model = opts?.find((o) => o.category === "model");
  const current = model?.choices.find((c) => c.value === model.current)?.name;
  const pick = (o: AgentOption, value: string) =>
    void api<{ options: AgentOption[] }>(`/api/conversations/${convId}/agent-options`, { method: "PUT", body: { configId: o.id, value } }).then((r) => setOpts(r.options), (e: Error) => toast(e.message));
  return (
    <Menu
      triggerClassName="model-chip"
      title={L(`${name}: הסוכן של Google עונה בשיחה הזו, עם הכלים שלו`, `${name}: Google's agent answers in this chat, with its own tools`)}
      open={open}
      onOpenChange={setOpen}
      trigger={<>✦ {name}{current ? ` · ${current}` : ""}</>}
    >
      {!convId ? (
        <MenuNote>{L("שלח הודעה ראשונה כדי לבחור מודל.", "Send a first message to choose a model.")}</MenuNote>
      ) : err ? (
        <MenuNote>{err}</MenuNote>
      ) : !opts ? (
        <MenuNote>{L(`מתחבר ל־${name}…`, `Connecting to ${name}…`)}</MenuNote>
      ) : !opts.length ? (
        <MenuNote>{L("הסוכן לא מציע בחירות.", "The agent offers no choices.")}</MenuNote>
      ) : (
        opts.map((o, i) => (
          <div key={o.id} role="group" aria-label={o.name}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{o.category === "model" ? L("מודל", "Model") : o.category === "thought_level" ? L("רמת חשיבה", "Thinking") : o.name}</MenuLabel>
            {o.choices.map((c) => (
              <MenuItem key={c.value} kind="radio" checked={c.value === o.current} title={c.description} onSelect={() => pick(o, c.value)}>{c.name}</MenuItem>
            ))}
          </div>
        ))
      )}
    </Menu>
  );
}
