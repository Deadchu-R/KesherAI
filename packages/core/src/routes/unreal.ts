import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type WebSocket from "ws";
import type { KesherServices } from "../services.js";
import type { UnityCli } from "../unity-cli.js";
import { isLocalRequest } from "../auth.js";
import { editGraph } from "../graph-edit.js";
import { modelTurnFor } from "../conversations.js";
import { blueprintToCode, codeText, type CodeNode } from "@kesher/shared";
import { describeRun, judgeRun, runBlueprintTest } from "../blueprint-test.js";
import { runUnityTest } from "../unity-test.js";
import { projectPath } from "../unity-tools.js";
import { connectUnityAssistant } from "../unity-assistant.js";
import { applyCodeAnswer, codeEditPrompt, parseCodeErrors, type CodeError } from "../code-errors.js";
import { BRIDGE_VERSION } from "../unreal-bridge.js";
import { editWidget, type WidgetNode } from "../widget-edit.js";
import { figmaFrame, figmaNodeTree, parseFigmaLink } from "../figma.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { figmaToWidgetOps, type FigmaNode } from "../figma-umg.js";
import { BridgeInstaller, enableUnrealMcp, findEngines, installUnityPackage } from "../unreal-install.js";
import { MCP_PRESETS } from "../mcp.js";
import { findGameProjects, listUnityScripts } from "../game-projects.js";
import { readFile as readFileFs } from "node:fs/promises";

/** The plugin and package versions that edit variables. */
const VARS_UNREAL = "0.1.9";
const VARS_UNITY = "0.2.2";
/** Whether version a is b or newer. */
const atLeast = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

/** Where the plugin is downloaded from (published by .github/workflows/unreal-plugin.yml). */
export const BRIDGE_DOWNLOAD = "https://github.com/Deadchu-R/KesherAI/releases/download/unreal-plugin-latest/KesherAIBridge.zip";

/** Where the Unity package comes from in Unity's Package Manager (Add package from git URL). */
/** The KesherAI Unity package's current version (integrations/unity/com.kesherai.bridge/package.json; a test keeps them equal). */
export const UNITY_PACKAGE_VERSION = "0.2.5";
export const UNITY_PACKAGE_URL = "https://github.com/Deadchu-R/KesherAI.git?path=/integrations/unity/com.kesherai.bridge";

/**
 * The Unreal page.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function unrealRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  await editorRoutes(app, s, "unreal");
}

/**
 * The Unity page (Visual Scripting).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function unityRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  await editorRoutes(app, s, "unity");
}

/**
 * An editor page (Unreal or Unity): the editor's connection (the KesherAI
 * Bridge plugin or package), its graphs, and changing them in words.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param kind - Which editor.
 */
