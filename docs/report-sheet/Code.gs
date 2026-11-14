// KesherAI "Report a problem" -> this Google Sheet (Extensions -> Apps Script in the sheet, then Deploy -> Web app,
// Execute as: Me, Who has access: Anyone). It only RECEIVES: every answer is the word "ok", nothing is ever read
// back, and the owner's account is never shown to the people who report.
var MAX = 16000;
// A script made inside the sheet (Extensions -> Apps Script) leaves this empty; a separate script names the sheet.
var SHEET_ID = '';

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    // At most 60 reports in 10 minutes (spam stays small).
    var cache = CacheService.getScriptCache();
    var n = Number(cache.get('n') || 0);
    if (n >= 60) return ok_();
    cache.put('n', String(n + 1), 600);
    var d = JSON.parse(String((e && e.postData && e.postData.contents) || '{}').slice(0, MAX));
    var sheet = (SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet()).getSheets()[0];
    if (sheet.getLastRow() === 0) sheet.appendRow(['Time', 'Version', 'System', 'What happened', 'Faults', 'Status']);
    sheet.appendRow([new Date(), cell_(d.version, 30), cell_(d.system, 40), cell_(d.what, 2000), cell_(d.faults, 12000), 'new']);
  } catch (err) {
    // Never tell the sender anything about the sheet.
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
  return ok_();
}

function doGet() {
  return ok_();
}

// Plain text, never a formula (a cell that starts with = + - @ is kept as text).
function cell_(v, max) {
  var s = String(v === undefined || v === null ? '' : v).slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ok_() {
  return ContentService.createTextOutput('ok');
}
