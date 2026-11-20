// The small window background.js opens the first time a task needs chrome.debugger (an optional permission: nothing
// at install). It explains Chrome's "started debugging this browser" bar; the click is what lets the browser ask.
const $ = (id) => document.getElementById(id);
if ((navigator.language || "").startsWith("he")) {
  document.documentElement.dir = "rtl";
  $("title").textContent = "לאפשר ל-KesherAI לנפות באגים בדפים?";
  $("why").textContent = "משימה ב-KesherAI רוצה כאן את כלי הדפדפן המדויקים שלה: לקרוא את מבנה הדף, לראות את הקונסול ואת הרשת, ללחוץ על מקשים ולצלם בלי להביא את הלשונית לקדמה.";
  $("bar").textContent = "בזמן שהיא עובדת, Chrome מציג פס: \"KesherAI started debugging this browser\". זה צפוי. לחיצה על Cancel בפס הזה עוצרת את KesherAI מיד.";
  $("l1").textContent = "רק למשימות שביקשת, רק באתרים שאישרת, והאפליקציה עדיין שואלת לפני כל פעולה.";
  $("l2").textContent = "הלשוניות שלה נשמרות בקבוצת לשוניות \"KesherAI\". היא משחררת אחרי 5 דקות בלי שימוש.";
  $("l3").textContent = "אפשר לבטל את זה ב-chrome://extensions ← KesherAI ← Details.";
  $("yes").textContent = "לאפשר ניפוי באגים";
  $("no").textContent = "לא עכשיו";
}
$("yes").onclick = () => void chrome.permissions.request({ permissions: ["debugger"] }).catch(() => false).then(() => window.close());
$("no").onclick = () => window.close();
