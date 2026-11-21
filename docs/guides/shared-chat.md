# Shared chat with guests

**עברית בקצרה:** אפשר לשתף שיחה בקישור לקריאה בלבד (פג תוקף, ניתן להפסקה מיידית ב"שיחות ששיתפת"). בפרויקט משותף אפשר גם לאפשר לאורחים לכתוב בשיחה ("אפשר תגובות"): כבוי כברירת מחדל, לכל שיתוף בנפרד, ללא כלים אלא אם הפעלת, וכל פעולה מחכה לאישורך. המחשב שלך ממשיך להריץ את המודל.

## What it does
Read-only share links, and optionally replies from invited guests in a shared project's chat, labelled `[Guest: Name]`.

## Prerequisites
Remote access or a tunnel so guests can reach your computer ([phone-remote.md](phone-remote.md)); for replies, a shared project with guest invites (role read or edit).

## Steps
1. In a chat, choose Share. A link `/s/<token>` opens a read-only page. List and stop links in Settings > Shared chats.
2. **Allow replies** (per share): invite guests with "edit" to the project; the owner turns replies on and sets an end time. "Read" guests watch live; you can mute a guest.
3. Optionally let guests use tools for that share; every action still waits for your approval.
4. Set limits: messages per minute per guest and a daily allowance of guest answers.

## Verify
Open the link in a private window: the chat shows, with no paths or keys. As a guest, write a message and see it labelled.

## Troubleshooting
- Link dead: it expired or was stopped. Make a new one.
- Guest cannot write: replies are off, the share ended, or the role is read.

## Safety
- Guests' words are untrusted data: they cannot impersonate KesherAI headers or you.
- By default guests get no tools. Approval cards, questions and tool steps never reach them.
- Pages are cleaned of local paths and anything that looks like a key. Stop a share and its link closes at once.
- Do not share chats that contain secrets or private files.