async function editorRoutes(app: FastifyInstance, s: KesherServices, kind: "unreal" | "unity"): Promise<void> {
  const b = kind === "unreal" ? s.unreal : s.unity;
  const unreal = s.unreal;
  const base = `/api/${kind}`;
  const name = kind === "unreal" ? "The Unreal Editor" : "The Unity Editor";

  /** The Unreal editor connects here; only from this computer. (Unity goes through its CLI.) */
  if (kind === "unreal") app.get(`${base}/ws`, {
    websocket: true,
    preHandler: async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: `${name} connects from this computer only.` });
    },
  }, (socket) => unreal.attach(socket as unknown as WebSocket));

  app.get(base, async () => ({ ...(await b.status()), latestBridge: kind === "unreal" ? BRIDGE_VERSION : UNITY_PACKAGE_VERSION, download: kind === "unreal" ? BRIDGE_DOWNLOAD : UNITY_PACKAGE_URL }));

  app.get(`${base}/blueprints`, async () => b.list());

  app.get<{ Querystring: { path?: string } }>(`${base}/graph`, async (req, reply) => {
    if (!req.query.path) return reply.code(400).send({ error: "Which Blueprint?" });
    try {
      return await b.graph(req.query.path);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /**
   * Changes a graph as the user asks, with the active chat model. With the
   * editor connected the change is made at once (one undo step) and the
   * Blueprint compiled; with it closed, the change waits in the queue.
   */
  app.post<{ Body: { path?: string; graph?: string; request?: string; model?: string } }>(`${base}/edit`, async (req, reply) => {
    const path = String(req.body?.path ?? "");
    // Up to 8,000 characters: the code view sends the graph's code before and after.
    const request = String(req.body?.request ?? "").trim().slice(0, 8000);
    if (!path || !request) return reply.code(400).send({ error: "Choose a Blueprint and say what to change." });
    // The model the page picked (a chat model that exists here), else the active chat model.
    const picked = typeof req.body?.model === "string" ? req.body.model : "";
    const chat = picked && (await s.registry.listAllModels().then((r) => r.models, () => [])).some((m) => m.id === picked && m.category === "chat") ? picked : s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it makes the change." });
    try {
      return await editGraph(kind, b, s.registry, chat, { path, ...(req.body?.graph ? { graph: req.body.graph } : {}), request, signal: AbortSignal.timeout(300_000) });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // "Test": play the game in the editor for a few seconds, then a model says whether the Blueprint did what it should.
  {
    let testing = false;
    app.post<{ Body: { path?: string; seconds?: number; goal?: string; model?: string; judge?: boolean; lang?: string } }>(`${base}/test`, async (req, reply) => {
      const path = String(req.body?.path ?? "");
      if (testing) return reply.code(409).send({ error: "A test is already running." });
      testing = true;
      try {
        const run = kind === "unity" ? await runUnityTest(s.unity, { seconds: Number(req.body?.seconds ?? 6), dir: join(s.paths.root, "unity-test") }) : await runBlueprintTest(s.unreal, path, { seconds: Number(req.body?.seconds ?? 6) });
        const pictureId = run.picture ? (await s.assets.save(run.picture, "image/png", { meta: { use: `${kind}-test` } })).id : undefined;
        let verdict = "";
        if (req.body?.judge !== false) {
          const picked = typeof req.body?.model === "string" ? req.body.model : "";
          const chat = picked && (await s.registry.listAllModels().then((r) => r.models, () => [])).some((m) => m.id === picked && m.category === "chat") ? picked : s.config.activeModels.chat;
          if (chat && (path || kind === "unity")) {
            const graph = path ? (await b.graph(path)).graph : { name: "the open scene", graphs: [] };
            verdict = await judgeRun(s.registry, chat, graph, path, run, String(req.body?.goal ?? "").slice(0, 1000), AbortSignal.timeout(180_000), req.body?.lang === "he" ? "he" : "en", kind).catch((e: Error) => `(The model could not check the run: ${e.message})`);
          }
        }
        const { picture: _p, ...rest } = run;
        return { ...rest, ...(pictureId ? { pictureId } : {}), summary: describeRun(run, path, kind), verdict };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      } finally {
        testing = false;
      }
    });
  }

  // The Blueprint in Verse (Unreal 6 / UEFN), translated by the chosen model from the graph as code and the first draft.
  // The graph in a real language, translated by the chosen model from the graph as code (and a first draft):
  // Unreal → C++ or Verse (Unreal 6 / UEFN); Unity → C#. Read-only: for reading, porting and learning.
  /** The chat model a request picked (when it is a chat model here), else the active one. */
  const chatModel = async (picked?: unknown) => {
    const want = typeof picked === "string" ? picked : "";
    const chat = want && (await s.registry.listAllModels().then((r) => r.models, () => [])).some((m) => m.id === want && m.category === "chat") ? want : s.config.activeModels.chat;
    if (!chat) throw Object.assign(new Error("Choose a chat model first (Models & downloads)."), { code: 400 });
    return chat;
  };
  const translate = async (req: { body?: { path?: string; graph?: string; draft?: string; model?: string } }, lang: string) => {
    const path = String(req.body?.path ?? "");
    const picked = typeof req.body?.model === "string" ? req.body.model : "";
    const chat = picked && (await s.registry.listAllModels().then((r) => r.models, () => [])).some((m) => m.id === picked && m.category === "chat") ? picked : s.config.activeModels.chat;
    if (!path || !chat) throw Object.assign(new Error("Choose a graph and a chat model."), { code: 400 });
    const { graph } = await b.graph(path);
    const g = graph.graphs.find((x) => x.name === req.body?.graph) ?? graph.graphs[0];
    if (!g) throw Object.assign(new Error("The graph is empty."), { code: 400 });
    const code = codeText(blueprintToCode(g.nodes as CodeNode[])).slice(0, 6000);
    const draft = String(req.body?.draft ?? "").slice(0, 6000);
    const rules: Record<string, string> = {
      verse: "Translate this Unreal Blueprint into Verse, the gameplay language of Unreal 6 and UEFN. Rules: a class `name_device := class(creative_device):` with `using { /Fortnite.com/Devices }` and `using { /Verse.org/Simulation }`; BeginPlay → `OnBegin<override>()<suspends>:void=`; Print String → Print(\"...\"); Delay → Sleep(seconds) (only inside <suspends> functions); Branch → if (Condition?): / else:; variables → `var Name:type = value` fields and `set Name = value`; failure contexts use `?` and `[]`. Use only Verse APIs you are sure exist; where Blueprint has no Verse equivalent, keep a `# check:` comment that says what to do.",
      cpp: `Translate this Unreal Blueprint into Unreal Engine 5 C++: the header (.h) then the source (.cpp), for a class A${graph.name.replace(/^BP_/, "")} : public ${graph.parent && /^[AU]/.test(graph.parent) ? graph.parent : `A${graph.parent ?? "Actor"}`} in a module named YOURGAME_API. Rules: #include "${graph.name.replace(/^BP_/, "")}.generated.h" last in the header; UCLASS(), GENERATED_BODY(); variables as UPROPERTY(EditAnywhere, BlueprintReadWrite); BeginPlay/Tick as virtual overrides calling Super::; Print String → GEngine->AddOnScreenDebugMessage and UE_LOG; Delay → GetWorldTimerManager().SetTimer with an FTimerHandle; Branch → if; casts → Cast<T>(); events bound to delegates with AddDynamic and a UFUNCTION handler. Keep the Blueprint's names. Mark anything you are not sure of with // check:.`,
      csharp: "Translate this Unity Visual Scripting graph into a Unity C# MonoBehaviour. Rules: using UnityEngine; class name = the graph's name in PascalCase; On Start → void Start(), On Update → void Update(), On Trigger Enter → OnTriggerEnter(Collider other), On Collision Enter → OnCollisionEnter(Collision c); graph variables → [SerializeField] private fields; Debug Log → Debug.Log; Wait For Seconds → a coroutine (IEnumerator, yield return new WaitForSeconds, StartCoroutine); If → if; Get/Set Variable → the field. Keep the graph's names. Mark anything you are not sure of with // check:.",
    };
    const prompt = [
      `${rules[lang]}`,
      `The graph: ${graph.name}${graph.parent ? ` (parent ${graph.parent})` : ""}, as code (one line per node, in the order the flow wires run):`,
      code,
      ...(draft ? ["", "A mechanical first draft (may be wrong):", draft] : []),
      "",
      "Answer with the code only, in code blocks.",
    ].join("\n");
    const r = await modelTurnFor(s.registry, chat)({ messages: [{ role: "user", content: prompt }], tools: [] }, AbortSignal.timeout(240_000), () => undefined);
    const blocks = [...r.text.matchAll(/```[\w+#-]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
    return blocks.length ? blocks.join("\n\n") : r.text.trim();
  };
  const LANGS = kind === "unreal" ? ["cpp", "verse"] : ["csharp"];
  app.post<{ Body: { path?: string; graph?: string; draft?: string; model?: string; lang?: string } }>(`${base}/translate`, async (req, reply) => {
    const lang = String(req.body?.lang ?? "");
    if (!LANGS.includes(lang)) return reply.code(400).send({ error: `Languages here: ${LANGS.join(", ")}.` });
    try {
      return { code: await translate(req, lang) };
    } catch (err) {
      return reply.code((err as { code?: number }).code === 400 ? 400 : 502).send({ error: (err as Error).message });
    }
  });
  if (kind === "unreal") {
    // The older name of the Verse translation.
    app.post<{ Body: { path?: string; graph?: string; draft?: string; model?: string } }>(`${base}/verse`, async (req, reply) => {
      try {
        return { verse: await translate(req, "verse") };
      } catch (err) {
        return reply.code((err as { code?: number }).code === 400 ? 400 : 502).send({ error: (err as Error).message });
      }
    });
  }

  /**
   * When something last changed in the editor (ms), for the page to read the open graph only then.
   * Unity: the package's kesher_changed (any edit, undo or saved asset; package 0.2.5). Unreal: the last compile.
   * Older Unity packages answer 0 (the page then reads the graph every 10 seconds as before).
   */
  app.get(`${base}/changed`, async () => {
    if (kind === "unreal") return { changedAt: ((await b.status()) as { changedAt?: number }).changedAt ?? 0 };
    // Only the open editor is asked (a closed Unity is never started for this).
    return { changedAt: await (b as UnityCli).changedAt() };
  });

  /** Applies operations as given (for "Apply again" and plugins). */
  app.post<{ Body: { path?: string; graph?: string; ops?: unknown[] } }>(`${base}/apply`, async (req, reply) => {
    const { path, graph = "", ops } = req.body ?? {};
    if (!path || !Array.isArray(ops)) return reply.code(400).send({ error: "Send the Blueprint and the operations." });
    try {
      return await b.request("apply", { path, graph, ops: kind === "unity" ? JSON.stringify(ops) : ops });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * The Blueprint's (or Script Graph's) own variables, like My Blueprint → Variables: add, change
   * (name, type, starting value, shown in the level / Inspector, tooltip, category), remove.
   * Unreal plugin 0.1.9+, Unity package 0.2.2+. Answers with the results and the graph read again.
   */
  app.post<{ Body: { path?: string; ops?: unknown[] } }>(`${base}/vars`, async (req, reply) => {
    const { path, ops } = req.body ?? {};
    if (!path || !Array.isArray(ops) || !ops.length || ops.length > 50) return reply.code(400).send({ error: "Send the Blueprint and the variable changes." });
    const st = await b.status();
    const have = st.editor?.bridge ?? "";
    const need = kind === "unity" ? VARS_UNITY : VARS_UNREAL;
    if (st.connected && have && !atLeast(have, need)) return reply.code(409).send({ error: kind === "unity" ? `Variables need the KesherAI Unity package ${need} (installed ${have}). Update it from this page.` : `Variables need the KesherAI Bridge plugin ${need} (installed ${have}). Press "Update automatically" at the top of the Unreal page.` });
    try {
      const out = await b.request<{ results: unknown[]; failed: number }>("vars", { path, ops: kind === "unity" ? JSON.stringify(ops) : ops }, 120_000);
      const graph = await b.graph(path).catch(() => undefined);
      return { ...out, ...(graph ? { graph: graph.graph } : {}) };
    } catch (err) {
      const msg = (err as Error).message;
      if (kind === "unity" && /kesher_vars/.test(msg)) return reply.code(409).send({ error: `Variables need the KesherAI Unity package ${VARS_UNITY}. Update it from this page.` });
      return reply.code(502).send({ error: msg });
    }
  });

  if (kind === "unity") {
    /** The fuzzy finder's nodes, matching the words typed (Unity package 0.2.4+). */
    app.get<{ Querystring: { path?: string; q?: string } }>(`${base}/actions`, async (req, reply) => {
      try {
        return await b.request("actions", { path: String(req.query.path ?? ""), query: String(req.query.q ?? "").slice(0, 100) }, 30_000);
      } catch (err) {
        const msg = (err as Error).message;
        return reply.code(/kesher_actions/.test(msg) ? 409 : 502).send({ error: /kesher_actions/.test(msg) ? "The node menu needs the KesherAI Unity package 0.2.4. Update it from this page." : msg });
      }
    });
    /** Ctrl+Z / Ctrl+Y in the page: Unity's own undo and redo (package 0.2.4+). */
    for (const cmd of ["undo", "redo"] as const) {
      app.post(`${base}/${cmd}`, async (_req, reply) => {
        try {
          return await b.request(cmd, {});
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      });
    }
  }

  for (const cmd of ["compile", "save", "open"] as const) {
    app.post<{ Body: { path?: string } }>(`${base}/${cmd}`, async (req, reply) => {
      if (!req.body?.path) return reply.code(400).send({ error: "Which Blueprint?" });
      try {
        return await b.request(cmd, { path: req.body.path }, cmd === "compile" ? 120_000 : 30_000);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
  }

  if (kind === "unreal") {
    /** A new Blueprint: made now, or (Unreal closed) when the project opens. */
    app.post<{ Body: { name?: string; folder?: string; parent?: string } }>(`${base}/create`, async (req, reply) => {
      try {
        return await unreal.createBlueprint(String(req.body?.name ?? ""), String(req.body?.folder ?? "/Game/Blueprints"), String(req.body?.parent ?? "Actor"));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Unreal's right-click menu: nodes that can be added, matching the words typed (plugin 0.1.4+). */
    app.get<{ Querystring: { path?: string; q?: string } }>(`${base}/actions`, async (req, reply) => {
      if (!req.query.path) return reply.code(400).send({ error: "Which Blueprint?" });
      try {
        return await unreal.request("actions", { path: req.query.path, query: String(req.query.q ?? "").slice(0, 100) }, 20_000);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
    /** Widget Blueprints (UMG, plugin 0.1.5+): the widget tree for the Designer view. */
    app.get<{ Querystring: { path?: string } }>(`${base}/widget`, async (req, reply) => {
      if (!req.query.path) return reply.code(400).send({ error: "Which Widget Blueprint?" });
      try {
        return await unreal.request("widget", { path: req.query.path }, 30_000);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
    /** The Designer's own changes (move, resize, text, colors): applied in the editor as one undo step. */
    app.post<{ Body: { path?: string; ops?: unknown[] } }>(`${base}/widget/apply`, async (req, reply) => {
      if (!req.body?.path || !Array.isArray(req.body.ops)) return reply.code(400).send({ error: "Send the Widget Blueprint and the operations." });
      try {
        return await unreal.request("widget_apply", { path: req.body.path, ops: req.body.ops.slice(0, 200) }, 30_000);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
    /**
     * Figma → Unreal widgets: a frame's link (with the user's Figma token, Settings → Appearance) becomes
     * widgets in the Widget Blueprint, inside the chosen panel (or as the root when it is empty).
     */
    app.post<{ Body: { path?: string; link?: string; parent?: string } }>(`${base}/widget/figma`, async (req, reply) => {
      const token = s.config.figma.token;
      if (!token) return reply.code(400).send({ error: "Connect Figma first: Settings → Appearance → Figma (a personal access token)." });
      const f = parseFigmaLink(String(req.body?.link ?? ""));
      if (!f?.node) return reply.code(400).send({ error: "Paste the link of a frame: in Figma right-click it → Copy link to selection." });
      const path = String(req.body?.path ?? "");
      if (!path) return reply.code(400).send({ error: "Which Widget Blueprint?" });
      try {
        const tree = await unreal.request<{ root?: WidgetNode }>("widget", { path }, 30_000);
        const names: string[] = [];
        const walk = (w?: WidgetNode) => {
          if (!w) return;
          names.push(w.name);
          (w.children ?? []).forEach(walk);
        };
        walk(tree.root);
        const findW = (w: WidgetNode | undefined, n: string): WidgetNode | undefined => (!w ? undefined : w.name === n ? w : (w.children ?? []).map((c) => findW(c, n)).find(Boolean));
        const parent = String(req.body?.parent ?? "") || (tree.root && /Panel|Box|Overlay/.test(tree.root.class) ? tree.root.name : "");
        if (tree.root && !parent) return reply.code(400).send({ error: "Choose the panel the design goes into (in the Hierarchy)." });
        const doc = (await figmaNodeTree(token, f.key, f.node)) as FigmaNode;
        const { ops, notes, images } = figmaToWidgetOps(doc, parent, names, 300, /CanvasPanel/.test(findW(tree.root, parent)?.class ?? ""));
        const result = await unreal.request<{ results: Array<{ ok: boolean; error?: string }>; failed: number }>("widget_apply", { path, ops }, 60_000);
        // Pictures: Figma renders each one, Unreal imports it as a texture (/Game/UI/Figma), and its Image shows it.
        const dir = join(s.paths.root, "unreal", "figma");
        await mkdir(dir, { recursive: true });
        const brushes: Array<Record<string, string>> = [];
        for (const img of images.slice(0, 20)) {
          try {
            const png = await figmaFrame(token, f.key, img.node);
            const file = join(dir, `${img.widget}.png`);
            await writeFile(file, png);
            const r = await unreal.request<{ asset: string }>("import_texture", { file, folder: "/Game/UI/Figma", name: `T_${img.widget}` }, 120_000);
            const asset = r.asset.includes(".") ? r.asset : `${r.asset}.${r.asset.split("/").pop()}`;
            brushes.push({ op: "set", widget: img.widget, property: "Brush", value: `(ResourceObject=/Script/Engine.Texture2D'${asset}',ImageSize=(X=${img.w},Y=${img.h}))` }, { op: "set", widget: img.widget, property: "ColorAndOpacity", value: "(R=1,G=1,B=1,A=1)" });
          } catch (err) {
            notes.push(`${img.widget}: the picture did not come over (${(err as Error).message}).`);
          }
        }
        if (images.length > 20) notes.push(`Only the first 20 pictures came over as textures.`);
        if (brushes.length) await unreal.request("widget_apply", { path, ops: brushes }, 60_000).catch((err: Error) => notes.push(`Setting the pictures: ${err.message}`));
        return { added: ops.filter((o) => o.op === "add").length, pictures: brushes.length / 2, notes, result };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });

    /** A Widget Blueprint changed in words (the Designer's AI bubble). */
    app.post<{ Body: { path?: string; request?: string; selected?: string; model?: string } }>(`${base}/widget/edit`, async (req, reply) => {
      const path = String(req.body?.path ?? "");
      const request = String(req.body?.request ?? "").trim().slice(0, 8000);
      if (!path || !request) return reply.code(400).send({ error: "Choose a Widget Blueprint and say what to change." });
      const picked = typeof req.body?.model === "string" ? req.body.model : "";
      const chat = picked && (await s.registry.listAllModels().then((r) => r.models, () => [])).some((m) => m.id === picked && m.category === "chat") ? picked : s.config.activeModels.chat;
      if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it makes the change." });
      try {
        return await editWidget(unreal, s.registry, chat, { path, request, ...(req.body?.selected ? { selected: String(req.body.selected).slice(0, 120) } : {}), signal: AbortSignal.timeout(300_000) });
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });

    /** Ctrl+Z / Ctrl+Y in the page: the editor's own undo and redo. */
    for (const cmd of ["undo", "redo"] as const) {
      app.post(`${base}/${cmd}`, async (_req, reply) => {
        try {
          return await unreal.request(cmd, {}, 15_000);
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      });
    }
  }

  app.get(`${base}/queue`, async () => b.queue());
  app.delete<{ Params: { id: string } }>(`${base}/queue/:id`, async (req) => ({ removed: await b.unqueue(req.params.id) }));

  if (kind === "unity") {
    const unity = s.unity;
    /**
     * Prepares a Unity project (Unity 6+): copies the KesherAI Bridge package into
     * Packages/ and adds Unity's Pipeline package with its CLI. Only on this computer.
     */
    app.post<{ Body: { project?: string } }>(`${base}/install`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Add the package on the computer that runs KesherAI." });
      if (!req.body?.project) return reply.code(400).send({ error: "Choose the project folder." });
      try {
        return { message: await unity.install(req.body.project, installUnityPackage) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Unity's CLI with no project needed: its version, the editors installed, and a project being made. */
    app.get(`${base}/cli`, async () => unity.cliInfo());
    /** Makes a new project with Unity's CLI (in the background). Only on this computer. */
    app.post<{ Body: { name?: string; parent?: string; editor?: string; template?: string; open?: boolean } }>(`${base}/create`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Make the project on the computer that runs KesherAI." });
      try {
        unity.createProject({ name: String(req.body?.name ?? ""), parent: String(req.body?.parent ?? ""), ...(req.body?.editor ? { editor: String(req.body.editor) } : {}), ...(req.body?.template ? { template: String(req.body.template) } : {}), open: req.body?.open === true }, installUnityPackage);
        return unity.cliInfo();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Updates Unity's CLI (`unity self-update`). Only on this computer. */
    /** Opens a window on this computer that shows every Unity CLI command live. Only on this computer. */
    app.post(`${base}/cli/live`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Open it on the computer that runs KesherAI." });
      try {
        return { message: await unity.openLiveWindow() };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Adds a build platform (Android…) to the project's Unity version, in a window. Only on this computer. */
    app.post<{ Body: { platform?: string } }>(`${base}/cli/platform`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Do this on the computer that runs KesherAI." });
      try {
        return { message: await unity.installPlatform(String(req.body?.platform ?? "")) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Installs Unity's CLI with Unity's own installer (a window shows it). Only on this computer. */
    app.post(`${base}/cli/install`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Install Unity's CLI on the computer that runs KesherAI." });
      return { message: unity.installCli() };
    });
    app.post(`${base}/cli/update`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Update Unity's CLI on the computer that runs KesherAI." });
      try {
        return { message: await unity.selfUpdate() };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Opens the shown project in the Unity editor. Only on this computer. */
    app.post(`${base}/open-editor`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Open Unity on the computer that runs KesherAI." });
      try {
        await unity.openProject();
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Adds a project folder, or picks which one the page shows. Only on this computer. */
    // C# scripts as nodes: list the project's scripts, read one, write it back (only .cs inside Assets/, and only
    // when the file did not change meanwhile; the old text is kept in KesherAI's folder first).
    app.get(`${base}/scripts`, async (_req, reply) => {
      const project = unity.activeProject;
      if (!project) return reply.code(400).send({ error: "Choose a Unity project first." });
      return listUnityScripts(project);
    });
    app.get<{ Querystring: { path?: string } }>(`${base}/script`, async (req, reply) => {
      const project = unity.activeProject;
      if (!project) return reply.code(400).send({ error: "Choose a Unity project first." });
      try {
        const { abs, rel } = projectPath(project, String(req.query.path ?? ""), ["Assets"]);
        if (!rel.endsWith(".cs")) return reply.code(400).send({ error: "Only C# scripts (.cs)." });
        const st = await stat(abs);
        if (st.size > 400_000) return reply.code(400).send({ error: "The script is too big to show as nodes." });
        return { path: rel, text: await readFileFs(abs, "utf8"), mtime: st.mtimeMs };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    app.put<{ Body: { path?: string; text?: string; mtime?: number } }>(`${base}/script`, async (req, reply) => {
      const project = unity.activeProject;
      if (!project) return reply.code(400).send({ error: "Choose a Unity project first." });
      try {
        const { abs, rel } = projectPath(project, String(req.body?.path ?? ""), ["Assets"]);
        const text = String(req.body?.text ?? "");
        if (!rel.endsWith(".cs") || !text.trim() || text.length > 400_000) return reply.code(400).send({ error: "Send a C# script (.cs) under 400 KB." });
        const st = await stat(abs);
        if (req.body?.mtime && Math.abs(st.mtimeMs - Number(req.body.mtime)) > 1) return reply.code(409).send({ error: "The script changed since it was opened (in Unity or a chat). Open it again." });
        const before = await readFileFs(abs, "utf8");
        const backups = join(s.paths.root, "unity-backups");
        await mkdir(backups, { recursive: true });
        await writeFile(join(backups, `${rel.replace(/[\\/]/g, "_")}-${Date.now()}.cs`), before);
        await writeFile(abs, text);
        // Unity compiles it when it notices; ask now when its CLI is there (a failure is fine).
        void unity.cliRaw(["recompile", "--project-path", project], 120_000).catch(() => undefined);
        return { path: rel, mtime: (await stat(abs)).mtimeMs };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    // The code editor: Unity compiles the scripts now and its errors come back with file, line and column.
    app.post(`${base}/scripts/compile`, async (_req, reply) => {
      const project = unity.activeProject;
      if (!project) return reply.code(400).send({ error: "Choose a Unity project first." });
      const r = await unity.cliRaw(["recompile", "--project-path", project, "--format", "json"], 240_000).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
      const text = `${r.stdout}\n${r.stderr}`;
      const errors = parseCodeErrors(text, project);
      const offline = r.code === 7 || /EDITOR_NOT_RUNNING|no (running|open) editor|could not connect|not connected/i.test(text);
      return { ok: r.code === 0 && !errors.some((e) => e.severity === "error"), offline, errors, ...(offline ? { note: "Unity is not open, so the scripts were not compiled. Open the project in Unity." } : r.code !== 0 && !errors.length ? { note: text.trim().slice(-600) } : {}) };
    });
    // The AI bubble in the script editor: the model changes the whole script as asked (or fixes the errors); the page shows the change before saving.
    app.post<{ Body: { path?: string; text?: string; request?: string; errors?: CodeError[]; model?: string } }>(`${base}/script/ai`, async (req, reply) => {
      const project = unity.activeProject;
      if (!project) return reply.code(400).send({ error: "Choose a Unity project first." });
      try {
        const { rel } = projectPath(project, String(req.body?.path ?? ""), ["Assets"]);
        const text = String(req.body?.text ?? "");
        if (!rel.endsWith(".cs") || text.length > 400_000) return reply.code(400).send({ error: "Send a C# script under 400 KB." });
        const chat = await chatModel(req.body?.model);
        const prompt = codeEditPrompt({ language: "csharp", engine: "unity", path: rel, text, request: String(req.body?.request ?? "").slice(0, 4000), errors: Array.isArray(req.body?.errors) ? req.body.errors.slice(0, 30) : [] });
        const r = await modelTurnFor(s.registry, chat)({ messages: [{ role: "user", content: prompt }], tools: [] }, AbortSignal.timeout(300_000), () => undefined);
        const put = applyCodeAnswer(text, r.text);
        const note = r.text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```[\s\S]*?```/g, "").replace(/<{5,}[\s\S]*?>{5,}\s*REPLACE/g, "").trim().split("\n").filter(Boolean).pop() ?? "";
        return { code: put.code, note: `${note.slice(0, 400)}${put.missed ? ` (${put.missed} of ${put.blocks} changes did not match the file and were left out)` : ""}`, model: chat };
      } catch (err) {
        return reply.code((err as { code?: number }).code === 400 ? 400 : 502).send({ error: (err as Error).message });
      }
    });

    // Unity projects found on this computer (Unity Hub's list and the usual folders) that are not added yet.
    const foundUnity = async () => (await findGameProjects({ unity: s.config.unity.projects })).filter((p) => p.kind === "unity");
    app.get(`${base}/found`, async () => ({ projects: (await foundUnity()).filter((p) => !s.config.unity.projects.includes(p.path)) }));

    // Unity AI Assistant gets KesherAI's tools (local models, images, knowledge) through its MCP settings. On this computer only.
    app.post(`${base}/assistant-connect`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Connect Unity AI Assistant on the computer that runs KesherAI." });
      const project = unity.activeProject;
      if (!project || !s.deviceKeys) return reply.code(400).send({ error: "Choose a Unity project first." });
      try {
        const key = await s.deviceKeys.issue("Unity AI Assistant", "mcp");
        const file = await connectUnityAssistant(project, `http://127.0.0.1:${s.config.port}/mcp`, key);
        return { file, message: "KesherAI was added to Unity AI Assistant. In Unity: Edit → Project Settings → AI → Assistant MCP Extensions → Refresh File and Servers." };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    app.put<{ Body: { project?: string } }>(`${base}/project`, async (req, reply) => {
      // From the phone: projects already added, or ones found on the computer; any other folder is chosen on the computer.
      const want = String(req.body?.project ?? "");
      if (!isLocalRequest(req) && !s.config.unity.projects.includes(want) && !(await foundUnity()).some((p) => p.path === want)) return reply.code(403).send({ error: "Add a new project on the computer that runs KesherAI." });
      try {
        await unity.addProject(String(req.body?.project ?? ""));
        return unity.status();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    return;
  }

  const installer = new BridgeInstaller(join(s.paths.root, "unreal", "_built"));

  /**
   * Unreal 5.8+: turns on the engine's own MCP server in a project and connects KesherAI's chats to it
   * (the "Unreal Engine" MCP server, 127.0.0.1:8000). Only on this computer.
   */
  app.post<{ Body: { project?: string } }>("/api/unreal/mcp-setup", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Set up the project on the computer that runs KesherAI." });
    if (!req.body?.project) return reply.code(400).send({ error: "Choose the project folder." });
    try {
      const message = await enableUnrealMcp(req.body.project);
      await s.mcp.load();
      const preset = MCP_PRESETS.find((p) => p.id === "unreal")!;
      const have = s.mcp.list().find((m) => m.preset === "unreal");
      if (!have) await s.mcp.upsert({ id: "unreal", name: preset.name, transport: "http", url: preset.url!, headers: {}, enabled: true, preset: "unreal" });
      else if (!have.enabled) await s.mcp.upsert({ ...have, enabled: true });
      return { message };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * The plugin updates itself (the page's "Update the plugin"): builds the new
   * version while Unreal is open, asks Unreal to close (it offers to save
   * first), replaces the plugin and opens the project again. From the phone
   * too: the save question shows on the computer.
   */
  app.post("/api/unreal/update-plugin", async (_req, reply) => {
    // Plugins before 0.1.3 do not say where the project is: the project of that name in the usual folders.
    let file = unreal.projectFile;
    const name = await unreal.project();
    if (!file && name && /^[\w-]+$/.test(name)) {
      for (const dir of [join(homedir(), "Unreal Projects", name), join(homedir(), "Documents", "Unreal Projects", name)]) {
        if (existsSync(join(dir, `${name}.uproject`))) {
          file = join(dir, `${name}.uproject`);
          break;
        }
      }
    }
    if (!file) return reply.code(409).send({ error: "Open the project in Unreal first (with the plugin connected), or use Install into a project." });
    try {
      await installer.update(dirname(file), () => unreal.closeForUpdate(), file);
      return { job: installer.status() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Engines on this computer and the current install (for "Install into a project"). */
  app.get("/api/unreal/engines", async () => ({ engines: await findEngines(), job: installer.status() ?? null, windows: process.platform === "win32" }));

  /**
   * Installs the plugin into a project folder (works for Blueprint-only
   * projects): builds it once per engine version, then copies it in. Only on
   * this computer.
   */
  // The Unreal projects found on this computer, each with the KesherAI Bridge version in it (if any): one click installs or updates it.
  const unrealProjects = async () => (await findGameProjects({ ...(s.unreal.projectFile ? { unrealFile: s.unreal.projectFile } : {}) })).filter((p) => p.kind === "unreal");
  app.get("/api/unreal/projects", async () => {
    const list = await unrealProjects();
    return {
      latest: BRIDGE_VERSION,
      projects: await Promise.all(
        list.map(async (p) => {
          const raw = await readFileFs(join(p.path, "Plugins", "KesherAIBridge", "KesherAIBridge.uplugin"), "utf8").catch(() => "");
          let plugin: string | null = null;
          try {
            plugin = raw ? String((JSON.parse(raw.replace(/^\uFEFF/, "")) as { VersionName?: string }).VersionName ?? "?") : null;
          } catch {
            plugin = "?";
          }
          return { ...p, plugin, open: !!s.unreal.projectFile && dirname(s.unreal.projectFile).toLowerCase() === p.path.toLowerCase() };
        }),
      ),
    };
  });

  /**
   * Opens a project found on this computer in the Unreal Editor of its engine version (like Unity's "Open in Unity").
   * Only on this computer, and only a project from the list (never any path).
   */
  app.post<{ Body: { project?: string } }>("/api/unreal/open-editor", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Open Unreal on the computer that runs KesherAI." });
    const p = (await unrealProjects()).find((x) => x.path === req.body?.project);
    if (!p) return reply.code(400).send({ error: "Choose one of the projects found on this computer." });
    const engines = await findEngines();
    const e = engines.find((x) => x.version === p.engine) ?? (p.engine ? undefined : engines[0]);
    if (!e) return reply.code(400).send({ error: `Unreal ${p.engine ?? ""} is not installed on this computer.`.replace("  ", " ") });
    const exe = join(e.path, "Engine", "Binaries", process.platform === "win32" ? "Win64" : "Linux", process.platform === "win32" ? "UnrealEditor.exe" : "UnrealEditor");
    if (!existsSync(exe)) return reply.code(400).send({ error: `Unreal ${e.version}'s editor was not found.` });
    spawn(exe, [join(p.path, `${p.name}.uproject`)], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, engine: e.version };
  });

  app.post<{ Body: { project?: string } }>("/api/unreal/install", async (req, reply) => {
    if (!req.body?.project) return reply.code(400).send({ error: "Choose the project folder." });
    // From the phone: only a project found on the computer (never any folder by path).
    if (!isLocalRequest(req) && !(await unrealProjects()).some((p) => p.path === req.body!.project)) return reply.code(403).send({ error: "From the phone, choose one of the projects found on the computer." });
    try {
      await installer.install(req.body.project);
      return { job: installer.status() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

}
