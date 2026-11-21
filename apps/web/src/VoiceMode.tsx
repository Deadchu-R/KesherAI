import { useEffect, useRef, useState, type ReactNode } from "react";
import { SentenceQueue, shortSpoken, SttStream, VOICE_LINES, voiceStart, voiceStep, type SttAction, type VoiceEffect, type VoiceEvent, type VoiceState } from "@kesher/shared";
import { api, withToken } from "./api";
import { encodeWav } from "./Mic";
import { speak, stopSpeaking } from "./Speak";
import { toast } from "./library";
import { getLocale, he$, t } from "./i18n";
import { openMic as openMicStream } from "./mic-access";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The Android app's speech recognizer, when the page runs inside it. */
type NativeRecognizer = { start(o: { language?: string }): Promise<{ text: string }>; stop(): Promise<void> };
const nativeRecognizer = (): NativeRecognizer | undefined => (window as unknown as { Capacitor?: { Plugins?: { KesherSpeech?: NativeRecognizer } } }).Capacitor?.Plugins?.KesherSpeech;

/** Loudness (peak of the samples) above which the microphone counts as speech. */
const SPEECH = 0.06;
/** While an answer is read aloud, louder speech is needed to interrupt it (its echo is quieter). */
const BARGE_IN = 0.14;
/** Quiet after speech, in seconds, that ends what the user said (VOICE_TARGETS.endOfSpeech, plus a margin). */
const END_SILENCE = 0.8;
/** One microphone block, in samples (at 16 kHz: 0.128 s). */
const BLOCK = 2048;
/** Push-to-talk instead of hands-free, remembered on this device. */
const PTT_KEY = "kesher-voice-ptt";

