# Connect with GitHub

**Settings › Connections › GitHub** signs in without a token to paste. The account is used to open pull requests from code chats, read their GitHub Actions checks, push (code chats and the task inbox) and for the GitHub tools (the official GitHub MCP server) in every chat. The card shows the account, what it may do, the repositories it reaches, and Sign out.

Two ways:

- **Git Credential Manager** (on the PC, when git uses it; Git for Windows installs it): "Sign in with GitHub" runs `git credential fill` for github.com, GCM opens its browser sign-in, and KesherAI checks the result with `GET /user`. KesherAI keeps only the account name; the token stays in Windows' credential store and KesherAI asks GCM again (with no window) whenever it needs it. GCM's own app asks for `repo gist workflow`. Signing out in KesherAI leaves git signed in.
- **A code (device flow)**, on the PC or from a paired phone (the code shows on the phone and the link opens there): KesherAI shows a short code, you open github.com/login/device, approve, and KesherAI keeps the token encrypted in its config (`enc:v1`, the system's protection). It asks for `repo read:org workflow`: repositories with their issues and PRs, your organisations (read), and GitHub Actions files.

Pushes with the code's token get it through the environment of that one git process (a credential helper given as `GIT_CONFIG_*` that reads `KESHER_GITHUB_TOKEN`), so it is never in a URL, a remote, the command line, a prompt or a log; the leak guard treats `gho_`/`ghp_` tokens as secrets.

The device flow needs an **OAuth App** client id (no secret). KesherAI's release builds carry the project's; to use your own, create it once:

1. github.com → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Name `KesherAI`, homepage `https://github.com/Deadchu-R/KesherAI`, callback URL `http://127.0.0.1:7420/` (unused by the device flow, but required).
3. Tick **Enable Device Flow**, then **Register application**.
4. Copy the **Client ID**.

Then:

- **For release builds:** add it as the repository secret `KESHER_GITHUB_CLIENT_ID`. The release workflow puts it into the app.
- **Running from source:** set the environment variable `KESHER_GITHUB_CLIENT_ID`, or paste it with `PUT /api/github/client`.

Without it, GitHub still works with a personal access token (Connections → GitHub → token).
