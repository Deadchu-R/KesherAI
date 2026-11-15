/**
 * Where Excalidraw loads its fonts from: KesherAI's own copy (scripts/copy-excalidraw-fonts.mjs), not a CDN, because
 * the interface's CSP lets nothing load from outside. Set first, in main.tsx: Excalidraw reads it when its chunk loads.
 */
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

export {};
