# Telegram

You can write to KesherAI from Telegram, from anywhere, through a bot of your own. The models still run on your computer. The idea comes from OpenClaw's chat channels.

## Set it up (about a minute, free)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a name for the bot, and a username that ends in `bot`.
3. BotFather sends back a token. Paste it in KesherAI under **Settings → Phone → Telegram** and press **Connect**. Do this on the computer that runs KesherAI.
4. Press **Pair a chat**. Pairing then stays open for 10 minutes, for one chat. Send the bot `/start <code>`, or press "open the bot in Telegram".

## Using it

- **Messages:** write anything. Each paired chat has its own conversation, which also appears in the app. `/new` starts a fresh one.
- **Approvals:** when the agent needs approval, Telegram shows **Approve / Deny** buttons. A button works once, for that one request, and only from the paired chat.
- **Questions:** when the agent asks a question that has options, the options come as buttons.
- **Pictures:** pictures the chat makes come back as photos. A picture you send, with or without a caption, is saved in the chat's own folder, and the model looks at it. For example, send a photo with "what breed is this?".
- **Voice messages:** they are written down on your computer (Settings → Speech) and sent to the chat as text. The bot shows you what it heard first. Files over 20 MB are refused.

## Safety

Read the warnings in Settings before you connect. Connecting asks you to confirm that you read them.

- **Pairing only on purpose.** A code exists only after you press "Pair a chat" on the computer. It is 8 characters long, works for 10 minutes, and pairs one chat. After five wrong codes pairing closes and you get an alert. Every pairing also sends an alert to the computer and the phone, and Settings lists the paired chats so you can unpair one.
- **Telegram chats get less.** They always ask before any change, and they never get the screen or browser control tools. Commands (run_command, build_executable, computer and browser control) can be approved only on the computer or in the KesherAI app. There is a setting to allow approving them from Telegram, which is off by default and not recommended.
- **Only a person, writing it themselves.** Messages from bots, forwarded messages, groups and channels are ignored.
- **`/lock` turns the bot off at once.** Only the computer can turn it on again.
- **A rate limit.** At most 20 messages per chat in 10 minutes.
- **Buttons expire.** An Approve or Deny button works for 15 minutes, once, and only from the chat it was sent to.
- **Business mode** turns Telegram off unless the organisation allows it.
- **Recent activity** in Settings shows pairings, locks and approvals. It never shows message text.
- **If the token leaked:** send `/revoke` to @BotFather, then press **Remove the bot**.
- **Turn on Telegram's two-step verification.** Whoever holds the paired chat can talk to your computer.

- **No open port.** KesherAI asks Telegram for new messages (long polling), so nothing has to reach your computer from outside.
- **Only paired chats get answers.** Any other chat, or a group, is ignored without a reply. The code changes after each pairing.
- **The token stays on this computer.** It is saved in config.json, and the phone app and the web never see it. Setting the token, pairing chats and removing the bot work only on this computer.
- **Same approvals as the app.** Commands and changes still ask for approval, exactly as they do in the app.
- Telegram's servers carry the messages, so the bot sees what you write. For work you want to keep entirely on the computer, use the KesherAI phone app instead.
