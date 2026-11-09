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
