/**
 * The PowerShell side of the Windows UI Automation worker (uia-worker.ts). It is written to a temporary file and
 * started once with `powershell.exe -STA -File`, then answers one JSON request per line on stdin with one JSON line
 * on stdout, so the cost of loading UI Automation (about a second) is paid once, not per action.
 *
 * Protocol (version 1):
 * - First line from the worker: `{"hello":"kesher-uia","version":1,"elevated":false,"pid":123}`. An elevated worker
 *   says so and exits: KesherAI never drives the computer with administrator rights.
 * - Request: `{"id":1,"op":"tree","args":{...}}`. Answer: `{"id":1,"ok":true,"result":{...}}` or
 *   `{"id":1,"ok":false,"error":"..."}`.
 * - Ops: ping, windows, tree, act, setValue, focus, move, wait, holdKey, cursor, mouse, clipboardGet, clipboardSet,
 *   quit. Element refs (`u1`, `u2`...) live per `scope` (one per conversation) and expire on the scope's next tree.
 *
 * Kept ASCII only: Windows PowerShell 5.1 reads a script file without a byte order mark in the system code page.
 * Safety words in Hebrew and English are checked in TypeScript (computer-safety.ts), not here.
 */
export const UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class KU {
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
}
'@
[KU]::SetProcessDPIAware() | Out-Null

function Send($o) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 8))
  [Console]::Out.Flush()
}

$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Send @{ hello = 'kesher-uia'; version = 1; elevated = $elevated; pid = $PID }
if ($elevated) { exit 3 }

$AE = [System.Windows.Automation.AutomationElement]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$Scopes = @{}
$Procs = @{}

function Clip([string]$s, [int]$n) {
  if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }
  return $s
}

function ProcName([int]$id) {
  if (-not $Procs.ContainsKey($id)) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    $Procs[$id] = if ($p) { $p.ProcessName } else { '' }
  }
  return $Procs[$id]
}

