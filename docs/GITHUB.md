# Connect with GitHub

**Connections → GitHub** signs in without a token to paste: KesherAI shows a short code, you open github.com/login/device, approve, and the GitHub tools (the official GitHub MCP server: repositories, issues, pull requests, Actions) work in every chat. It asks for `repo read:org workflow`.

This uses GitHub's *device flow*, which needs an **OAuth App** client id (no secret). Create it once:

1. github.com → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Name `KesherAI`, homepage `https://github.com/Deadchu-R/KesherAI`, callback URL `http://127.0.0.1:7420/` (unused by the device flow, but required).
3. Tick **Enable Device Flow**, then **Register application**.
4. Copy the **Client ID**.

Then:

- **For release builds:** add it as the repository secret `KESHER_GITHUB_CLIENT_ID`. The release workflow puts it into the app.
- **Running from source:** set the environment variable `KESHER_GITHUB_CLIENT_ID`, or paste it with `PUT /api/github/client`.

Without it, GitHub still works with a personal access token (Connections → GitHub → token).
