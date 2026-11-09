/**
 * Target phones: the user ticks the phones a game or site is for, and builds
 * are planned and set up for them.
 *
 * How others do it (researched first): Unreal picks settings per phone at
 * start-up from Device Profiles (Android_Low/Mid/High plus GPU-family
 * profiles such as Android_Adreno5xx, chosen by matching rules on the GPU
 * family, model and Android version); Unity builds one APK (ARM64, ASTC,
 * Vulkan first) and leaves frame rate and quality to the game (Android
 * defaults to 30 fps unless the game sets Application.targetFrameRate);
 * Firebase Test Lab and Play Console's device catalog describe phones by
 * SoC, GPU, screen and Android version. KesherAI keeps a small catalog in
 * the same terms, reads the exact values from a phone plugged in by USB,
 * and turns the chosen set into a short brief for the model (the weakest
 * tier to plan for, screens, refresh rates, GPU families) plus the settings
 * it can safely apply itself.
 */

/** GPU families, as engines and driver-bug reports name them. */
export type GpuFamily = "adreno" | "mali" | "immortalis" | "xclipse" | "powervr" | "other";

/** One phone. */
export interface Phone {
  id: string;
  brand: string;
  name: string;
  soc: string;
  gpu: string;
  gpuFamily: GpuFamily;
  /** The Android version it shipped with (the oldest it can still run). */
  android: number;
  screen: { w: number; h: number; hz: number };
  ramGb?: number;
  /** Rough performance class for planning: high (flagship), mid, low (budget). */
  tier: "high" | "mid" | "low";
  /** Read from a phone plugged in (exact), not from the catalog. */
  detected?: boolean;
}