function RectOf($r) {
  if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { return $null }
  return @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

function MonitorOf([long]$h) {
  $s = [System.Windows.Forms.Screen]::FromHandle([IntPtr]$h)
  $all = [System.Windows.Forms.Screen]::AllScreens
  for ($i = 0; $i -lt $all.Length; $i++) { if ($all[$i].DeviceName -eq $s.DeviceName) { return $i + 1 } }
  return 1
}

function WindowInfo($el) {
  $c = $el.Current
  $h = [long]$c.NativeWindowHandle
  return @{ handle = $h; title = (Clip $c.Name 200); app = (ProcName $c.ProcessId); pid = $c.ProcessId; rect = (RectOf $c.BoundingRectangle); monitor = (MonitorOf $h); minimized = [KU]::IsIconic([IntPtr]$h); front = ([KU]::GetForegroundWindow().ToInt64() -eq $h) }
}

function WindowEl($a) {
  $h = [long]0
  if ($a -and $a.window) { $h = [long]$a.window } else { $h = [KU]::GetForegroundWindow().ToInt64() }
  if ($h -eq 0) { throw 'No window is in front.' }
  $el = $AE::FromHandle([IntPtr]$h)
  if (-not $el) { throw "There is no window $h." }
  return $el
}

function ScopeOf($a, [bool]$reset) {
  $k = [string]$a.scope
  if (-not $k) { $k = '-' }
  if ($Scopes.Count -gt 50 -and -not $Scopes.ContainsKey($k)) { $Scopes.Clear() }
  if ($reset -or -not $Scopes.ContainsKey($k)) { $Scopes[$k] = @{ n = 0; refs = @{} } }
  return $Scopes[$k]
}

function NewRef($s, $el) {
  $s.n = $s.n + 1
  $r = 'u' + $s.n
  $s.refs[$r] = $el
  return $r
}

function ElOf($a) {
  $s = ScopeOf $a $false
  $el = $s.refs[[string]$a.ref]
  if (-not $el) { throw "Ref $($a.ref) is unknown or expired: call computer_tree again." }
  return $el
}

function NodeInfo($el, [string]$ref, [int]$depth) {
  $c = $el.Current
  $pats = New-Object System.Collections.ArrayList
  foreach ($p in $el.GetSupportedPatterns()) { [void]$pats.Add(($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')) }
  $n = @{ ref = $ref; depth = $depth; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = (Clip $c.Name 120); enabled = $c.IsEnabled; patterns = @($pats) }
  if ($c.AutomationId) { $n.id = Clip $c.AutomationId 60 }
  if ($c.IsPassword) { $n.password = $true }
  if ($c.IsOffscreen) { $n.offscreen = $true }
  $r = RectOf $c.BoundingRectangle
  if ($r) { $n.rect = $r }
  $o = $null
  if (-not $c.IsPassword -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) {
    $n.value = Clip $o.Current.Value 200
    if ($o.Current.IsReadOnly) { $n.readonly = $true }
  }
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { $n.toggle = [string]$o.Current.ToggleState }
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { $n.expand = [string]$o.Current.ExpandCollapseState }
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { if ($o.Current.IsSelected) { $n.selected = $true } }
  return $n
}

function Walk($el, [int]$depth, [int]$maxDepth, $list, [int]$max, $s) {
  if ($list.Count -ge $max) { return }
  $ref = 'u' + ($s.n + 1)
  try { $info = NodeInfo $el $ref $depth } catch { return }
  [void](NewRef $s $el)
  [void]$list.Add($info)
  if ($depth -ge $maxDepth) { return }
  try { $ch = $Walker.GetFirstChild($el) } catch { $ch = $null }
  while ($null -ne $ch -and $list.Count -lt $max) {
    Walk $ch ($depth + 1) $maxDepth $list $max $s
    try { $ch = $Walker.GetNextSibling($ch) } catch { $ch = $null }
  }
}

function TopWindows() {
  return $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
}

function Op-Windows {
  $Procs.Clear()
  $list = New-Object System.Collections.ArrayList
  foreach ($w in (TopWindows)) {
    try {
      $c = $w.Current
      if ($c.NativeWindowHandle -eq 0 -or -not $c.Name) { continue }
      [void]$list.Add((WindowInfo $w))
    } catch { }
  }
  $mons = New-Object System.Collections.ArrayList
  $all = [System.Windows.Forms.Screen]::AllScreens
  for ($i = 0; $i -lt $all.Length; $i++) {
    $b = $all[$i].Bounds; $wa = $all[$i].WorkingArea
    [void]$mons.Add(@{ index = $i + 1; primary = $all[$i].Primary; bounds = @($b.X, $b.Y, $b.Width, $b.Height); work = @($wa.X, $wa.Y, $wa.Width, $wa.Height) })
  }
  return @{ windows = @($list); monitors = @($mons) }
}

function Op-Tree($a) {
  $win = WindowEl $a
  $s = ScopeOf $a $true
  $maxDepth = [Math]::Min([Math]::Max([int]$a.depth, 1), 15)
  $max = [Math]::Min([Math]::Max([int]$a.max, 10), 500)
  $list = New-Object System.Collections.ArrayList
  Walk $win 0 $maxDepth $list $max $s
  return @{ window = (WindowInfo $win); nodes = @($list); truncated = ($list.Count -ge $max) }
}

function Pattern($el, $pat, [string]$what) {
  $o = $null
  if (-not $el.TryGetCurrentPattern($pat, [ref]$o)) { throw "This element cannot $what (it has no such UI Automation pattern). Use computer_click at its place instead." }
  return $o
}

function Op-Act($a) {
  $el = ElOf $a
  switch ([string]$a.action) {
    'invoke' { (Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern) 'be invoked').Invoke() }
    'toggle' { (Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern) 'be toggled').Toggle() }
    'select' { (Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern) 'be selected').Select() }
    'expand' { (Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) 'be expanded').Expand() }
    'collapse' { (Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) 'be collapsed').Collapse() }
    'focus' { $el.SetFocus() }
    default { throw "Unknown action $($a.action)." }
  }
  Start-Sleep -Milliseconds 150
  try { return @{ node = (NodeInfo $el ([string]$a.ref) 0) } } catch { return @{ node = $null } }
}

