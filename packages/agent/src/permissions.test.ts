import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, dangerReason } from "./permissions.js";

test("installing system software always asks, even with always-allow", () => {
  for (const c of ["winget install Microsoft.VisualStudio.Workload.VCTools -e", "choco install git", "msiexec /i x.msi /quiet", "vs_installer.exe modify --add Microsoft.VisualStudio.Workload.NativeGame", "apt-get install foo", "Install-Module PSReadLine"]) {
    assert.ok(dangerReason(c), c);
    assert.equal(decide("auto", "exec", true, c).action, "ask", c);
  }
  for (const c of ["dir", "npm install", "pip install requests", "cmd /c dir C:\\"]) assert.equal(dangerReason(c), undefined, c);
});

test("PowerShell's Format-List and Format-Table are not disk erasers; format C: and Format-Volume are", () => {
  assert.equal(dangerReason("Get-Process llama-server | Format-List Id,CPU"), undefined);
  assert.equal(dangerReason("Get-NetTCPConnection -LocalPort 8081 | Format-Table State"), undefined);
  assert.equal(dangerReason("format C: /q"), "can erase a disk");
  assert.equal(dangerReason("wmic logicaldisk get caption,freespace,size /format:list"), undefined, "wmic's output layout");
  assert.equal(dangerReason("Format-Volume -DriveLetter D"), "can erase a disk");
  assert.equal(dangerReason("Format-Volume -DriveLetter D"), "can erase a disk");
});

test("safety gates: turning off protection, sending in your name and losing git work always ask", () => {
  for (const c of [
    "Set-MpPreference -DisableRealtimeMonitoring $true",
    "netsh advfirewall set allprofiles state off",
    "Set-ExecutionPolicy Bypass -Scope CurrentUser",
    "sc stop WinDefend",
    "Send-MailMessage -To a@example.com -Subject hi",
    "gh pr create --fill",
    "gh release create v1",
    "git restore .",
    "git checkout .",
    "git stash drop",
    "git branch -D old",
  ]) {
    assert.ok(dangerReason(c), c);
    assert.equal(decide("auto", "exec", true, c).action, "ask", c);
  }
  for (const c of ["gh pr view 12", "gh run list", "git restore src/a.ts", "git checkout main", "git stash", "git branch -d merged", "Get-MpPreference", "netsh interface show interface"]) {
    assert.equal(dangerReason(c), undefined, c);
  }
});

test("safety gates: a delete outside the project folder always asks; inside it does not", () => {
  const ws = "C:\\Work\\game";
  for (const c of ["del C:\\Windows\\temp.txt", "rm ../other/file.txt", "Remove-Item -Path D:\\data\\x.bin", "rm ~/notes.md", "del %USERPROFILE%\\x.txt", "cmd /c del C:\\x.txt", "npm test && rm /etc/hosts"]) {
    assert.equal(dangerReason(c, ws), "deletes files outside the project folder", c);
    assert.equal(decide("auto", "exec", true, c, ws).action, "ask", c);
  }
  for (const c of ["del build\\out.txt", "rm dist/a.js", "del C:\\work\\GAME\\tmp.txt", "Remove-Item .\\cache\\x.json", "rm src/../dist/a.js", "echo done"]) {
    assert.equal(dangerReason(c, ws), undefined, c);
  }
  // POSIX project folder: case matters, and a sibling with the same prefix is outside.
  assert.equal(dangerReason("rm /home/u/proj/a.txt", "/home/u/proj"), undefined);
  assert.ok(dangerReason("rm /home/u/proj2/a.txt", "/home/u/proj"));
  // No project folder: any absolute path is outside.
  assert.ok(dangerReason("rm /tmp/x"));
  assert.equal(dangerReason("rm x.txt"), undefined);
});
