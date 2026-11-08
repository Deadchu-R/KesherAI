# Microsoft 365 Copilot and business mode

For organisations that want people to use only Microsoft 365 Copilot — for how data is handled and for one approved assistant.

## Copilot as a chat model

**Settings → Microsoft 365 Copilot → Connect with a work account.** After sign-in, "Microsoft 365 Copilot" is a chat model like any other.

- Answers come from Copilot inside your organisation's Microsoft 365 boundary, grounded on its mail, files, meetings and chats, each person with their own permissions; web search can be turned off.
- It uses Microsoft's [Copilot Chat API](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/ai-services/chat/overview) (`/beta/copilot/conversations`, **preview**), which needs a **work or school account with a Microsoft 365 Copilot licence**. Personal Microsoft accounts are not supported by Microsoft.
- Permissions asked for (all read-only, required together by the Chat API): `Sites.Read.All`, `Mail.Read`, `People.Read.All`, `OnlineMeetingTranscript.Read.All`, `Chat.Read`, `ChannelMessage.Read.All`, `ExternalItem.Read.All`. Some need an administrator's consent in your tenant.
- The API has no system prompt or tools: KesherAI passes the persona and the earlier messages as extra context, and Copilot's sources are listed under its answer. Tools (files, browser, computer use) do not run with Copilot.

### The app registration

Copilot uses the same Microsoft app registration as OneDrive ([docs/ONEDRIVE.md](ONEDRIVE.md)). Add one more redirect URI to it (Authentication → Mobile and desktop applications):

```
http://localhost/api/copilot/callback
```

A company can use its own registration in its own tenant: set its id in Settings → OneDrive (it is used for both).

## Business mode

**Settings → Business mode.** While it is on, only the connections ticked there can be used (by default only `copilot`): every other model — local engines, ComfyUI, cloud APIs — is not listed and calls to it are refused by the server, not just hidden. The chat model switches to Copilot.

Changing it works only on the computer itself, never from the phone.

### Locking it (administrators)

Put a `policy.json` in KesherAI's data folder (Windows: `%APPDATA%\KesherAI`, next to `config.json`):

```json
{ "business": { "enabled": true, "allowed": ["copilot"] } }
```

While the file is there, business mode follows it and cannot be changed in the app (Settings shows 🔒). Deploy it with your usual tools (Intune, Group Policy file copy). To also remove other features (pictures, voice, browser, computer use), turn those parts off on the **Parts** page.