const readPtt = () => {
  try {
    return localStorage.getItem(PTT_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Voice conversation with a hand-off (shared/voice-handoff.ts). A small local voice model answers quick turns in one
 * or two spoken sentences; real work goes to the chat's main model as a normal message (shown in the chat), and its
 * result is said when it is done. Approvals are never given by voice: the waiting approval cards show here, on the
 * computer and on the phone, and the voice says that one waits on screen. Hands-free (it sends when you pause, and
 * speaking over an answer stops it) or push-to-talk (hold the circle or Space). From the phone the audio goes to the
 * PC to be turned into text, and the voice model runs there; without a small model the main model answers, read shortened.
 * Words show while the user talks (shared/voice-stream.ts SttStream: pieces are turned into text on the PC as they
 * come, so little is left when the user stops), and answers are said sentence by sentence, the first one early; a
 * direct answer (no small model) is said as it is written.
 *
 * @param props.chatId - The chat.
 * @param props.onSend - Sends words to the chat as a message (the main model's turn); `brief`: a direct voice turn,
 *   so the main model is asked for a short spoken answer.
 * @param props.answer - The latest answer in the chat, with its sequence number.
 * @param props.live - The main model's answer as it is being written (said sentence by sentence in a direct turn).
 * @param props.busy - Whether the main model is still working.
 * @param props.approvals - Ids of the approval requests waiting in the chat.
 * @param props.approvalCards - Those requests' cards, shown in voice mode so they can be answered on screen.
 * @param props.onClose - Ends voice mode.
 */
export function VoiceMode({ chatId, onSend, answer, live, busy, approvals, approvalCards, onClose }: { chatId: string; onSend: (text: string, brief: boolean) => Promise<void>; answer?: { seq: number; text: string }; live?: string; busy: boolean; approvals: string[]; approvalCards?: ReactNode; onClose: () => void }) {
  const he = getLocale() === "he";
  const stateRef = useRef<VoiceState>(voiceStart({ he, fallback: false, lastSeq: answer?.seq ?? 0 }));
  const [vs, setVs] = useState(stateRef.current);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState("");
  /** The words shown are still being heard (a partial transcript). */
  const [hearing, setHearing] = useState(false);
  const [said, setSaid] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [ptt, setPtt] = useState(readPtt);
  const [holding, setHolding] = useState(false);
  const pttRef = useRef(ptt);
  pttRef.current = ptt;
  const holdRef = useRef(false);
  /** The utterance being heard: its pieces go to the PC to be turned into text while the user talks. */
  const streamRef = useRef<SttStream<Float32Array> | null>(null);
  /** The PC turns pieces into text quickly (a loaded local model); off after it says it cannot. */
  const partialsRef = useRef(true);
  /** The user stopped: the `transcribe` effect waits for the stream's last pieces. */
  const waitingRef = useRef(false);
  /** Lines are said sentence by sentence (the first starts early); barge-in stops the rest at once. */
  const voice = useRef<SentenceQueue | null>(null);
  voice.current ??= new SentenceQueue((text, done) => void speak(text, done), stopSpeaking, he);
  /** When the user stopped talking, to measure the time to the first word said (VOICE_TARGETS.total). */
  const endAt = useRef(0);
  const [latency, setLatency] = useState<number | null>(null);
  const phone = nativeRecognizer();

  // The step function's effects, carried out here.
  const dispatch = (e: VoiceEvent) => {
    const r = voiceStep(stateRef.current, e);
    stateRef.current = r.state;
    setVs(r.state);
    for (const f of r.effects) run(f);
  };
  const run = (f: VoiceEffect) => {
    switch (f.do) {
      case "say": {
        if (endAt.current) {
          setLatency(Math.round(performance.now() - endAt.current));
          endAt.current = 0;
        }
        setSaid(f.text);
        voice.current!.play(f.text, () => dispatch({ type: "spoken" }));
        return;
      }
      case "stopSpeaking":
        voice.current!.stop();
        stopSpeaking();
        return;
      case "transcribe": {
        const st = streamRef.current;
        endAt.current = performance.now();
        // The Android app's recognizer brings its own words (nativeOnce).
        if (!st) return phone ? undefined : dispatch({ type: "transcript", text: "" });
        waitingRef.current = true;
        for (const a of st.end()) sendPiece(st, a);
        finishIfReady(st);
        return;
      }
      case "ask":
        void api<{ say: string; handoff?: string; model?: string }>(`/api/voice/${encodeURIComponent(chatId)}/turn`, { method: "POST", body: { text: f.text, working: f.working, he } }).then(
          (r) => {
            if (r.model) setModel(r.model);
            dispatch({ type: "reply", say: r.say, ...(r.handoff ? { handoff: r.handoff } : {}) });
          },
          () => {
            setModel(null);
            dispatch({ type: "noVoiceModel" });
          },
        );
        return;
      case "handoff":
        void onSend(f.text, f.brief === true).catch((err: Error) => toast(err.message));
        return;
      case "summarize": {
        const done = (say: string) => dispatch({ type: "summary", text: f.direct ? say : `${VOICE_LINES.done[he ? "he" : "en"]} ${say}` });
        if (stateRef.current.fallback) return done(shortSpoken(f.text, he));
        void api<{ say: string }>(`/api/voice/${encodeURIComponent(chatId)}/summary`, { method: "POST", body: { text: f.text, he } }).then((r) => done(r.say), () => done(shortSpoken(f.text, he)));
        return;
      }
    }
  };

  /** A new utterance: its pieces start going to the PC (the phone's audio too, through the server). */
  const startStream = (rate: number, preroll: Float32Array[] = []) => {
    const st = new SttStream<Float32Array>(BLOCK / rate);
    if (!partialsRef.current) st.noPartials();
    streamRef.current = st;
    waitingRef.current = false;
    for (const b of preroll) st.push(b, false);
    return st;
  };
  /** Adds a microphone block to the utterance and sends what is ready to be turned into text. */
  const pushBlock = (block: Float32Array, loud: boolean) => {
    const st = streamRef.current;
    if (st) for (const a of st.push(block, loud)) sendPiece(st, a);
  };
  /** The words are complete: hand them to the voice loop. */
  const finishIfReady = (st: SttStream<Float32Array>) => {
    if (!waitingRef.current || streamRef.current !== st || !st.ready()) return;
    waitingRef.current = false;
    streamRef.current = null;
    const text = st.text();
    setHearing(false);
    if (text) setHeard(text);
    dispatch({ type: "transcript", text });
  };
  /** One piece to the PC's speech to text: a segment (kept) or a partial (live words, only from a loaded model). */
  const sendPiece = (st: SttStream<Float32Array>, a: SttAction<Float32Array>) => {
    const rate = mic.current.ctx?.sampleRate ?? 16000;
    const partial = a.do === "partial";
    void (async () => {
      let text: string | null = null;
      try {
        const res = await fetch(withToken(`/api/speech/transcribe${partial ? "?partial=1" : ""}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: encodeWav(a.blocks, rate) });
        const j = (await res.json()) as { text?: string; partial?: boolean; error?: string };
        if (!res.ok) throw new Error(j.error ?? String(res.status));
        if (partial && j.partial === false) {
          partialsRef.current = false;
          st.noPartials();
        } else text = j.text ?? "";
      } catch (e) {
        if (!partial) toast((e as Error).message);
      }
      for (const again of st.done(a.id, text)) sendPiece(st, again);
      if (streamRef.current === st && !waitingRef.current) {
        const now = st.text();
        if (now) {
          setHeard(now);
          setHearing(true);
        }
      }
      finishIfReady(st);
    })();
  };

  // Opening: which voice model this chat uses (a model beside the chat's loads now), and speech to text warmed up.
  useEffect(() => {
    void api<{ model?: string; fallback: boolean }>(`/api/voice/${encodeURIComponent(chatId)}/status`).then((r) => {
      if (r.model) setModel(r.model);
      if (r.fallback) dispatch({ type: "noVoiceModel" });
    }, () => dispatch({ type: "noVoiceModel" }));
    if (!phone) void api("/api/speech/stt/warm", { method: "POST" }).catch(() => undefined);
  }, []);

  // The chat: approvals waiting, and the main model's finished answers.
  const approvalKey = approvals.join(",");
  useEffect(() => {
    dispatch({ type: "approvals", ids: approvals });
  }, [approvalKey]);
  useEffect(() => {
    if (!busy && answer) dispatch({ type: "mainAnswer", seq: answer.seq, text: answer.text });
  }, [answer?.seq, busy]);
  // The answer as it is written: a direct turn's sentences are said as soon as each one is complete.
  useEffect(() => {
    if (busy && live) dispatch({ type: "answerText", text: live });
  }, [live, busy]);

  // Inside the Android app: the phone's own recognizer (it hears when you stop).
  const nativeOnce = async () => {
    if (!phone) return;
    dispatch({ type: "speechStart" });
    try {
      const r = await phone.start({ language: he ? "he-IL" : "" });
      dispatch({ type: "speechEnd", seconds: 1 });
      const text = (r.text ?? "").trim();
      if (text) setHeard(text);
      dispatch({ type: "transcript", text });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      dispatch({ type: "speechEnd", seconds: 0 });
      // Nothing heard: listen again; a real error ends voice mode.
      if (!/no match|no speech|timeout|7|6/i.test(msg)) {
        toast(msg || t("micDenied"));
        onClose();
      }
    }
  };
  useEffect(() => {
    if (!phone || ptt || vs.phase !== "ready") return;
    const id = setTimeout(() => void nativeOnce(), 300);
    return () => clearTimeout(id);
  }, [vs.phase, ptt]);

  // The microphone (not inside the Android app): opened at once for hands-free, at the first press for push-to-talk.
  const mic = useRef<{ stream?: MediaStream; ctx?: AudioContext; opening?: Promise<boolean>; closed: boolean }>({ closed: false });
  const openMic = (): Promise<boolean> => {
    const m = mic.current;
    if (m.stream) return Promise.resolve(true);
    m.opening ??= (async () => {
      const info = await api<{ choice: string; local: { engine: boolean; model?: string }; clouds: unknown[] }>("/api/speech/stt").catch(() => null);
      if (info && !(info.local.engine && info.local.model) && !(info.choice.startsWith("cloud:") || (info.choice === "auto" && info.clouds.length))) {
        toast(t("voiceNeedsStt"));
        onClose();
        return false;
      }
      let stream: MediaStream;
      try {
        stream = await openMicStream({ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      } catch (e) {
        // Blocked: stay open in push-to-talk, so a press after allowing the microphone tries again.
        toast((e as Error).message || t("micDenied"));
        m.opening = undefined;
        pttRef.current = true;
        setPtt(true);
        return false;
      }
      if (m.closed) {
        stream.getTracks().forEach((tr) => tr.stop());
        return false;
      }
      const ctx = new AudioContext({ sampleRate: 16000 });
      m.stream = stream;
      m.ctx = ctx;
      listen(ctx, stream);
      return true;
    })();
    return m.opening;
  };

  /** The loudness detector: hands-free turn taking and barge-in, or recording while push-to-talk is held. */
  const listen = (ctx: AudioContext, stream: MediaStream) => {
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(BLOCK, 1, 1);
    const block = BLOCK / ctx.sampleRate;
    /** A little audio from just before speech starts. */
    const preroll: Float32Array[] = [];
    let loudFor = 0;
    let quietFor = 0;
    let length = 0;
    node.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < d.length; i += 32) peak = Math.max(peak, Math.abs(d[i]!));
      setLevel(peak);
      const copy = new Float32Array(d);
      if (pttRef.current) {
        if (holdRef.current) pushBlock(copy, peak > SPEECH);
        return;
      }
      const p = stateRef.current.phase;
      if (p === "speaking") {
        // Barge-in: sustained speech over the answer stops it.
        loudFor = peak > BARGE_IN ? loudFor + block : 0;
        if (loudFor > 0.3) {
          loudFor = 0;
          quietFor = 0;
          length = 0;
          startStream(ctx.sampleRate);
          dispatch({ type: "speechStart" });
        }
        return;
      }
      if (p === "ready" || p === "replying") {
        if (peak > SPEECH) {
          quietFor = 0;
          length = 0;
          startStream(ctx.sampleRate, preroll.splice(0));
          dispatch({ type: "speechStart" });
        } else {
          preroll.push(copy);
          if (preroll.length > 4) preroll.shift();
          return;
        }
      }
      if (stateRef.current.phase !== "hearing") return;
      pushBlock(copy, peak > SPEECH);
      length += block;
      quietFor = peak > SPEECH ? 0 : quietFor + block;
      if (quietFor > END_SILENCE || length > 60) {
        quietFor = 0;
        dispatch({ type: "speechEnd", seconds: length - END_SILENCE });
      }
    };
    src.connect(node);
    node.connect(ctx.destination);
  };

  useEffect(() => {
    if (!phone && !readPtt()) void openMic();
    const m = mic.current;
    return () => {
      m.closed = true;
      voice.current?.stop();
      streamRef.current = null;
      stopSpeaking();
      m.stream?.getTracks().forEach((tr) => tr.stop());
      void m.ctx?.close();
    };
  }, []);

  // Push-to-talk: press starts (and stops an answer being said), release sends.
  const pressedAt = useRef(0);
  const press = async () => {
    if (holdRef.current) return;
    if (phone) return void nativeOnce();
    holdRef.current = true;
    setHolding(true);
    startStream(mic.current.ctx?.sampleRate ?? 16000);
    pressedAt.current = performance.now();
    dispatch({ type: "speechStart" });
    if (!(await openMic())) {
      holdRef.current = false;
      setHolding(false);
      dispatch({ type: "speechEnd", seconds: 0 });
    }
  };
  const release = () => {
    if (!holdRef.current) return;
    holdRef.current = false;
    setHolding(false);
    const seconds = mic.current.ctx ? (performance.now() - pressedAt.current) / 1000 : 0;
    dispatch({ type: "speechEnd", seconds });
  };
  const choosePtt = (on: boolean) => {
    setPtt(on);
    try {
      localStorage.setItem(PTT_KEY, on ? "1" : "0");
    } catch {
      // not remembered; fine
    }
    if (!on && !phone) void openMic();
  };

  // Keys: Esc ends; in push-to-talk, holding Space talks (not while typing in a field).
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select, [contenteditable=true]");
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === " " && pttRef.current && !e.repeat && !typing(e)) {
        e.preventDefault();
        void press();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " " && pttRef.current && !typing(e)) release();
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, []);

  const phase = vs.phase;
  const label =
    phase === "ready" ? (ptt ? L("החזק כדי לדבר", "Hold to talk") : t("voiceListening"))
    : phase === "hearing" ? t("voiceHearing")
    : phase === "transcribing" ? t("voiceWorking")
    : phase === "replying" ? (vs.direct && busy ? L("המודל הראשי עונה…", "The main model is answering…") : t("voiceThinking"))
    : ptt ? L("עונה. החזק כדי לקטוע.", "Answering. Hold to interrupt.") : t("voiceSpeaking");
  const job =
    vs.job === "approval" ? VOICE_LINES.approval[he ? "he" : "en"]
    : vs.job === "running" && !vs.direct ? L("המודל הראשי עובד על זה ברקע. אפשר להמשיך לדבר.", "The main model is working on it in the background. You can keep talking.")
    : "";
  const orbClass = { ready: "listening", hearing: "hearing", transcribing: "working", replying: "thinking", speaking: "speaking" }[phase];
  return (
    <div className="voice-mode" role="dialog" aria-modal="true" aria-label={t("voiceMode")} {...(latency !== null ? { "data-latency": latency } : {})}>
      <div className="voice-modes seg" role="group" aria-label={L("איך מדברים", "How to talk")}>
        <button type="button" aria-pressed={!ptt} className={!ptt ? "on" : ""} onClick={() => choosePtt(false)}>{L("בלי ידיים", "Hands-free")}</button>
        <button type="button" aria-pressed={ptt} className={ptt ? "on" : ""} onClick={() => choosePtt(true)}>{L("לחץ ודבר", "Push to talk")}</button>
      </div>
      <button
        type="button"
        className={`voice-orb ${orbClass}${ptt ? " ptt" : ""}${holding ? " held" : ""}${vs.job !== "none" ? ` job-${vs.job}` : ""}`}
        style={{ "--lvl": String(Math.min(1, level * 4)) } as React.CSSProperties}
        aria-label={ptt ? L("החזק כדי לדבר", "Hold to talk") : phase === "speaking" ? t("voiceInterrupt") : label}
        title={ptt ? L("החזק כדי לדבר (או רווח)", "Hold to talk (or Space)") : phase === "speaking" ? t("voiceInterrupt") : label}
        onPointerDown={ptt ? (e) => { e.currentTarget.setPointerCapture?.(e.pointerId); void press(); } : undefined}
        onPointerUp={ptt ? release : undefined}
        onPointerCancel={ptt ? release : undefined}
        onContextMenu={ptt ? (e) => e.preventDefault() : undefined}
        onClick={ptt ? undefined : () => dispatch({ type: "bargeIn" })}
      />
      <p className="voice-status" aria-live="polite">{label}</p>
      {heard && <p className={`voice-heard muted${hearing && (phase === "hearing" || phase === "transcribing") ? " live" : ""}`} dir="auto">“{heard}”</p>}
      {said && phase === "speaking" && <p className="voice-said small" dir="auto">{said}</p>}
      {job && <p className={`voice-job small${vs.job === "approval" ? " warn" : ""}`} role="status">{job}</p>}
      {vs.job === "approval" && approvalCards && <div className="voice-approvals">{approvalCards}</div>}
      <p className="muted small voice-model">
        {vs.fallback
          ? L("אין מודל קול קטן: המודל הראשי עונה בקצרה, ומוקרא משפט אחר משפט.", "No small voice model: the main model answers briefly, said sentence by sentence.")
          : model
            ? L(`קול: ${model} · עבודה: המודל הראשי`, `Voice: ${model} · work: the main model`)
            : L("מכין את מודל הקול…", "Getting the voice model ready…")}
      </p>
      <p className="muted small">{ptt ? L("החזק את העיגול או רווח בזמן הדיבור. אישורים רק על המסך. Esc מסיים.", "Hold the circle or Space while you talk. Approvals only on screen. Esc ends.") : L("דבר רגיל; זה נשלח כשאתה עוצר. אישורים רק על המסך. Esc מסיים.", "Talk normally; it sends when you pause. Approvals only on screen. Esc ends.")}</p>
      <button type="button" onClick={onClose}>{t("voiceEnd")}</button>
    </div>
  );
}
