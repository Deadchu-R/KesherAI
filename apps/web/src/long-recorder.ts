import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "./Mic";
import { joinWavs, recStore, type RecGap, type RecKind, type RecSession } from "./rec-store";

/** One finished piece of a native recording (a 30-second WAV in the phone app), and where it starts (seconds). */
export interface NativePiece {
  file: string;
  start: number;
}

/** The phone app's recorder as it is now (KesherSpeech.recState). */
export interface NativeRecState {
  running: boolean;
  paused?: boolean;
  silenced?: boolean;
  startedAt?: number;
  recordedMs?: number;
  level?: number;
  tag?: string;
  pieces?: NativePiece[];
  gaps?: Array<{ at: number; ms: number; system?: boolean }>;
}

/** The phone app's native recorder (a foreground service with a notification, apps/android/plugins/speech). */
interface NativeRec {
  recStart(o: { resume?: boolean; tag?: string }): Promise<unknown>;
  recPause(o: { on: boolean }): Promise<void>;
  recState(): Promise<NativeRecState>;
  recStop(): Promise<{ pieces?: NativePiece[]; gaps?: NativeRecState["gaps"] }>;
  recRead(o: { file: string }): Promise<{ wav: string }>;
  recClear(): Promise<void>;
}

/**
 * The phone app's native recorder, when the page runs inside a phone app new enough to pause it; otherwise undefined
 * (a browser, the desktop app, or an older phone app: the page records itself).
 */
export function nativeRec(): NativeRec | undefined {
  const p = (window as unknown as { Capacitor?: { Plugins?: { KesherSpeech?: Partial<NativeRec> } } }).Capacitor?.Plugins?.KesherSpeech;
  return p?.recStart && p.recPause && p.recState ? (p as NativeRec) : undefined;
}

/** What the recorder is doing. "silenced": paused by the system (another app took the microphone); it goes on by itself. */
export type LongStatus = "idle" | "recording" | "paused" | "silenced" | "interrupted" | "finishing";

/** A finished recording: its sound (one file), how long, the pauses, and the page's data. */
export interface LongTake {
  audio?: Blob;
  seconds: number;
  gaps: RecGap[];
  meta: Record<string, unknown>;
}

/** A recording that did not end (the app was closed, the page reloaded, the system stopped it). */
export interface LongPending {
  seconds: number;
  native: boolean;
  meta: Record<string, unknown>;
}

const MIMES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const CHUNK_MS = 5000;

const fromBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * Joins recordings made in several parts (each a file of its own) into one 16 kHz mono WAV, the format speech to text
 * wants. One part is returned as it is.
 * @param parts - The parts, in order.
 */
export async function joinParts(parts: Blob[]): Promise<Blob | undefined> {
  if (parts.length <= 1) return parts[0];
  const rate = 16000;
  const ctx = new AudioContext();
  const pcm: Float32Array[] = [];
  try {
    for (const p of parts) {
      const buf = await ctx.decodeAudioData(await p.arrayBuffer()).catch(() => undefined);
      if (!buf) continue; // a part cut off before its first second
      const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * rate)), rate);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start();
      pcm.push((await off.startRendering()).getChannelData(0));
    }
  } finally {
    void ctx.close();
  }
  return pcm.length ? encodeWav(pcm, rate) : undefined;
}

/**
 * One shared way to record something long (Open mind, a lecture) without losing it.
 *
 * - In the phone app it records natively, in a foreground service with an ongoing notification (Pause/Resume, Stop),
 *   so it goes on with the screen off and while another app (a video) is in front; when another app takes the
 *   microphone it pauses and goes on by itself, keeping the gap. The page only follows it (every second while shown).
 * - Elsewhere the page records the stream it is given with MediaRecorder, and every 5 seconds the newest sound goes into
 *   the browser's storage (rec-store.ts).
 *
 * Either way, coming back finds the recording: still running (with the right time), or stopped with "Resume" (which
 * continues into the same session) and "Finish" (which joins the parts into one file).
 *
 * @param kind - The page ("ideas", "study"): each page sees only its own recordings.
 * @param opts.onPiece - Native recording only: called with each finished 30-second WAV piece and where it starts
 *   (seconds), for a live transcript. Called once per piece, also for pieces made while the page was away.
 */
