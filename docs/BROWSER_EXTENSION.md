# The KesherAI browser extension

The extension lets the agent work in your own browser (where you are already signed in): open pages, read them, click and fill in. It talks only to the KesherAI app on the same computer, with a pairing key from **Settings → Your browser**. The source is in [`apps/browser-extension`](../apps/browser-extension).

## Installing it without a store

**Settings → Your browser** has two downloads, made from the copy of the extension that came with the app:

| Browser | How |
| --- | --- |
| Chrome, Edge, Brave, Opera | Download the Chrome zip and unzip it. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and choose the unzipped folder. You can also click **Open the extension folder** and choose that folder instead. |
| Firefox | Download the Firefox zip. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and choose the zip. Firefox removes temporary add-ons when it closes, so this method suits trying the extension out. |

Then click the KesherAI icon in the toolbar, paste the key and press **Connect**.

The same zips are available from the server: `GET /api/browser/package?for=chrome` or `?for=firefox`.

## Publishing it in the stores (free)

The Chrome Web Store charges a one-time $5 developer fee, so KesherAI uses the free stores first:

- **Microsoft Edge Add-ons:** sign up at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview) (free) and upload the Chrome zip. Chrome, Brave and Opera users can also install from the Edge store.
- **Firefox Add-ons (AMO):** sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) (free) and upload the Firefox zip. You can list it publicly, or keep it unlisted, where Mozilla signs it so Firefox installs it permanently from a file.

The Firefox package has the add-on id `kesherai@deadchu-r.github.io`. It passes `web-ext lint` with no errors or warnings.
