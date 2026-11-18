// The small window background.js opens when a task needs a site KesherAI may not use yet (the extension asks for
// sites only when needed, not for all sites at install). The click is what lets the browser show its question.
const origin = new URLSearchParams(location.search).get("origin") || "";
const he = (navigator.language || "").startsWith("he");
const $ = (id) => document.getElementById(id);
$("site").textContent = origin.replace(/^https?:\/\//, "");
if (he) {
  document.documentElement.dir = "rtl";
  $("title").textContent = "KesherAI צריך את האתר הזה";
  $("why").firstChild.textContent = "משימה ב-KesherAI רוצה לקרוא או להשתמש ב-";
  $("why").lastChild.textContent = ". הדפדפן שואל אותך קודם.";
  $("one").textContent = "לאפשר באתר הזה";
  $("all").textContent = "לאפשר בכל האתרים";
  $("no").textContent = "לא עכשיו";
}
// Only an http(s) origin is ever asked for (background.js builds it from the tab's address).
const valid = /^https?:\/\/[^/?#]+$/.test(origin);
$("one").disabled = !valid;
const ask = (origins) => chrome.permissions.request({ origins }).catch(() => false).then(() => window.close());
$("one").onclick = () => void ask([`${origin}/*`]);
$("all").onclick = () => void ask(["<all_urls>"]);
$("no").onclick = () => window.close();
