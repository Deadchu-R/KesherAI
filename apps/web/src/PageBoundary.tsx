import { Component, type ReactNode } from "react";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Keeps one broken page from blanking the whole app: shows what went wrong
 * and a way back, instead of an empty screen.
 */
export class PageBoundary extends Component<{ children: ReactNode; page: string }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  /**
   * After an update the window may still run the old page, whose code files are gone ("Failed to fetch
   * dynamically imported module", found on the PC): load the new version once instead of showing an error.
   */
  componentDidCatch(error: Error): void {
    if (!/dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(error.message)) return;
    try {
      const last = Number(sessionStorage.getItem("kesher-reloaded") ?? 0);
      if (Date.now() - last < 30_000) return;
      sessionStorage.setItem("kesher-reloaded", String(Date.now()));
    } catch {
      /* no storage: reload anyway, once per error */
    }
    location.reload();
  }

  componentDidUpdate(prev: { page: string }): void {
    if (prev.page !== this.props.page && this.state.error) this.setState({ error: undefined });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <h1>{L("משהו השתבש בדף הזה", "Something went wrong on this page")}</h1>
        <p className="muted" dir="ltr">{this.state.error.message}</p>
        <p className="row">
          <button type="button" className="primary" onClick={() => (/dynamically imported module|Loading chunk/i.test(this.state.error?.message ?? "") ? location.reload() : this.setState({ error: undefined }))}>{L("נסה שוב", "Try again")}</button>
          <a href="#/">{L("לדף הבית", "Home")}</a>
        </p>
      </div>
    );
  }
}
