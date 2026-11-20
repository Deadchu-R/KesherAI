# KesherAI browser extension

Lets the KesherAI app on this computer do browser tasks you ask for, in your own
browser where you are already signed in: list tabs, open a page, read it, click,
type, and take a screenshot. The app asks you before each action unless you chose
otherwise, and the extension never types into password or card fields.

## Install (Chrome, Edge, Brave)

1. In KesherAI open **Settings → Browser** and copy the connection key.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
   and choose this folder (Settings → Browser has a button that opens it).
3. Click the KesherAI icon in the toolbar, paste the key and press **Connect**.

Only an extension on this computer with the right key can connect; web pages
cannot. The key can be changed in Settings → Browser.

## Side panel (0.2.0)

Click the KesherAI button (or Alt+K) → "Open the side panel": KesherAI's chat beside any page, from this
computer. "Ask about this page" hands the page's text to a new chat (marked as the page's content, never
instructions). KesherAI lets only itself and browser extensions show it in a frame, never a web site.


## Debugging tools (0.3.0)

In Chrome, Edge and Brave the app's exact browser tools also work here (the same ones as in KesherAI's own
browser): the page's accessibility snapshot with refs, the console, the network, keys, waiting, pop-ups and pictures
without bringing the tab to the front. They use `chrome.debugger`, an **optional** permission: nothing at install;
the first time a task needs it a small window explains it and asks (or press "Allow debugging now" in the popup).

- While it works Chrome shows a bar: "KesherAI started debugging this browser". Pressing **Cancel** there stops
  KesherAI at once (the app treats it as its Stop button).
- Its tabs go into a **KesherAI** tab group; it lets go of a tab after 5 idle minutes, and of all of them on Stop.
- Only the CDP domains the tools use are sent (Page, Runtime, Log, Network, DOM, Accessibility, Input, Emulation,
  Overlay); only web pages on sites you allowed; never the browser's own pages or the KesherAI app's.
- Firefox has no debugger for extensions: there the extension keeps the page reader (read, click, type).
