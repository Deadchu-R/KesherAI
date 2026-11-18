# Working together on a KesherAI project (design, 2026-11-17)

Status: designed and approved by Roee (2026-11-18), not built yet. Roee's choices (2026-11-16): a short-lived invite link, a link for read or edit, and
long-term invites by email like Figma, with a page of who is approved, alerts on anything unusual, and a ban button.
Every part optional; KesherAI works the same without it.

## What others do
- **Figma**: invite by email (viewer/editor, per file or project); a public link with a chosen access level that can
  be set to expire; the owner sees everyone with access and removes them; organisations get audit logs and alerts.
- **Google Docs / Notion**: the same three ideas (people by email, a link with a role, an expiry on guests), with
  "anyone with the link" off by default.
- KesherAI already has: read-only chat share links that expire (/s/<token>), device keys per phone (revocable,
  with a scope such as "mcp"), an access log of every outside request, and lockout after wrong keys.

## The plan
1. **A project is the unit.** A collaborator never gets the whole KesherAI: only one project's chats (read, or read and
   write), its files through the chat's tools, and nothing in Settings, models, other projects, the computer's
   desktop, terminal or remote control.
2. **Invite link (short-lived).** One-time link, 1 hour to 7 days, read or edit; the first person to open it signs in
   with Google (their email is shown to Roee) and gets a personal key; the link then stops working.
3. **Email invite (long-term).** Roee types an email and the role; only that Google account can accept; no expiry
   unless he sets one.
4. **People page.** Everyone approved, their role, the project, when they joined and were last seen, what they did
   last (from the access log), and Remove / Ban (ban: their key stops at once and that email cannot be invited again
   without Roee's own confirmation).
5. **Alerts.** A notification (phone and computer) on: a new person accepted, many requests in a short time, a request
   outside the project, a new network address for a person, and use at night when Roee set "quiet hours".
6. **Under the hood.** A new device-key scope `project:<id>:read|edit`, checked in the auth hook against a short allow
   list of routes per scope (deny by default); every model call by a collaborator counts against a daily limit Roee
   sets (his computer, his electricity); the access log marks them by name.

## Risks to settle before building
- Edit access means the model runs tools in the project folder: commands stay behind Roee's approval (never
  auto-approved for a collaborator), and file tools stay inside the project.
- Prompt injection from a collaborator's message into Roee's own chats: collaborators only write in chats of their
  project, which Roee's chats never read by themselves.
- Their requests go through the same tunnel (Cloudflare/Tailscale): the per-person key and lockout apply.
