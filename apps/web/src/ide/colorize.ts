import * as monaco from "monaco-editor";
import "./monaco-setup";

let themed = false;
/** Colours code as HTML with Monaco's own tokenizers (the theme follows the app's light or dark look). */
export async function colorize(code: string, language: string): Promise<string> {
  if (!themed) {
    monaco.editor.setTheme(document.documentElement.dataset.light === "1" ? "vs" : "vs-dark");
    themed = true;
  }
  return monaco.editor.colorize(code, language, { tabSize: 4 });
}
