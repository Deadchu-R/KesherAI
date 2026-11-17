import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A line Windows' OCR found: its text and box, in the picture's pixels. */
export interface OcrLine { t: string; x: number; y: number; w: number; h: number }

/** The OCR script's JSON (one line or a list), checked. */
export function parseOcr(out: string): OcrLine[] | undefined {
  try {
    const j = JSON.parse(out.trim().replace(/^\uFEFF/, "")) as unknown;
    const list = (Array.isArray(j) ? j : [j]) as Array<Record<string, unknown>>;
    const lines = list.filter((l) => l && typeof l.t === "string" && l.t.trim()).map((l) => ({ t: String(l.t), x: Number(l.x) || 0, y: Number(l.y) || 0, w: Number(l.w) || 0, h: Number(l.h) || 0 }));
    return lines.length ? lines : undefined;
  } catch {
    return undefined;
  }
}

/** Why the last OCR attempt failed (shown with the answer, so a missing language pack is visible). */
let ocrWhy = "";

/**
 * Windows' own OCR on a picture: its lines with their boxes; undefined when it is not available (not Windows, no
 * language pack: see {@link ocrWhyLast}).
 *
 * @param png - The picture.
 * @param he - Read it as Hebrew.
 */
export async function windowsOcr(png: Buffer, he: boolean): Promise<OcrLine[] | undefined> {
  ocrWhy = "";
  if (process.platform !== "win32") return undefined;
  const dir = await mkdtemp(join(tmpdir(), "kesher-ocr-"));
  try {
    const file = join(dir, "shot.png");
    await writeFile(file, png);
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "$as=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
      "function Await($op,$t){$task=$as.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait(-1)|Out-Null;$task.Result}",
      "[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null",
      `$f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:KESHER_OCR_FILE)) ([Windows.Storage.StorageFile])`,
      "$s=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
      "$d=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])",
      "$b=Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
      `$lang=[Windows.Globalization.Language]::new('${he ? "he" : "en"}')`,
      // Without Windows' Hebrew OCR pack an English engine reads Hebrew as gibberish (seen on the PC): say so instead.
      `if(-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)){[Console]::Out.Write('NO-LANG');exit 0}`,
      "$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)",
      "if(-not $e){exit 3}",
      "$r=Await ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      // Each line with its box (the union of its words), for drawing a translation over it.
      "ConvertTo-Json -Compress -Depth 3 @($r.Lines|%{$ws=@($_.Words|%{$_.BoundingRect});$x=($ws|%{$_.X}|Measure-Object -Minimum).Minimum;$y=($ws|%{$_.Y}|Measure-Object -Minimum).Minimum;$r2=($ws|%{$_.X+$_.Width}|Measure-Object -Maximum).Maximum;$b=($ws|%{$_.Y+$_.Height}|Measure-Object -Maximum).Maximum;@{t=$_.Text;x=$x;y=$y;w=$r2-$x;h=$b-$y}})",
    ].join(";");
    const out = await new Promise<string>((resolve, reject) =>
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, KESHER_OCR_FILE: file }, timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { why: String(stderr || err.message).replace(/\s+/g, " ").slice(0, 300) })) : resolve(stdout))),
    );
    if (out.trim() === "NO-LANG") {
      ocrWhy = "no-language";
      return undefined;
    }
    const lines = parseOcr(out);
    if (!lines) ocrWhy = out.trim() ? "no text lines" : "no text found";
    return lines;
  } catch (e) {
    ocrWhy = (e as { why?: string }).why ?? (e as Error).message;
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A picture's text by Windows' own OCR (a scanned page, design ScannedPdf), or why not ("no-language" when the
 * language's OCR pack is missing; empty `text` off Windows).
 *
 * @param png - The picture.
 * @param he - Read it as Hebrew.
 */
export async function ocrText(png: Buffer, he: boolean): Promise<{ text?: string; why: string }> {
  const lines = await windowsOcr(png, he);
  return lines ? { text: lines.map((l) => l.t).join("\n"), why: "" } : { why: ocrWhy };
}


/** Why the last OCR attempt failed ("no-language" when the language pack is missing). */
export const ocrWhyLast = (): string => ocrWhy;
