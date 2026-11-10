import type { ReactNode } from "react";
import type { PermissionMode } from "@kesher/shared";
import { AddMenu, type AddMenuProps } from "./AddMenu";
import { t } from "./i18n";
import { Mic } from "./Mic";
import { ModelMenu } from "./ModelMenu";
import { PersonaChip, type Persona } from "./Personas";
import { WebToggle } from "./WebToggle";
import { Select } from "./ui/Select";

/**
 * The row under every chat box (start screen, chat, code start), one
 * component so a new button shows everywhere at once: + (attachments and
 * tools), web search, microphone, persona, model, approvals mode, and send.
 * Each part shows only when its props are given; `extra` adds page-only
 * chips (Unity, voice mode), `send` replaces the send button (stop/queue).
 */
export function ComposerBar(p: {
  /** The + menu's attachments (from useChatAttach). */
  attach: Pick<AddMenuProps, "onFiles" | "onPhoto" | "onAnnotate" | "onProject" | "onGameProject" | "onScript" | "convId">;
  /** Adds text to the box (the + menu's pages, skills, research…). */
  onInsert: (text: string) => void;
  web: boolean;
  onWeb: (on: boolean) => void;
  /** Dictation into the box; omit to hide the microphone. */
  onDictate?: (text: string) => void;
  persona?: { value: string | undefined; onChange: (p: Persona | null) => void };
  model?: { models: Parameters<typeof ModelMenu>[0]["models"]; value: string; onChange: (id: string) => void };
  mode?: { value: PermissionMode; onChange: (m: PermissionMode) => void };
  extra?: ReactNode;
  /** The send button(s); default: one ↑ that is off while empty or busy. */
  send?: ReactNode;
  canSend?: boolean;
}) {
  return (
    <div className="box-bar">
      <AddMenu {...p.attach} onInsert={p.onInsert} web={p.web} onWeb={p.onWeb} {...(p.mode ? { mode: p.mode.value, onMode: p.mode.onChange } : {})} />
      <WebToggle on={p.web} onChange={p.onWeb} />
      {p.extra}
      {p.onDictate && <Mic onText={p.onDictate} />}
      {p.persona && <PersonaChip value={p.persona.value} onChange={p.persona.onChange} />}
      {p.model && <ModelMenu models={p.model.models} value={p.model.value} onChange={p.model.onChange} />}
      {p.mode && (
        <Select className="model-chip" value={p.mode.value} onChange={(e) => p.mode!.onChange(e.target.value as PermissionMode)} aria-label={t("mode")}>
          <option value="plan">{t("modePlan")}</option>
          <option value="ask">{t("modeAsk")}</option>
          <option value="auto-edit">{t("modeAutoEdit")}</option>
          <option value="auto">{t("modeAuto")}</option>
        </Select>
      )}
      <span className="grow" />
      {p.send ?? <button type="submit" className="primary send" disabled={!p.canSend} aria-label={t("send")}>↑</button>}
    </div>
  );
}
