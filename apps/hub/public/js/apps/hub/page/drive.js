/**
 * The hub page's link to the owner's Google Drive (docs/RESEARCH_LOG.md, "Tasks in Roee's Google Drive instead of the
 * hub", step 4): reads every device's tasks, runs and agent snapshots from the app's hidden Drive folder
 * (`appDataFolder`, scope `drive.appdata`) and writes a `task` record for each task this page sends (drive-view.ts has
 * the record rules).
 *
 * - The access token comes from Google Identity Services' token client in a browser (about an hour, then a "Reconnect
 *   Drive" tap), or from the KesherAI phone app, which hands the page its own token in the address fragment and opens
 *   the page again with a fresh one on "Reconnect Drive". The token is kept in memory only: never in IndexedDB, never
 *   sent to the hub (the Worker never sees Drive data or tokens).
 * - The opened records and the sync position are kept in this browser's IndexedDB, like the page's own tasks.
 */
import { DriveError, DriveRest, DriveSync, ensureAccountKey } from "../../../packages/shared/src/drive-sync.js";
import { randomB64url } from "../../../packages/shared/src/hub-crypto.js";
import { SYNC_LIMITS } from "../../../packages/shared/src/hub-sync.js";
import { get, put } from "./device.js";
import { pageTaskBody } from "./drive-view.js";
/** The Drive scope the page asks for (non-sensitive: only this app's hidden folder). */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
/** Records this page wrote (or decided not to write), so each task is written once even after Drive compacts it. */
const WRITTEN_MAX = 500;
/** The hub page's Drive sync (one per page). */
export class PageDrive {
    o;
    status = "off";
    /** A short reason for "error" (no tokens, no task text). */
    error;
    /** When the last sync went through (ms). */
    lastSync;
    /** This page's writer id in the records (`page-…`, kept in IndexedDB). */
    writer = "";
    token;
    wasOn = false;
    sync;
    saved;
    written = new Set();
    running;
    timer;
    /** Something was written to Drive during the current sync (the others get a ping). */
    wrote = false;
    tokenClient;
    /** @param o - The client id, Google's script, the app origin, the page's tasks and the change callback. */
    constructor(o) {
        this.o = o;
    }
    /** Whether the page runs inside the KesherAI app (no Google popup there). */
    get inApp() {
        return !!this.o.appOrigin;
    }
    /** The records this page has (winning revisions; empty before the first sync). */
    records() {
        return this.sync?.records() ?? Object.values(this.saved?.records ?? {});
    }
    /** Writes waiting to reach Drive. */
    get pending() {
        return (this.sync?.state ?? this.saved)?.outbox.length ?? 0;
    }
    /**
     * Loads what this browser kept, takes a token the app handed over, and starts syncing when it has one.
     *
     * @param handed - A token from the KesherAI app (parsed from the address), if any.
     */
    async load(handed) {
        try {
            this.writer = (await get("drive-writer")) ?? "";
            this.wasOn = (await get("drive-on")) ?? false;
            this.saved = await get("drive-sync");
            this.written = new Set((await get("drive-written")) ?? []);
        }
        catch {
            // IndexedDB blocked (some private windows): Drive still works for this visit.
        }
        if (!/^page-[\w-]{8,40}$/.test(this.writer)) {
            this.writer = `page-${randomB64url(12)}`;
            await put("drive-writer", this.writer).catch(() => undefined);
        }
        if (this.saved || this.wasOn)
            this.status = "reconnect";
        if (handed)
            this.useToken(handed);
        addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && this.hasToken())
                void this.syncNow();
        });
        this.o.onChange();
    }
    hasToken() {
        return !!this.token && this.token.expiresAt - Date.now() > 30_000;
    }
    useToken(t) {
        this.token = t;
        this.wasOn = true;
        void put("drive-on", true).catch(() => undefined);
        void this.syncNow();
    }
    /** Loads Google's script ahead of a tap, so the token popup opens inside the tap (browsers block late popups). */
    preload() {
        if (!this.inApp && this.o.clientId)
            void this.o.gis();
    }
    /**
     * "Connect Drive" / "Reconnect Drive": in a browser, Google's token popup (call it from a tap); inside the app, back
     * to the app, which opens the page again with a fresh token.
     */
    async connect() {
        if (this.o.appOrigin) {
            location.href = `${this.o.appOrigin}/cloud.html?drive=1`;
            return;
        }
        const gis = await this.o.gis();
        if (!gis || !this.o.clientId) {
            this.fail({ he: "לא ניתן לטעון את ההתחברות של Google", en: "Google's sign-in could not load" });
            return;
        }
        this.status = "connecting";
        this.o.onChange();
        this.tokenClient ??= gis.initTokenClient({
            client_id: this.o.clientId,
            scope: DRIVE_SCOPE,
            callback: (r) => {
                const secs = Number(r.expires_in);
                if (r.error || !r.access_token || !(r.scope ?? "").split(" ").includes(DRIVE_SCOPE)) {
                    return this.fail({ he: "לא ניתנה הרשאה ל-Google Drive", en: "Google Drive access was not given" });
                }
                this.useToken({ token: r.access_token, expiresAt: Date.now() + (Number.isFinite(secs) && secs > 0 ? secs : 3600) * 1000 });
            },
            error_callback: () => {
                this.status = this.wasOn ? "reconnect" : "off";
                this.o.onChange();
            },
        });
        // No consent screen again once given (Google may still show the account chooser).
        this.tokenClient.requestAccessToken({ prompt: this.wasOn ? "" : "consent" });
    }
    /** Stops using Drive in this browser and forgets what it kept (Drive itself is not touched). */
    async forget() {
        clearTimeout(this.timer);
        this.token = undefined;
        this.sync = undefined;
        this.saved = undefined;
        this.written.clear();
        this.wasOn = false;
        this.status = "off";
        for (const k of ["drive-on", "drive-sync", "drive-written"])
            await put(k, undefined).catch(() => undefined);
        this.o.onChange();
    }
    fail(why) {
        this.status = "error";
        this.error = why;
        this.o.onChange();
    }
    /** Syncs now (one at a time), then again every {@link SYNC_LIMITS.pollMs} while the page is visible. */
    syncNow() {
        this.running ??= this.doSync().finally(() => {
            this.running = undefined;
            clearTimeout(this.timer);
            if (this.hasToken())
                this.timer = window.setTimeout(() => document.visibilityState === "visible" && void this.syncNow(), SYNC_LIMITS.pollMs);
        });
        return this.running;
    }
    /**
     * Another device wrote to Drive (its `sync` ping came through the hub): pull in a moment, or right after the sync
     * that is running now (it may have missed the news).
     */
    onPing() {
        if (!this.hasToken())
            return;
        const later = () => {
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => void this.syncNow(), SYNC_LIMITS.pingPullDelayMs);
        };
        if (this.running)
            void this.running.finally(later);
        else
            later();
    }
    /**
     * Writes the record of a task this page just sent (it reaches Drive now, or with the next sync).
     */
    async taskSent() {
        if (!this.sync || !this.hasToken())
            return;
        this.wrote = false;
        await this.writeTasks(this.sync).catch(() => undefined);
        if (this.wrote)
            this.o.onWrote?.();
    }
    async doSync() {
        if (!this.hasToken()) {
            this.status = this.wasOn ? "reconnect" : "off";
            this.o.onChange();
            return;
        }
        this.status = "syncing";
        this.wrote = false;
        this.o.onChange();
        try {
            const sync = await this.open();
            await sync.pull();
            await this.writeTasks(sync);
            const f = await sync.flush();
            if (f.sent)
                this.wrote = true;
            if (f.error)
                throw f.error;
            this.status = "ok";
            this.lastSync = Date.now();
            delete this.error;
            if (this.wrote)
                this.o.onWrote?.();
        }
        catch (e) {
            this.onError(e);
        }
        this.o.onChange();
    }
    onError(e) {
        if (e instanceof DriveError && (e.status === 401 || (e.status === 403 && /insufficient|scope|permission|forbidden/i.test(e.reason)))) {
            this.token = undefined;
            this.status = "reconnect";
        }
        else if (e instanceof DriveError && e.status === 0) {
            this.status = "offline";
        }
        else {
            this.status = "error";
            this.error = e instanceof DriveError ? { he: `Google Drive ענה ${e.status}`, en: `Google Drive answered ${e.status}` } : { he: "הסנכרון נכשל", en: "The sync failed" };
        }
    }
    /** The device's sync (reads the account key from Drive once per visit). */
    async open() {
        if (this.sync)
            return this.sync;
        const drive = new DriveRest({
            token: async ({ refresh }) => {
                // Drive refused the token: only a new tap (or the app) can give another one.
                if (refresh)
                    this.token = undefined;
                if (!this.hasToken())
                    throw new DriveError(401, "tokenExpired");
                return this.token.token;
            },
        });
        const keys = await ensureAccountKey(drive);
        this.sync = await DriveSync.create({
            drive,
            writer: this.writer,
            keys,
            ...(this.saved ? { state: this.saved } : {}),
            save: (state) => put("drive-sync", state).catch(() => undefined),
        });
        return this.sync;
    }
    /**
     * Writes a record for each task this page sent and has not written yet: the ones sent while Drive was off, and,
     * on the first connect, every task this browser kept before (the one-time move into Drive).
     */
    async writeTasks(sync) {
        const have = new Set(sync.records().filter((r) => r.head.kind === "task").map((r) => r.head.id));
        let changed = false;
        for (const t of [...this.o.tasks()].reverse()) {
            if (this.written.has(t.taskId))
                continue;
            const body = pageTaskBody(t);
            if (body && !have.has(t.taskId)) {
                await sync.write("task", t.taskId, body);
                this.wrote = true;
            }
            this.written.add(t.taskId);
            changed = true;
        }
        if (changed)
            await put("drive-written", [...this.written].slice(-WRITTEN_MAX)).catch(() => undefined);
    }
}
