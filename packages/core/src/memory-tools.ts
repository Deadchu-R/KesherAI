import type { AgentTool } from "@kesher/agent";
import type { Coach } from "./coach.js";

/**
 * The user's memory as tools: `remember` when the user asks to keep
 * something for next time, `forget` when they ask to drop it. The memory is
 * shown and edited on the Memory page.
 *
 * @param coach - Keeps the notes.
 * @returns The tools.
 */
export function memoryTools(coach: Pick<Coach, "profile" | "save">): AgentTool[] {
  return [
    {
      risk: "read",
      spec: {
        name: "remember",
        description: "Keep a short note about the user for future chats, only when they ask you to remember something (their name, a preference, how they work). One fact per call; no passwords, card numbers or health details.",
        inputSchema: { type: "object", properties: { note: { type: "string", description: "The fact, in a short sentence." } }, required: ["note"] },
      },
      async run(input) {
        const note = String(input.note ?? "").trim().slice(0, 300);
        if (!note) throw new Error("Nothing to remember.");
        if (/\b\d{12,19}\b|password|סיסמ/i.test(note)) throw new Error("KesherAI does not keep passwords or card numbers in memory.");
        const p = await coach.profile();
        if (!p.notes.some((n) => n.toLowerCase() === note.toLowerCase())) p.notes.push(note);
        await coach.save({ ...p, notes: p.notes.slice(-60), updatedAt: new Date().toISOString() });
        return { output: `Remembered: ${note} (the user can see and edit it on the Memory page).` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "forget",
        description: "Remove notes about the user from memory when they ask you to forget something. Removes every note that contains the given words.",
        inputSchema: { type: "object", properties: { about: { type: "string", description: "Words from the note(s) to forget." } }, required: ["about"] },
      },
      async run(input) {
        const about = String(input.about ?? "").trim().toLowerCase();
        if (!about) throw new Error("Say what to forget.");
        const p = await coach.profile();
        const kept = p.notes.filter((n) => !n.toLowerCase().includes(about));
        const removed = p.notes.length - kept.length;
        await coach.save({ ...p, notes: kept, updatedAt: new Date().toISOString() });
        return { output: removed ? `Forgot ${removed} note(s).` : "No note matched." };
      },
    },
  ];
}
