/**
 * Feature flags.
 *
 * Every large feature can be switched off here. The core server skips the
 * routes of a disabled feature and the UI hides its screens, so a fork that
 * only wants, say, local chat does not have to delete code (and can keep
 * pulling upstream changes without conflicts). See docs/FORKING.md.
 */

/** Switches for the app's large features. */
export interface Features {
  /** In-app model search and download from Hugging Face. */
  downloads: boolean;
  /** Image generation screen and the `generate_image` tool. */
  images: boolean;
  /** Remote access from a phone or another computer. */
  remote: boolean;
  /** Third-party plugins from the plugins folder. */
  plugins: boolean;
  /** SKILL.md skills. */
  skills: boolean;
  /** OpenAI-compatible API at `/v1`, so other tools can use Kesher's models. */
  openaiCompatibleApi: boolean;
  /** Probe well-known local ports (LM Studio, Ollama, ComfyUI) on start-up. */
  autodetectLocalServers: boolean;
}

/** Upstream defaults: everything on. */
export const features: Features = {
  downloads: true,
  images: true,
  remote: true,
  plugins: true,
  skills: true,
  openaiCompatibleApi: true,
  autodetectLocalServers: true,
};