/** A small catalog of common phones (2023–2026). Values are the usual model; a phone read over USB is exact. */
export const PHONES: Phone[] = [
  { id: "oneplus-13", brand: "OnePlus", name: "OnePlus 13", soc: "Snapdragon 8 Elite", gpu: "Adreno 830", gpuFamily: "adreno", android: 15, screen: { w: 3168, h: 1440, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "oneplus-12", brand: "OnePlus", name: "OnePlus 12", soc: "Snapdragon 8 Gen 3", gpu: "Adreno 750", gpuFamily: "adreno", android: 14, screen: { w: 3168, h: 1440, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "oneplus-nord-4", brand: "OnePlus", name: "OnePlus Nord 4", soc: "Snapdragon 7+ Gen 3", gpu: "Adreno 732", gpuFamily: "adreno", android: 14, screen: { w: 2772, h: 1240, hz: 120 }, ramGb: 8, tier: "mid" },
  { id: "oneplus-nord-ce4", brand: "OnePlus", name: "OnePlus Nord CE4", soc: "Snapdragon 7 Gen 3", gpu: "Adreno 720", gpuFamily: "adreno", android: 14, screen: { w: 2412, h: 1080, hz: 120 }, ramGb: 8, tier: "mid" },
  { id: "samsung-s25-ultra", brand: "Samsung", name: "Galaxy S25 Ultra", soc: "Snapdragon 8 Elite for Galaxy", gpu: "Adreno 830", gpuFamily: "adreno", android: 15, screen: { w: 3120, h: 1440, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "samsung-s25", brand: "Samsung", name: "Galaxy S25", soc: "Snapdragon 8 Elite for Galaxy", gpu: "Adreno 830", gpuFamily: "adreno", android: 15, screen: { w: 2340, h: 1080, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "samsung-s24-ultra", brand: "Samsung", name: "Galaxy S24 Ultra", soc: "Snapdragon 8 Gen 3 for Galaxy", gpu: "Adreno 750", gpuFamily: "adreno", android: 14, screen: { w: 3120, h: 1440, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "samsung-s24", brand: "Samsung", name: "Galaxy S24 (Exynos)", soc: "Exynos 2400", gpu: "Xclipse 940", gpuFamily: "xclipse", android: 14, screen: { w: 2340, h: 1080, hz: 120 }, ramGb: 8, tier: "high" },
  { id: "samsung-a56", brand: "Samsung", name: "Galaxy A56", soc: "Exynos 1580", gpu: "Xclipse 540", gpuFamily: "xclipse", android: 15, screen: { w: 2340, h: 1080, hz: 120 }, ramGb: 8, tier: "mid" },
  { id: "samsung-a55", brand: "Samsung", name: "Galaxy A55", soc: "Exynos 1480", gpu: "Xclipse 530", gpuFamily: "xclipse", android: 14, screen: { w: 2340, h: 1080, hz: 120 }, ramGb: 8, tier: "mid" },
  { id: "samsung-a35", brand: "Samsung", name: "Galaxy A35", soc: "Exynos 1380", gpu: "Mali-G68 MP5", gpuFamily: "mali", android: 14, screen: { w: 2340, h: 1080, hz: 120 }, ramGb: 6, tier: "mid" },
  { id: "samsung-a16", brand: "Samsung", name: "Galaxy A16 5G", soc: "Exynos 1330", gpu: "Mali-G68 MP2", gpuFamily: "mali", android: 14, screen: { w: 2340, h: 1080, hz: 90 }, ramGb: 4, tier: "low" },
  { id: "samsung-a15", brand: "Samsung", name: "Galaxy A15", soc: "Helio G99", gpu: "Mali-G57 MC2", gpuFamily: "mali", android: 14, screen: { w: 2340, h: 1080, hz: 90 }, ramGb: 4, tier: "low" },
  { id: "xiaomi-15", brand: "Xiaomi", name: "Xiaomi 15", soc: "Snapdragon 8 Elite", gpu: "Adreno 830", gpuFamily: "adreno", android: 15, screen: { w: 2670, h: 1200, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "xiaomi-14t-pro", brand: "Xiaomi", name: "Xiaomi 14T Pro", soc: "Dimensity 9300+", gpu: "Immortalis-G720 MC12", gpuFamily: "immortalis", android: 14, screen: { w: 2712, h: 1220, hz: 144 }, ramGb: 12, tier: "high" },
  { id: "poco-x7-pro", brand: "Xiaomi", name: "POCO X7 Pro", soc: "Dimensity 8400-Ultra", gpu: "Mali-G720 MC7", gpuFamily: "mali", android: 15, screen: { w: 2712, h: 1220, hz: 120 }, ramGb: 8, tier: "mid" },
  { id: "redmi-note-14-pro-5g", brand: "Xiaomi", name: "Redmi Note 14 Pro 5G", soc: "Dimensity 7300-Ultra", gpu: "Mali-G615 MC2", gpuFamily: "mali", android: 14, screen: { w: 2712, h: 1220, hz: 120 }, ramGb: 8, tier: "mid" },
  { id: "redmi-note-13", brand: "Xiaomi", name: "Redmi Note 13 (4G)", soc: "Snapdragon 685", gpu: "Adreno 610", gpuFamily: "adreno", android: 13, screen: { w: 2400, h: 1080, hz: 120 }, ramGb: 6, tier: "low" },
  { id: "pixel-10", brand: "Google", name: "Pixel 10", soc: "Tensor G5", gpu: "PowerVR DXT-48-1536", gpuFamily: "powervr", android: 16, screen: { w: 2424, h: 1080, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "pixel-9", brand: "Google", name: "Pixel 9", soc: "Tensor G4", gpu: "Mali-G715 MC7", gpuFamily: "mali", android: 14, screen: { w: 2424, h: 1080, hz: 120 }, ramGb: 12, tier: "high" },
  { id: "pixel-9a", brand: "Google", name: "Pixel 9a", soc: "Tensor G4", gpu: "Mali-G715 MC7", gpuFamily: "mali", android: 15, screen: { w: 2424, h: 1080, hz: 120 }, ramGb: 8, tier: "mid" },
];

const TIER_RANK = { low: 0, mid: 1, high: 2 } as const;

/** The GPU family of a GPU name ("Adreno (TM) 830", "Mali-G715", "Xclipse 940"…). */
export function gpuFamilyOf(gpu: string): GpuFamily {
  if (/adreno/i.test(gpu)) return "adreno";
  if (/immortalis/i.test(gpu)) return "immortalis";
  if (/mali/i.test(gpu)) return "mali";
  if (/xclipse/i.test(gpu)) return "xclipse";
  if (/powervr|img\b|dxt/i.test(gpu)) return "powervr";
  return "other";
}

/** A rough tier for a phone read over USB: from its GPU and memory (catalog phones carry their own). */
export function guessTier(gpu: string, ramGb?: number): Phone["tier"] {
  const adreno = /adreno\D*(\d{3})/i.exec(gpu)?.[1];
  if (adreno) return Number(adreno) >= 740 ? "high" : Number(adreno) >= 710 ? "mid" : "low";
  if (/immortalis|xclipse 9|dxt/i.test(gpu)) return "high";
  if (/xclipse|mali-g7\d{2}|mali-g6[1-9]\d/i.test(gpu)) return "mid";
  if (ramGb !== undefined && ramGb >= 12) return "mid";
  return "low";
}

/** The chosen phones: catalog ids and phones read over USB. */
export function chosenPhones(targets: string[], custom: Phone[]): Phone[] {
  const all = [...custom, ...PHONES];
  return targets.map((id) => all.find((p) => p.id === id)).filter((p): p is Phone => !!p);
}

/** What a set of phones has in common: what a build must handle. */
export function summarize(phones: Phone[]) {
  const ratio = (p: Phone) => Math.max(p.screen.w, p.screen.h) / Math.min(p.screen.w, p.screen.h);
  const weakest = phones.reduce<Phone | undefined>((a, p) => (!a || TIER_RANK[p.tier] < TIER_RANK[a.tier] ? p : a), undefined);
  return {
    count: phones.length,
    weakestTier: weakest?.tier ?? "mid",
    weakest,
    minAndroid: Math.min(...phones.map((p) => p.android)),
    hz: [Math.min(...phones.map((p) => p.screen.hz)), Math.max(...phones.map((p) => p.screen.hz))] as [number, number],
    shortSide: [Math.min(...phones.map((p) => Math.min(p.screen.w, p.screen.h))), Math.max(...phones.map((p) => Math.min(p.screen.w, p.screen.h)))] as [number, number],
    aspect: [Math.min(...phones.map(ratio)), Math.max(...phones.map(ratio))].map((r) => Math.round(r * 9 * 10) / 10) as [number, number],
    gpuFamilies: [...new Set(phones.map((p) => p.gpuFamily))],
  };
}

/** The frame rate to aim for on the weakest chosen phone. */
export function targetFps(phones: Phone[]): number {
  const s = summarize(phones);
  const cap = s.weakestTier === "high" ? 120 : s.weakestTier === "mid" ? 60 : 30;
  return Math.min(cap, s.hz[0]) >= 60 ? Math.min(cap, s.hz[0]) : Math.max(30, Math.min(cap, s.hz[0]));
}

const GPU_NAME: Record<GpuFamily, string> = { adreno: "Adreno (Qualcomm)", mali: "Mali (Arm)", immortalis: "Immortalis (Arm)", xclipse: "Xclipse (Samsung/AMD)", powervr: "PowerVR (Imagination)", other: "other GPUs" };

/**
 * The brief for the model: short (it goes with every message while a game
 * project is in use), concrete, and only what changes what it builds.
 */
export function phoneNote(phones: Phone[]): string {
  if (!phones.length) return "";
  const s = summarize(phones);
  const list = phones.map((p) => `${p.name} (${p.gpu}, ${p.screen.w}×${p.screen.h} ${p.screen.hz} Hz, Android ${p.android}+, ${p.tier})`).join("; ");
  const plan =
    s.weakestTier === "high"
      ? "full mobile features are fine; keep render resolution near 1080p on 1440p screens"
      : s.weakestTier === "mid"
        ? "plan for 60 fps: render scale ~0.8, one dynamic light with simple shadows, light post-processing, textures up to 2048"
        : "plan for 30–60 fps: render scale ~0.7, no dynamic shadows, little post-processing, textures up to 1024, few draw calls";
  return `Target phones the user chose (build and test for these): ${list}. Weakest is ${s.weakestTier}: ${plan}. Aim for ${targetFps(phones)} fps. Screens are ${s.aspect[0]}–${s.aspect[1]}:9, short side ${s.shortSide[0]}–${s.shortSide[1]} px: use the safe area (camera cut-outs) and touch targets of at least ~9 mm. GPUs: ${s.gpuFamilies.map((g) => GPU_NAME[g]).join(", ")} — before the first build, search the web for known driver bugs of these GPUs with this engine version.`;
}

/**
 * For Unity: a small script added to the project that sets the frame rate at
 * start (Android runs Unity games at 30 fps unless the game asks for more).
 */
export function unityFrameRateScript(phones: Phone[]): string {
  const fps = targetFps(phones);
  return `// Added by KesherAI for the target phones (${phones.map((p) => p.name).join(", ")}).
// Android runs Unity games at 30 fps unless the game asks for more; this asks for ${fps}, never above the screen's own rate.
using UnityEngine;

public static class KesherTargetPhones
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void SetFrameRate()
    {
        if (Application.platform != RuntimePlatform.Android) return;
        int screen = Mathf.RoundToInt((float)Screen.currentResolution.refreshRateRatio.value);
        Application.targetFrameRate = screen > 0 ? Mathf.Min(${fps}, screen) : ${fps};
    }
}
`;
}

/** A phone's own text, as it goes into the model's brief: plain characters, short (a phone's name is not instructions). */
const clean = (s: string | undefined, max = 60) => (s ?? "").replace(/[^\p{L}\p{N} .+()_/-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);

/** Reads a plugged-in phone's real values from `adb shell` answers. */
export function phoneFromProps(raw: Record<string, string>, wmSize: string, gles: string, memKb?: number, fps?: number): Phone {
  const props = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]));
  const make = props["ro.product.manufacturer"] || props["ro.product.brand"] || "Phone";
  const model = props["ro.product.marketname"] || props["ro.product.vendor.marketname"] || props["ro.product.model"] || "Android phone";
  const size = /(\d+)x(\d+)/.exec(wmSize);
  const gpu = clean(/GLES:\s*[^,]+,\s*([^,]+),/.exec(gles)?.[1]?.replace(/\(TM\)\s*/i, "")) || "unknown GPU";
  const ramGb = memKb ? Math.round(memKb / 1024 / 1024) : undefined;
  const brand = make.charAt(0).toUpperCase() + make.slice(1);
  return {
    id: `usb-${(props["ro.product.model"] || model).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    brand,
    name: model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${brand} ${model}`,
    soc: props["ro.soc.model"] || props["ro.board.platform"] || "",
    gpu,
    gpuFamily: gpuFamilyOf(gpu),
    android: Number.parseInt(props["ro.build.version.release"] ?? "", 10) || 0,
    screen: { w: size ? Math.max(Number(size[1]), Number(size[2])) : 0, h: size ? Math.min(Number(size[1]), Number(size[2])) : 0, hz: fps ?? 60 },
    ...(ramGb ? { ramGb } : {}),
    tier: guessTier(gpu, ramGb),
    detected: true,
  };
}

/** Parses `getprop` output ("[key]: [value]" lines). */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/gm)) if (m[1]) out[m[1]] = m[2] ?? "";
  return out;
}

/** The highest refresh rate a phone offers, from `dumpsys display`. */
export function maxFps(dumpsys: string): number | undefined {
  const rates = [...dumpsys.matchAll(/\b(?:fps|refreshRate)=([\d.]+)/g)].map((m) => Number(m[1])).filter((n) => n >= 30 && n <= 240);
  return rates.length ? Math.round(Math.max(...rates)) : undefined;
}