export function useLongRecorder(kind: RecKind, opts: { onPiece?: (wav: Blob, atSec: number) => void } = {}) {
  const native = nativeRec();
  const [status, setStatus] = useState<LongStatus>("idle");
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [pending, setPending] = useState<LongPending | null>(null);
  const session = useRef<RecSession | null>(null);
  const meta = useRef<Record<string, unknown>>({});
  const rec = useRef<{ r: MediaRecorder; part: number; seq: number; writes: Promise<void>[]; done?: Promise<void> } | null>(null);
  const onPiece = useRef(opts.onPiece);
  onPiece.current = opts.onPiece;
  const statusRef = useRef<LongStatus>("idle");
  const set = (s: LongStatus) => { statusRef.current = s; setStatus(s); };

  /** Native: hands new finished pieces to onPiece, once each (the count is kept with the session). */
  const deliver = useCallback(async (pieces: NativePiece[], read?: Map<string, Uint8Array>) => {
    const seen = Number(meta.current.seenPieces ?? 0);
    if (!onPiece.current || pieces.length <= seen || !native) return;
    for (const p of pieces.slice(seen)) {
      const bytes = read?.get(p.file) ?? fromBase64((await native.recRead({ file: p.file })).wav);
      onPiece.current(new Blob([bytes as BlobPart], { type: "audio/wav" }), p.start);
    }
    meta.current = { ...meta.current, seenPieces: pieces.length };
    if (session.current) await recStore().setMeta(session.current.id, meta.current).catch(() => undefined);
  }, [native]);

  /** Native: follows the service (time, pause, level), and notices when it stopped without the page. */
  const follow = useCallback(async () => {
    if (!native) return;
    const st = await native.recState().catch(() => undefined);
    if (!st) return;
    setSecs(Math.floor((st.recordedMs ?? 0) / 1000));
    setLevel((st.level ?? 0) / 100);
    if (!st.running) {
      // Stopped without the page (the notification's Stop, or the system): kept on the phone, Resume or Finish.
      if (statusRef.current !== "finishing" && statusRef.current !== "idle" && statusRef.current !== "interrupted") {
        setPending({ seconds: Math.floor((st.recordedMs ?? 0) / 1000), native: true, meta: meta.current });
        set("interrupted");
      }
      return;
    }
    set(st.silenced ? "silenced" : st.paused ? "paused" : "recording");
    if (session.current) void recStore().touch(session.current.id).catch(() => undefined);
    void deliver(st.pieces ?? []).catch(() => undefined);
  }, [native, deliver]);

  // On opening the page: a recording that runs (native) or did not end (either).
  useEffect(() => {
    let off = false;
    void (async () => {
      const kept = await recStore().unfinished(kind).catch(() => undefined);
      if (native) {
        const st = await native.recState().catch(() => undefined);
        if (off || !st || st.tag !== kind || (!st.running && !st.pieces?.length)) return;
        session.current = kept?.native ? kept : await recStore().begin(kind, "", true);
        meta.current = session.current.meta ?? {};
        if (st.running) {
          void follow();
        } else {
          setSecs(Math.floor((st.recordedMs ?? 0) / 1000));
          setPending({ seconds: Math.floor((st.recordedMs ?? 0) / 1000), native: true, meta: meta.current });
          set("interrupted");
        }
        return;
      }
      if (off || !kept || kept.native) return;
      session.current = kept;
      meta.current = kept.meta ?? {};
      const s = Math.floor(kept.recordedMs / 1000 + (kept.state === "recording" ? Math.max(0, kept.updatedAt - kept.resumedAt) / 1000 : 0));
      setSecs(s);
      setPending({ seconds: s, native: false, meta: meta.current });
      set("interrupted");
    })();
    return () => { off = true; };
  }, [kind, native, follow]);

  // The clock: native follows the service; the page's own recorder counts from the session, and says it is alive.
  useEffect(() => {
    if (status !== "recording" && status !== "paused" && status !== "silenced") return;
    const id = window.setInterval(() => {
      if (native) return void follow();
      const s = session.current;
      if (!s) return;
      const ms = s.recordedMs + (s.state === "recording" ? Date.now() - s.resumedAt : 0);
      setSecs(Math.floor(ms / 1000));
      if (Math.floor(ms / 1000) % 5 === 0) void recStore().touch(s.id).catch(() => undefined);
    }, 1000);
    // Back from another app: the time at once; leaving: the last seconds into storage.
    const vis = () => {
      if (document.visibilityState === "visible") void follow();
      else if (rec.current?.r.state === "recording") rec.current.r.requestData();
    };
    document.addEventListener("visibilitychange", vis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", vis); };
  }, [status, native, follow]);

  /** The page's recorder on a stream: a new part of the session, 5-second chunks into storage. */
  const record = (stream: MediaStream, part: number) => {
    const s = session.current!;
    const r = new MediaRecorder(stream, { ...(s.mime ? { mimeType: s.mime } : {}), audioBitsPerSecond: 32_000 });
    const cur = { r, part, seq: 0, writes: [] as Promise<void>[], done: undefined as Promise<void> | undefined };
    r.ondataavailable = (e) => {
      if (!e.data.size) return;
      cur.writes.push(recStore().addChunk(s.id, part, cur.seq++, e.data).catch(() => undefined));
    };
    cur.done = new Promise<void>((res) => {
      r.onstop = () => {
        res();
        // Stopped without the page asking (the microphone was taken away, the track ended): Resume is offered.
        if (rec.current === cur && statusRef.current !== "finishing") {
          rec.current = null;
          const now = session.current ?? s;
          const ms = now.recordedMs + (now.state === "recording" ? Date.now() - now.resumedAt : 0);
          setPending({ seconds: Math.floor(ms / 1000), native: false, meta: meta.current });
          set("interrupted");
        }
      };
    });
    stream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => r.state !== "inactive" && r.stop()));
    r.start(CHUNK_MS);
    rec.current = cur;
  };

  /**
   * Starts a new recording.
   * @param stream - The sound to record when the page records itself (not used in the phone app).
   * @param data - The page's own data to keep with it.
   * @returns False when the phone app has another page's recording waiting (finish that one first).
   */
  const start = async (stream?: MediaStream, data: Record<string, unknown> = {}): Promise<boolean> => {
    meta.current = data;
    setPending(null);
    if (native) {
      const st = await native.recState().catch(() => undefined);
      if (st && st.tag && st.tag !== kind && (st.running || st.pieces?.length)) return false;
      await native.recStart({ tag: kind });
      session.current = await recStore().begin(kind, "", true);
      await recStore().setMeta(session.current.id, data);
      setSecs(0);
      set("recording");
      return true;
    }
    if (!stream) throw new Error("No sound to record");
    const mime = MIMES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    session.current = await recStore().begin(kind, mime);
    await recStore().setMeta(session.current.id, data);
    record(stream, 0);
    setSecs(0);
    set("recording");
    return true;
  };

  /**
   * Continues a recording that stopped, into the same session.
   * @param stream - A new stream when the page records itself (not used in the phone app).
   */
  const resume = async (stream?: MediaStream) => {
    const s = session.current;
    if (!s) return;
    setPending(null);
    if (native) {
      await native.recStart({ resume: true, tag: kind });
      set("recording");
      void follow();
      return;
    }
    if (!stream) throw new Error("No sound to record");
    const { session: next, part } = await recStore().resume(s.id);
    session.current = next;
    record(stream, part);
    setSecs(Math.floor(next.recordedMs / 1000));
    set("recording");
  };

  /** Pauses (true) or goes on (false). */
  const pause = async (on: boolean) => {
    if (native) {
      await native.recPause({ on });
      void follow();
      return;
    }
    const s = session.current;
    const r = rec.current?.r;
    if (!s || !r) return;
    if (on && r.state === "recording") r.pause();
    else if (!on && r.state === "paused") r.resume();
    session.current = await recStore().pause(s.id, on);
    set(on ? "paused" : "recording");
  };

  /** Keeps the page's own data with the session (merged with what is there), so a resumed session has it back. */
  const setMeta = (data: Record<string, unknown>) => {
    meta.current = { ...meta.current, ...data };
    if (session.current) void recStore().setMeta(session.current.id, meta.current).catch(() => undefined);
  };

  /**
   * Stops (if it runs) and returns the whole recording as one file. The sound stays kept until {@link done}, so a
   * failed send can be tried again.
   */
  const finish = async (): Promise<LongTake> => {
    const s = session.current;
    set("finishing");
    if (native) {
      const r = await native.recStop();
      const read = new Map<string, Uint8Array>();
      for (const p of r.pieces ?? []) read.set(p.file, fromBase64((await native.recRead({ file: p.file })).wav));
      await deliver(r.pieces ?? [], read).catch(() => undefined);
      const wav = joinWavs([...read.values()]);
      return { audio: wav.length > 44 ? new Blob([wav as BlobPart], { type: "audio/wav" }) : undefined, seconds: Math.round((wav.length - 44) / 32000), gaps: (r.gaps ?? []).map((g) => ({ at: g.at * 1000, ms: g.ms, system: !!g.system })), meta: meta.current };
    }
    const cur = rec.current;
    rec.current = null;
    if (cur && cur.r.state !== "inactive") {
      cur.r.stop();
      await cur.done;
    }
    await Promise.all(cur?.writes ?? []);
    if (!s) return { seconds: 0, gaps: [], meta: meta.current };
    const ended = await recStore().stop(s.id);
    session.current = ended;
    return { audio: await joinParts(await recStore().parts(s.id)), seconds: Math.round(ended.recordedMs / 1000), gaps: ended.gaps, meta: meta.current };
  };

  /** Removes the kept sound (after it was sent, or to throw it away) and goes back to idle. */
  const done = async () => {
    const s = session.current;
    session.current = null;
    if (native) {
      if (statusRef.current !== "finishing" && statusRef.current !== "interrupted") await native.recStop().catch(() => undefined);
      await native.recClear().catch(() => undefined);
    } else {
      const cur = rec.current;
      rec.current = null;
      if (cur && cur.r.state !== "inactive") cur.r.stop();
    }
    if (s) await recStore().remove(s.id).catch(() => undefined);
    meta.current = {};
    setPending(null);
    setSecs(0);
    setLevel(0);
    set("idle");
  };

  /** The page's data kept with the session (after coming back to a running recording, its transcript so far). */
  const getMeta = () => meta.current;

  return { native: !!native, status, secs, level, pending, start, resume, pause, setMeta, getMeta, finish, done };
}
