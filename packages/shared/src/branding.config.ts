/**
 * Branding — the single file a fork edits to rename and restyle the app.
 *
 * Nothing else in the codebase hard-codes the product name, colours or
 * URLs. If you find a place that does, that is a bug: please open an issue.
 * See docs/FORKING.md.
 */

/** Everything that identifies this build of the app. */
export interface Branding {
  /** Product name shown in the window title, sidebar and installer. */
  productName: string;
  /** Lower-case id used for the data folder (`~/.<appId>`) and the CLI. */
  appId: string;
  /** Main accent colour (hex). */
  accentColor: string;
  /** Where "Report a bug" and "Source code" link to. */
  repositoryUrl: string;
  /** Where "Report a problem" sends (the project's Google Apps Script web app; empty: GitHub only). */
  reportUrl: string;
  /** Where the documentation site lives. */
  docsUrl: string;
  /** Default port of the local core server. */
  defaultPort: number;
  /**
   * Google OAuth client for "Connect Google Drive" (type: Desktop app).
   * Fill these in once so every user can just click Connect; see
   * docs/GOOGLE_DRIVE.md. A desktop client's secret is not confidential:
   * Google documents that it ships inside the app.
   */
  google: { clientId: string; clientSecret: string };
  /** GitHub OAuth App client id for "Connect with GitHub" (device flow; public, no secret). */
  github: { clientId: string };
  /**
   * Microsoft application (client) id for "Connect OneDrive" (a public
   * client: no secret, so it can live here). See docs/ONEDRIVE.md.
   */
  onedrive: { clientId: string };
}

/** The branding of upstream KesherAI. Forks replace these values. */
export const branding: Branding = {
  productName: "KesherAI",
  appId: "kesher",
  accentColor: "#5EEAD4",
  repositoryUrl: "https://github.com/Deadchu-R/KesherAI",
  reportUrl: "https://script.google.com/macros/s/AKfycbxtY_LnYJ1Q1IqNS-oynINPrVIVnWbbVDpMy6g1wx2idgZOK6XnsmJRnsD5fbd1chZE/exec",
  docsUrl: "https://deadchu-r.github.io/KesherAI",
  defaultPort: 7420,
  google: { clientId: "", clientSecret: "" },
  github: { clientId: "Ov23linxLSbmmhp313Rd" },
  onedrive: { clientId: "" },
};