function Op-SetValue($a) {
  $el = ElOf $a
  if ($el.Current.IsPassword) { throw 'This is a password field: KesherAI never types there.' }
  $p = Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern) 'take a value'
  if ($p.Current.IsReadOnly) { throw 'This field is read-only.' }
  $p.SetValue([string]$a.value)
  Start-Sleep -Milliseconds 100
  try { return @{ node = (NodeInfo $el ([string]$a.ref) 0) } } catch { return @{ node = $null } }
}

function Op-Focus($a) {
  $h = [IntPtr][long]$a.window
  if ([KU]::IsIconic($h)) { [KU]::ShowWindowAsync($h, 9) | Out-Null; Start-Sleep -Milliseconds 150 }
  [KU]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 120
  if ([KU]::GetForegroundWindow() -ne $h) {
    try { $AE::FromHandle($h).SetFocus() } catch { }
    Start-Sleep -Milliseconds 120
  }
  return @{ front = ([KU]::GetForegroundWindow() -eq $h) }
}

function Op-Move($a) {
  $h = [IntPtr][long]$a.window
  $all = [System.Windows.Forms.Screen]::AllScreens
  $i = [int]$a.monitor - 1
  if ($i -lt 0 -or $i -ge $all.Length) { throw "There is no monitor $($a.monitor) (there are $($all.Length))." }
  $to = $all[$i].WorkingArea
  $from = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
  $wasMax = [KU]::IsZoomed($h)
  if ($wasMax -or [KU]::IsIconic($h)) { [KU]::ShowWindowAsync($h, 9) | Out-Null; Start-Sleep -Milliseconds 200 }
  $r = New-Object KU+RECT
  [KU]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($a.width) { $w = [int]$a.width }
  if ($a.height) { $hh = [int]$a.height }
  $w = [Math]::Max(120, [Math]::Min($w, $to.Width)); $hh = [Math]::Max(80, [Math]::Min($hh, $to.Height))
  if ($null -ne $a.x) { $x = $to.X + [int]$a.x } else { $x = $to.X + [Math]::Max(0, [Math]::Min($r.Left - $from.X, $to.Width - $w)) }
  if ($null -ne $a.y) { $y = $to.Y + [int]$a.y } else { $y = $to.Y + [Math]::Max(0, [Math]::Min($r.Top - $from.Y, $to.Height - $hh)) }
  [KU]::MoveWindow($h, $x, $y, $w, $hh, $true) | Out-Null
  if ($wasMax) { Start-Sleep -Milliseconds 100; [KU]::ShowWindowAsync($h, 3) | Out-Null }
  return @{ rect = @($x, $y, $w, $hh); monitor = $i + 1 }
}

