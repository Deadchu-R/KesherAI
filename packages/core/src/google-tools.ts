import type { AgentTool } from "@kesher/agent";
import type { GoogleDrive } from "./google.js";

/**
 * Gmail and Google Calendar as tools for chats and agents, once the user
 * connected them with Google's own sign-in and consent page. Reading runs
 * directly; writing a draft or adding an event asks first. KesherAI never
 * sends email: drafts wait in Gmail for the user to send.
 */

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[]; filename?: string }
interface GmailMessage { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: GmailPart }

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/**
 * Finds the readable text of a message (plain text, else HTML without tags).
 *
 * @param part - The message payload.
 * @returns The text.
 */
export function gmailText(part: GmailPart | undefined): string {
  if (!part) return "";
  const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  const find = (p: GmailPart, type: string): string | undefined => {
    if (p.mimeType === type && p.body?.data) return decode(p.body.data);
    for (const c of p.parts ?? []) {
      const r = find(c, type);
      if (r) return r;
    }
    return undefined;
  };
  const plain = find(part, "text/plain");
  if (plain) return plain;
  const html = find(part, "text/html") ?? decode(part.body?.data);
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Builds an RFC 822 message for a Gmail draft (UTF-8 subject and body).
 *
 * @param d - Recipient, subject, body and optional threading headers.
 * @returns The base64url `raw` value.
 */
export function rawEmail(d: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string }): string {
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
  const lines = [
    `To: ${d.to}`,
    ...(d.cc ? [`Cc: ${d.cc}`] : []),
    `Subject: ${enc(d.subject)}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`, `References: ${d.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(d.body).toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

/**
 * @param g - The signed-in Google account.
 * @returns Tools for the services the user connected.
 */
export function googleTools(g: GoogleDrive): AgentTool[] {
  const tools: AgentTool[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (g.has("gmail")) {
    const base = `${g.base("gmail")}/users/me`;
    tools.push(
      {
        risk: "read",
        spec: {
          name: "gmail_search",
          description: "Search the user's Gmail. `query` uses Gmail search syntax (from:, to:, subject:, newer_than:7d, is:unread, label:). Returns id, from, subject, date and a snippet for each message.",
          inputSchema: { type: "object", properties: { query: { type: "string" }, max: { type: "number", description: "At most this many (default 10, up to 25)." } }, required: ["query"] },
        },
        run: async (input) => {
          const max = Math.min(25, Math.max(1, Number(input.max) || 10));
          const list = await g.api<{ messages?: Array<{ id: string }> }>(`${base}/messages?q=${encodeURIComponent(str(input.query))}&maxResults=${max}`);
          if (!list.messages?.length) return { output: "No messages found." };
          const rows = await Promise.all(
            list.messages.map((m) => g.api<GmailMessage>(`${base}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
          );
          return { output: rows.map((m) => `id: ${m.id}\nfrom: ${header(m, "From")}\nsubject: ${header(m, "Subject")}\ndate: ${header(m, "Date")}${m.labelIds?.includes("UNREAD") ? " (unread)" : ""}\n${m.snippet ?? ""}`).join("\n\n") };
        },
      },
      {
        risk: "read",
        spec: { name: "gmail_read", description: "Read one Gmail message (from gmail_search) in full.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        run: async (input) => {
          const m = await g.api<GmailMessage>(`${base}/messages/${encodeURIComponent(str(input.id))}?format=full`);
          const files = (function walk(p?: GmailPart): string[] { return p ? [...(p.filename ? [p.filename] : []), ...(p.parts ?? []).flatMap(walk)] : []; })(m.payload);
          return { output: `from: ${header(m, "From")}\nto: ${header(m, "To")}\nsubject: ${header(m, "Subject")}\ndate: ${header(m, "Date")}\nmessage-id: ${header(m, "Message-ID")}\nthread: ${m.threadId}${files.length ? `\nattachments: ${files.join(", ")}` : ""}\n\n${gmailText(m.payload).slice(0, 20_000)}` };
        },
      },
      {
        risk: "exec",
        spec: {
          name: "gmail_draft",
          description: "Write an email as a Gmail draft. It is NOT sent: the user reviews and sends it from Gmail. To reply, pass `reply_to` (a message id from gmail_search) so the draft joins that thread.",
          inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, reply_to: { type: "string" } }, required: ["to", "subject", "body"] },
        },
        preview: async (input) => `Save a draft in Gmail (not sent):\nTo: ${str(input.to)}${input.cc ? `\nCc: ${str(input.cc)}` : ""}\nSubject: ${str(input.subject)}\n\n${str(input.body)}`,
        run: async (input) => {
          let threadId: string | undefined;
          let inReplyTo: string | undefined;
          if (str(input.reply_to)) {
            const orig = await g.api<GmailMessage>(`${base}/messages/${encodeURIComponent(str(input.reply_to))}?format=metadata&metadataHeaders=Message-ID`);
            threadId = orig.threadId;
            inReplyTo = header(orig, "Message-ID") || undefined;
          }
          const raw = rawEmail({ to: str(input.to), subject: str(input.subject), body: str(input.body), ...(str(input.cc) ? { cc: str(input.cc) } : {}), ...(inReplyTo ? { inReplyTo } : {}) });
          const d = await g.api<{ id: string }>(`${base}/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }) });
          return { output: `Saved draft ${d.id} in Gmail. It was not sent; the user can review and send it from Gmail's Drafts.` };
        },
      },
    );
  }
  if (g.has("calendar")) {
    const base = `${g.base("calendar")}/calendars/primary/events`;
    tools.push(
      {
        risk: "read",
        spec: {
          name: "calendar_events",
          description: "List events in the user's Google Calendar between `from` and `to` (ISO dates or times; default: the next 7 days). Optional `query` filters by text.",
          inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, query: { type: "string" } } },
        },
        run: async (input) => {
          const from = str(input.from) ? new Date(str(input.from)) : new Date();
          const to = str(input.to) ? new Date(str(input.to)) : new Date(from.getTime() + 7 * 86_400_000);
          if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("from and to must be dates, e.g. 2026-11-09 or 2026-11-09T14:00.");
          const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50", ...(str(input.query) ? { q: str(input.query) } : {}) });
          const r = await g.api<{ items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string; attendees?: Array<{ email: string }>; hangoutLink?: string }> }>(`${base}?${q}`);
          if (!r.items?.length) return { output: "No events in that time." };
          return { output: r.items.map((e) => `${e.start?.dateTime ?? e.start?.date} → ${e.end?.dateTime ?? e.end?.date}: ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}${e.attendees?.length ? `\n  with ${e.attendees.map((a) => a.email).join(", ")}` : ""}${e.hangoutLink ? `\n  ${e.hangoutLink}` : ""}`).join("\n") };
        },
      },
      {
        risk: "exec",
        spec: {
          name: "calendar_add_event",
          description: "Add an event to the user's Google Calendar. `start` and `end` are ISO date-times in the user's time zone (e.g. 2026-11-09T14:00). Guests are added to the event but are not emailed.",
          inputSchema: { type: "object", properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, guests: { type: "array", items: { type: "string" } } }, required: ["title", "start", "end"] },
        },
        preview: async (input) => `Add to Google Calendar:\n${str(input.title)}\n${str(input.start)} → ${str(input.end)}${input.location ? `\n@ ${str(input.location)}` : ""}${Array.isArray(input.guests) && input.guests.length ? `\nGuests (not emailed): ${input.guests.join(", ")}` : ""}`,
        run: async (input) => {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const body = {
            summary: str(input.title),
            ...(str(input.description) ? { description: str(input.description) } : {}),
            ...(str(input.location) ? { location: str(input.location) } : {}),
            start: { dateTime: str(input.start), timeZone: tz },
            end: { dateTime: str(input.end), timeZone: tz },
            ...(Array.isArray(input.guests) ? { attendees: input.guests.map((e) => ({ email: String(e) })) } : {}),
          };
          const e = await g.api<{ id: string; htmlLink?: string }>(`${base}?sendUpdates=none`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          return { output: `Added the event to Google Calendar.${e.htmlLink ? ` ${e.htmlLink}` : ""}` };
        },
      },
    );
  }
  return tools;
}
