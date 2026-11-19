// Kesher Cloud hub: the page must never stay blank. If the page's script does not start (it failed to download, the
// browser is too old for it, or it threw before drawing), this shows a short message with a retry. Plain script, no
// build step; the page's own script (js/apps/hub/page/app.js) replaces #app's contents once it draws.
(function () {
  var shown = false;
  function fail() {
    var box = document.getElementById("boot-fail");
    var wait = document.getElementById("boot-wait");
    // The page drew something of its own (the boot boxes are gone), or it is already showing the error.
    if (shown || !box || document.documentElement.hasAttribute("data-ready")) return;
    shown = true;
    box.hidden = false;
    if (wait) wait.hidden = true;
  }
  addEventListener("error", function (e) { if (e && e.target && e.target.tagName === "SCRIPT") fail(); }, true);
  addEventListener("DOMContentLoaded", function () {
    var retry = document.getElementById("boot-retry");
    if (retry) retry.addEventListener("click", function () { location.reload(); });
  });
  // Slow networks get time; after that, an empty page is worse than a retry button.
  setTimeout(fail, 15000);
})();
