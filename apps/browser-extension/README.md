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

