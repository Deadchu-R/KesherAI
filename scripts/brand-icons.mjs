// KesherAI's icon in every size and place, from the drawings in assets/brand/ (one source for the app, the phone,
// the browser extension, the installer and the web version). Run after changing them:
//   node scripts/brand-icons.mjs
// Needs Playwright's Chromium (already used by the interface check). The outputs are committed.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const brand = (f) => join(root, "assets/brand", f);
const out = (f) => {
  const p = join(root, f);
  mkdirSync(dirname(p), { recursive: true });
  return p;
};
const { chromium } = createRequire(join(root, "package.json"))("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

/** Renders one drawing to a PNG of `size`×`size`, on a transparent background; `round` crops it to a circle. */
async function png(svgFile, size, file, round = false, white = false) {
  const data = `data:image/svg+xml;base64,${readFileSync(brand(svgFile)).toString("base64")}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px;${round ? "border-radius:50%;" : ""}${white ? "filter:invert(1);" : ""}}</style><img src="${data}">`);
  await page.locator("img").evaluate((img) => img.decode());
  writeFileSync(out(file), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}

// The web version (and the desktop app's window, which shows it): the tab icon, the installable app's icons.
copyFileSync(brand("icon.svg"), out("apps/web/public/icon.svg"));
copyFileSync(brand("icon-full-bleed.svg"), out("apps/web/public/icon-maskable.svg"));
await png("icon.svg", 192, "apps/web/public/icon-192.png");
await png("icon.svg", 512, "apps/web/public/icon-512.png");
await png("icon-full-bleed.svg", 192, "apps/web/public/icon-maskable-192.png");
await png("icon-full-bleed.svg", 512, "apps/web/public/icon-maskable-512.png");
await png("icon-full-bleed.svg", 180, "apps/web/public/apple-touch-icon.png");

// The installer and the app on Windows, macOS and Linux (electron-builder reads build/icon.png).
await png("icon.svg", 1024, "apps/desktop/build/icon.png");

// The browser extension.
for (const s of [16, 32, 48, 128]) await png("icon.svg", s, `apps/browser-extension/icon${s}.png`);

// The phone app's own pages (the drawer's mark) and its launcher icon (copied into the Android project by CI).
copyFileSync(brand("mark.svg"), out("apps/android/www/icon.svg"));
await png("icon.svg", 192, "apps/android/www/icon-192.png");
const dpi = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dpi)) {
  const res = `apps/android/icon/res/mipmap-${d}`;
  await png("icon.svg", 48 * k, `${res}/ic_launcher.png`);
  await png("icon-full-bleed.svg", 48 * k, `${res}/ic_launcher_round.png`, true);
  await png("adaptive-foreground.svg", 108 * k, `${res}/ic_launcher_foreground.png`);
  await png("adaptive-background.svg", 108 * k, `${res}/ic_launcher_background.png`);
  await png("adaptive-monochrome.svg", 108 * k, `${res}/ic_launcher_monochrome.png`);
  // The status bar's notification icon: white on transparent (Android draws it in one colour).
  await png("mark-mono.svg", 24 * k, `apps/android/icon/res/drawable-${d}/ic_stat_kesher.png`, false, true);
}
// Android 8+: the layered icon; Android 13+ tints the monochrome layer for themed icons.
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;
writeFileSync(out("apps/android/icon/res/mipmap-anydpi-v26/ic_launcher.xml"), adaptive);
writeFileSync(out("apps/android/icon/res/mipmap-anydpi-v26/ic_launcher_round.xml"), adaptive);

await browser.close();
console.log("Brand icons written.");
