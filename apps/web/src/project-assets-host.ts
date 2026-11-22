import { api, withToken } from "./api";

/**
 * The plugin pages' "Open from project" methods (packages/core/src/routes/project-assets.ts): the found Unity and
 * Unreal projects, their assets by kind, an asset's bytes (or a prefab's objects), and saves back that the computer
 * approves. Only KesherAI's own editors may use them (a project's files are not for any installed plugin).
 */

/** The editors that may open project assets. */
export const PROJECT_EDITORS = new Set(["model-editor", "image-editor", "sound-editor", "video-editor"]);

/** What one page opened last (a prefab's meshes are read from that project through `standin.asset`). */
export interface OpenedProject {
  engine?: "unity" | "unreal";
  project?: string;
}

const enc = encodeURIComponent;
const engineOf = (v: unknown): "unity" | "unreal" => {
  if (v !== "unity" && v !== "unreal") throw new Error("A Unity or Unreal project.");
  return v;
};

/** Reads an error body ({ error, code }) into an Error that carries the code. */
async function failed(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return Object.assign(new Error(j.error ?? String(res.status)), { code: j.code });
}

/**
 * Runs one `project.*` method for a plugin page.
 *
 * @param pluginId - The page's plugin.
 * @param method - project.list, project.assets, project.read, project.save, project.saveStatus, project.approve or
 *   project.discard.
 * @param p - The page's parameters.
 * @param opened - This page's last opened project (updated by project.read).
 * @returns The answer.
 */
export async function projectAssetCall(pluginId: string, method: string, p: Record<string, unknown>, opened: OpenedProject): Promise<unknown> {
  if (!PROJECT_EDITORS.has(pluginId)) throw new Error("Only KesherAI's editors can open game project files.");
  switch (method) {
    case "project.list":
      return (await api<{ projects: unknown[] }>("/api/project-assets/projects")).projects;
    case "project.assets": {
      const kinds = (Array.isArray(p.kinds) ? p.kinds : []).map(String).join(",");
      return api(`/api/project-assets/list?engine=${engineOf(p.engine)}&project=${enc(String(p.project ?? ""))}&kind=${enc(kinds)}`);
    }
    case "project.read": {
      const engine = engineOf(p.engine);
      const project = String(p.project ?? "");
      const path = String(p.path ?? "");
      const q = `engine=${engine}&project=${enc(project)}&path=${enc(path)}`;
      if (engine === "unity" && /\.prefab$/i.test(path)) {
        const r = await api<{ objects: unknown[]; view?: string; bounds?: unknown }>(`/api/project-assets/prefab?project=${enc(project)}&path=${enc(path)}`);
        Object.assign(opened, { engine, project });
        return { prefab: r };
      }
      const res = await fetch(withToken(`/api/project-assets/file?${q}`));
      if (!res.ok) throw await failed(res);
      Object.assign(opened, { engine, project });
      return { bytes: await res.arrayBuffer(), format: res.headers.get("x-kesher-format") ?? "", cached: res.headers.get("x-kesher-cached") === "1" };
    }
    case "project.save": {
      const bytes = p.bytes as ArrayBuffer;
      if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 300 * 1024 ** 2) throw new Error("A file up to 300 MB.");
      const q = `engine=${engineOf(p.engine)}&project=${enc(String(p.project ?? ""))}&path=${enc(String(p.path ?? ""))}&mode=${p.mode === "replace" ? "replace" : "new"}`;
      const res = await fetch(withToken(`/api/project-assets/save?${q}`), { method: "POST", headers: { "content-type": "application/x-kesher-asset" }, body: bytes });
      if (!res.ok) throw await failed(res);
      return res.json();
    }
    case "project.saveStatus":
      return api(`/api/project-assets/saves/${enc(String(p.id ?? ""))}`);
    case "project.approve":
      return api(`/api/project-assets/saves/${enc(String(p.id ?? ""))}/approve`, { method: "POST" });
    case "project.discard":
      return api(`/api/project-assets/saves/${enc(String(p.id ?? ""))}/discard`, { method: "POST" });
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
