# Telegram

You can write to KesherAI from Telegram, from anywhere, through a bot of your own. The models still run on your computer. The idea comes from OpenClaw's chat channels.

## Set it up (about a minute, free)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a name for the bot, and a username that ends in `bot`.
3. BotFather sends back a token. Paste it in KesherAI under **Settings → Phone → Telegram** and press **Connect**. Do this on the computer that runs KesherAI.
4. KesherAI shows a code. Send `/start <code>` to your bot, or press "open the bot in Telegram". That chat is now paired.

## Using it

- **Messages:** write anything. Each paired chat has its own conversation, which also appears in the app. `/new` starts a fresh one.
- **Approvals:** when the agent needs approval, Telegram shows **Approve / Deny** buttons. A button works once, for that one request, and only from the paired chat.
- **Questions:** when the agent asks a question that has options, the options come as buttons.
- **Pictures:** pictures the chat makes come back as photos. Pictures and voice messages you send to the bot are not supported yet.

## Safety

- **No open port.** KesherAI asks Telegram for new messages (long polling), so nothing has to reach your computer from outside.
- **Only paired chats get answers.** Any other chat, or a group, is ignored without a reply. The code changes after each pairing.
- **The token stays on this computer.** It is saved in config.json, and the phone app and the web never see it. Setting the token, pairing chats and removing the bot work only on this computer.
- **Same approvals as the app.** Commands and changes still ask for approval, exactly as they do in the app.
- Telegram's servers carry the messages, so the bot sees what you write. For work you want to keep entirely on the computer, use the KesherAI phone app instead.
