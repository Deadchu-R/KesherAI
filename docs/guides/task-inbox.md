# Task inbox, Antigravity and Drive sync

**עברית בקצרה:** תיבת המשימות היא ענף `kesher-inbox` ב-git: Claude כותב משימה (`tasks/<id>.md`), KesherAI במחשב קורא אותה, מריץ מודל מקומי או Antigravity (רק בלחיצה שלך) ומחזיר תוצאה בענף `agy/*`. סנכרון Drive שומר פרויקטים ושיחות בתיקיית KesherAI ב-Drive שלך. פורמט מלא: [../INBOX.md](../INBOX.md).

## What it does
Lets another agent (Claude) leave small, bounded tasks for your computer. Routing: 1-2 files with a check go to the local model; 3-15 files go to Antigravity; the rest to Claude's own agent. Google Drive backup keeps projects and chats on your other computers.

## Prerequisites
A git repository with the `kesher-inbox` branch and a remote you control; for Antigravity, the app installed and signed in on the PC; for Drive, an OAuth client ([../GOOGLE_DRIVE.md](../GOOGLE_DRIVE.md)).

## Steps
1. **Settings > Task inbox:** pick the project, the inbox branch, which commands a task's `check` may run, and who does each kind of task.
2. **Antigravity:** set its path in the same page. It runs only when you press **Run on the PC** (or approve the ask on your paired phone, valid 30 minutes). Nothing runs it by schedule.
3. **Write a task** from the template in [../INBOX.md](../INBOX.md): `id`, `title`, `executor`, `risk`, `allowed_paths`, `check`, limits, then Goal / Acceptance / Out of scope.
4. **Review the result** in `results/<id>.md` and the `agy/<id>-<slug>` branch (`-partial` when unfinished); merge yourself.
5. **Drive sync:** Settings > Google Drive > Connect (own client if the build has none). Projects and chats go to a `KesherAI` folder; other computers load them. With the Cloud hub paired, inbox tasks also show in its Tasks list (metadata only).

## Verify
Add a tiny task (one file, a check), press Run: a result file and a branch appear. In Drive, the KesherAI folder shows the project.

## Troubleshooting
- Task refused: the scan found a secret, email or personal path in it; remove it.
- Check not run: the command is not in the allowed list.
- Drive sign-in expires after 7 days: the Google app is in Testing; publish it or reconnect.

## Safety
KesherAI pushes only `agy/*` and `kesher-inbox`, never `main`, tags, deletes or force. The task text is data, not instructions. Drive access is `drive.file`: only files KesherAI made.
