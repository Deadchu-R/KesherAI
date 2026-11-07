import { documentText, formatPages, type AgentTool } from "@kesher/agent";
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
  if (g.has("drive")) {
    const api = g.base("drive");
    const FOLDER = "application/vnd.google-apps.folder";
    // Google's own formats are exported as text; other text files are read as they are.
    const EXPORT: Record<string, string> = {
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.google-apps.spreadsheet": "text/csv",
      "application/vnd.google-apps.presentation": "text/plain",
    };
    tools.push(
      {
        risk: "read",
        spec: {
          name: "drive_search",
          description: "Search the user's Google Drive by words in the file name or contents. Returns id, name, type, last change, owner and link. Optional `type`: doc, sheet, slides, pdf, folder.",
          inputSchema: { type: "object", properties: { query: { type: "string" }, type: { type: "string" }, max: { type: "number" } }, required: ["query"] },
        },
        run: async (input) => {
          const q = str(input.query).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const types: Record<string, string> = { doc: "application/vnd.google-apps.document", sheet: "application/vnd.google-apps.spreadsheet", slides: "application/vnd.google-apps.presentation", pdf: "application/pdf", folder: FOLDER };
          const t = types[str(input.type).toLowerCase()];
          const filter = `(name contains '${q}' or fullText contains '${q}') and trashed=false${t ? ` and mimeType='${t}'` : ""}`;
          const max = Math.min(30, Math.max(1, Number(input.max) || 15));
          const r = await g.api<{ files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; owners?: Array<{ displayName?: string }> }> }>(
            `${api}/files?q=${encodeURIComponent(filter)}&pageSize=${max}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))&supportsAllDrives=true&includeItemsFromAllDrives=true`,
          );
          if (!r.files?.length) return { output: "No files found." };
          return { output: r.files.map((f) => `id: ${f.id}\nname: ${f.name}\ntype: ${f.mimeType}\nchanged: ${f.modifiedTime ?? ""}${f.owners?.[0]?.displayName ? `\nowner: ${f.owners[0].displayName}` : ""}\nlink: ${f.webViewLink ?? ""}`).join("\n\n") };
        },
      },
      {
        risk: "read",
        spec: { name: "drive_read", description: "Read a Google Drive file (from drive_search): Docs and Slides as text, Sheets as CSV, PDF and Word by page (cite pages), text files as they are. For a folder, lists what is inside.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        run: async (input) => {
          const id = encodeURIComponent(str(input.id));
          const meta = await g.api<{ name: string; mimeType: string; size?: string; webViewLink?: string }>(`${api}/files/${id}?fields=name,mimeType,size,webViewLink&supportsAllDrives=true`);
          if (meta.mimeType === FOLDER) {
            const r = await g.api<{ files?: Array<{ id: string; name: string; mimeType: string }> }>(`${api}/files?q=${encodeURIComponent(`'${str(input.id)}' in parents and trashed=false`)}&pageSize=100&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
            return { output: `Folder ${meta.name}:\n${(r.files ?? []).map((f) => `- ${f.name} (${f.mimeType}) id: ${f.id}`).join("\n") || "(empty)"}` };
          }
          const exportAs = EXPORT[meta.mimeType];
          let text: string;
          if (exportAs) text = await (await g.raw(`${api}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`)).text();
          else if (/^text\/|json|xml|csv|markdown|javascript|yaml/.test(meta.mimeType)) {
            if (Number(meta.size ?? 0) > 5_000_000) return { output: `${meta.name} is too big to read here (${meta.size} bytes). Link: ${meta.webViewLink ?? ""}` };
            text = await (await g.raw(`${api}/files/${id}?alt=media&supportsAllDrives=true`)).text();
          } else if (/pdf$|wordprocessingml/.test(meta.mimeType)) {
            // PDF and Word: read page by page, so answers can say where they came from.
            if (Number(meta.size ?? 0) > 100_000_000) return { output: `${meta.name} is too big to read here. Link: ${meta.webViewLink ?? ""}` };
            const bytes = new Uint8Array(await (await g.raw(`${api}/files/${id}?alt=media&supportsAllDrives=true`)).arrayBuffer());
            const doc = await documentText(bytes, meta.mimeType.endsWith("pdf") ? `${meta.name.replace(/\.pdf$/i, "")}.pdf` : `${meta.name.replace(/\.docx$/i, "")}.docx`);
            const { text: pages, last } = formatPages(doc, 1, doc.pages.length, 40_000);
            return { output: `${meta.name} (${doc.pages.length} ${doc.kind === "pdf" ? "pages" : "parts"})\n${meta.webViewLink ?? ""}\nCite pages like (${meta.name}, p. 3).\n\n${pages}${last < doc.pages.length ? `\n\n(Shown up to ${last} of ${doc.pages.length}.)` : ""}` };
          } else return { output: `${meta.name} is a ${meta.mimeType} file, which cannot be read as text here. Link: ${meta.webViewLink ?? ""}` };
          return { output: `${meta.name}\n${meta.webViewLink ?? ""}\n\n${text.slice(0, 40_000)}${text.length > 40_000 ? "\n…(cut)" : ""}` };
        },
      },
      {
        risk: "exec",
        spec: { name: "drive_create_doc", description: "Create a new Google Doc in the user's Drive with the given title and text (Markdown-style headings and lists are fine). Returns its link.", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } },
        preview: async (input) => `Create a Google Doc in your Drive: "${str(input.title)}"\n\n${str(input.content).slice(0, 1500)}`,
        run: async (input) => {
          const boundary = `kesher${Date.now().toString(16)}`;
          const body = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({ name: str(input.title) || "Untitled", mimeType: "application/vnd.google-apps.document" }), `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", str(input.content), `--${boundary}--`].join("\r\n");
          const f = await g.api<{ id: string; webViewLink?: string }>(`${g.uploadBase()}/files?uploadType=multipart&fields=id,webViewLink`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
          return { output: `Created the Google Doc. ${f.webViewLink ?? `https://docs.google.com/document/d/${f.id}`}` };
        },
      },
    );
  }
  return tools;
}