function FindByName($root, [string]$name, [string]$type, [int]$cap) {
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  $seen = 0
  while ($stack.Count -gt 0 -and $seen -lt $cap) {
    $el = $stack.Pop(); $seen++
    try {
      $c = $el.Current
      if ($c.Name -and $c.Name.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and (-not $type -or ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') -eq $type)) { return $el }
      $ch = $Walker.GetFirstChild($el)
      while ($null -ne $ch) { $stack.Push($ch); $ch = $Walker.GetNextSibling($ch) }
    } catch { }
  }
  return $null
}

function Op-Wait($a) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min([Math]::Max([int]$a.timeoutMs, 100), 30000))
  $gone = [bool]$a.gone
  do {
    $found = $null
    $win = $null
    if ($a.windowTitle) {
      foreach ($w in (TopWindows)) {
        try { if ($w.Current.Name.IndexOf([string]$a.windowTitle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $found = $w; break } } catch { }
      }
      $win = $found
    } else {
      try { $win = WindowEl $a; $found = FindByName $win ([string]$a.name) ([string]$a.type) 3000 } catch { $found = $null }
    }
    if (($null -ne $found) -ne $gone) {
      if ($null -eq $found) { return @{ met = $true } }
      $s = ScopeOf $a $false
      $ref = NewRef $s $found
      return @{ met = $true; node = (NodeInfo $found $ref 0); window = (WindowInfo $win) }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return @{ met = $false }
}

function Op-HoldKey($a) {
  $keys = @($a.keys)
  $ms = [Math]::Min([Math]::Max([int]$a.ms, 50), 10000)
  try {
    foreach ($k in $keys) { [KU]::keybd_event([byte]$k.vk, 0, $(if ($k.ext) { 1 } else { 0 }), [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds $ms
  } finally {
    for ($i = $keys.Length - 1; $i -ge 0; $i--) { $k = $keys[$i]; [KU]::keybd_event([byte]$k.vk, 0, $(if ($k.ext) { 3 } else { 2 }), [UIntPtr]::Zero) }
  }
  return @{ held = $ms }
}

function M([uint32]$f) { [KU]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero) }

function Op-Mouse($a) {
  [KU]::SetCursorPos([int]$a.x, [int]$a.y) | Out-Null
  Start-Sleep -Milliseconds 40
  switch ([string]$a.kind) {
    'middle' { M 0x20; M 0x40 }
    'triple' { for ($i = 0; $i -lt 3; $i++) { M 0x2; M 0x4; Start-Sleep -Milliseconds 60 } }
    'down' { M 0x2 }
    'up' { M 0x4 }
    default { throw "Unknown mouse action $($a.kind)." }
  }
  return @{ done = [string]$a.kind }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = $req.id
    $a = $req.args
    $r = $null
    switch ([string]$req.op) {
      'ping' { $r = @{ pong = $true } }
      'windows' { $r = Op-Windows }
      'tree' { $r = Op-Tree $a }
      'act' { $r = Op-Act $a }
      'setValue' { $r = Op-SetValue $a }
      'focus' { $r = Op-Focus $a }
      'move' { $r = Op-Move $a }
      'wait' { $r = Op-Wait $a }
      'holdKey' { $r = Op-HoldKey $a }
      'cursor' { $p = [System.Windows.Forms.Cursor]::Position; $r = @{ x = $p.X; y = $p.Y } }
      'mouse' { $r = Op-Mouse $a }
      'clipboardGet' { $t = Get-Clipboard -Raw; $r = @{ text = (Clip ([string]$t) 100000) } }
      'clipboardSet' { Set-Clipboard -Value ([string]$a.text); $r = @{ ok = $true } }
      'quit' { exit 0 }
      default { throw "Unknown op $($req.op)." }
    }
    Send @{ id = $id; ok = $true; result = $r }
  } catch {
    Send @{ id = $id; ok = $false; error = (Clip ([string]$_.Exception.Message) 400) }
  }
}
`;

/**
 * A one-shot PowerShell script that lets go of keys and the left mouse button, for when the worker is killed while
 * it holds them (Stop during `computer_hold_key` or between a mouse down and up): no key stays stuck down.
 *
 * @param keys - Virtual-key codes held, with the extended-key flag.
 * @param mouse - Whether the left button may be down.
 * @returns The script.
 */
export function releaseScript(keys: Array<{ vk: number; ext?: boolean }>, mouse: boolean): string {
  const ups = keys
    .map((k) => `[KR]::keybd_event(${Math.trunc(k.vk) & 0xff}, 0, ${k.ext ? 3 : 2}, [UIntPtr]::Zero)`)
    .reverse();
  if (mouse) ups.push("[KR]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)");
  return `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class KR {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
}
'@
${ups.join("\n")}`;
}
