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
  assert.equal(dangerReason("Format-Volume -DriveLetter D"), "can erase a disk");
});
