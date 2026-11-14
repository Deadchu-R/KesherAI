/** A compiler problem to mark in the code (from Unity or Unreal). */
export interface CodeProblem { line: number; column: number; code: string; message: string; severity: "error" | "warning" }

/** What every code editor of KesherAI takes. */
export interface EditorProps {
  path: string;
  value: string;
  onChange: (v: string) => void;
  /** Monaco's language id; by default from the path. */
  language?: string;
  problems?: CodeProblem[];
  projectTypes?: string[];
  onSave?: () => void;
  readOnly?: boolean;
  minimap?: boolean;
  className?: string;
  /** The file's full path on the computer: shows "open in your editor" at the cursor's line. */
  fullPath?: string;
  /** A language server for this file (Rider-like help): its WebSocket, the project folder and the file's full path. */
  lsp?: { url: string; root: string; file: string; onStatus?: (s: string) => void };
}

/** What the toolbar asks of the editor engine (VS Code's or the touch one). */
export interface EditorHandle {
  /** Opens the suggestion list at the cursor. */
  suggest: () => void;
  /** Inserts text at the cursor (a tab, or the AI's continuation). */
  insert: (text: string) => void;
  undo: () => void;
  redo: () => void;
  /** The text before and after the cursor. */
  around: () => { prefix: string; suffix: string };
  focus: () => void;
  /** The cursor's line (1-based), for opening the file there in another editor. */
  line: () => number;
}
