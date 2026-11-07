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
  /** Where the documentation site lives. */
  docsUrl: string;
  /** Default port of the local core server. */
  defaultPort: number;
}

/** The branding of upstream KesherAI. Forks replace these values. */
export const branding: Branding = {
  productName: "KesherAI",
  appId: "kesher",
  accentColor: "#5EEAD4",
  repositoryUrl: "https://github.com/Deadchu-R/KesherAI",
  docsUrl: "https://deadchu-r.github.io/KesherAI",
  defaultPort: 7420,
};
