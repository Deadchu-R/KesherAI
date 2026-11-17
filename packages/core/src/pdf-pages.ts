/**
 * A scanned PDF's pages as pictures (design ScannedPdf, students part 29 #8): Windows renders them with its own PDF
 * reader (Windows.Data.Pdf), so the pages can then be read by Windows' OCR or the vision model. Windows only.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The PDF's first pages as PNG pictures (about 1600 px wide), in order; undefined off Windows or when Windows cannot
 * open it.
 *
 * @param pdf - The PDF's bytes.
 * @param max - Pages at most.
 */
export async function renderPdfPages(pdf: Buffer, max = 40): Promise<{ pages: Buffer[]; total: number } | undefined> {
  if (process.platform !== "win32") return undefined;
  const dir = await mkdtemp(join(tmpdir(), "kesher-pdf-"));
  try {
    const file = join(dir, "in.pdf");
    await writeFile(file, pdf);
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "$m=[System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1}",
      "$asOp=($m|?{$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
      "$asAct=($m|?{$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'})[0]",
      "function Await($op,$t){$task=$asOp.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait(-1)|Out-Null;$task.Result}",
      "function AwaitA($a){$task=$asAct.Invoke($null,@($a));$task.Wait(-1)|Out-Null}",
      "[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Storage.StorageFolder,Windows.Storage,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime]|Out-Null",
      "$f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:KESHER_PDF)) ([Windows.Storage.StorageFile])",
      "$doc=Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($f)) ([Windows.Data.Pdf.PdfDocument])",
      "$dir=Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($env:KESHER_OUT)) ([Windows.Storage.StorageFolder])",
      `$n=[Math]::Min([int]$doc.PageCount,${Math.max(1, Math.floor(max))})`,
      "for($i=0;$i -lt $n;$i++){$p=$doc.GetPage($i);$o=[Windows.Data.Pdf.PdfPageRenderOptions]::new();$w=[double]$p.Size.Width;if($w -gt 0){$o.DestinationWidth=[uint32]1600;$o.DestinationHeight=[uint32]([double]$p.Size.Height*1600/$w)};$out=Await ($dir.CreateFileAsync(\"p$i.png\",[Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile]);$s=Await ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream]);AwaitA ($p.RenderToStreamAsync($s,$o));$s.Dispose();$p.Dispose()}",
      "[Console]::Out.Write([string]$doc.PageCount)",
    ].join(";");
    const out = await new Promise<string>((resolve, reject) =>
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, KESHER_PDF: file, KESHER_OUT: dir }, timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
    const total = Number(out.trim());
    if (!Number.isInteger(total) || total < 1) return undefined;
    const pages: Buffer[] = [];
    for (let i = 0; i < Math.min(total, max); i++) {
      const png = await readFile(join(dir, `p${i}.png`)).catch(() => undefined);
      if (png) pages.push(png);
    }
    return pages.length ? { pages, total } : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
