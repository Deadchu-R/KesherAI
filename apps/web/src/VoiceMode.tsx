import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortSpoken, VOICE_LINES, voiceStart, voiceStep, type VoiceEffect, type VoiceEvent, type VoiceState } from "@kesher/shared";
import { api, withToken } from "./api";
import { encodeWav } from "./Mic";
import { speak, stopSpeaking } from "./Speak";
import { toast } from "./library";
import { getLocale, he$, t } from "./i18n";

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
 *
 * @param props.chatId - The chat.
 * @param props.onSend - Sends words to the chat as a message (the main model's turn).
 * @param props.answer - The latest answer in the chat, with its sequence number.
 * @param props.busy - Whether the main model is still working.
 * @param props.approvals - Ids of the approval requests waiting in the chat.
 * @param props.approvalCards - Those requests' cards, shown in voice mode so they can be answered on screen.
 * @param props.onClose - Ends voice mode.
 */
export function VoiceMode({ chatId, onSend, answer, busy, approvals, approvalCards, onClose }: { chatId: string; onSend: (text: string) => Promise<void>; answer?: { seq: number; text: string }; busy: boolean; approvals: string[]; approvalCards?: ReactNode; onClose: () => void }) {
  const he = getLocale() === "he";
  const stateRef = useRef<VoiceState>(voiceStart({ he, fallback: false, lastSeq: answer?.seq ?? 0 }));
  const [vs, setVs] = useState(stateRef.current);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [ptt, setPtt] = useState(readPtt);
  const [holding, setHolding] = useState(false);
  const pttRef = useRef(ptt);
  pttRef.current = ptt;
  const holdRef = useRef(false);
  /** The recorded words waiting for the `transcribe` effect. */
  const wavRef = useRef<Blob | null>(null);
  /** Changes with every line said, so a stopped line's end does not end the next one. */
  const sayId = useRef(0);
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
        const my = ++sayId.current;
        setSaid(f.text);
        void speak(f.text, () => my === sayId.current && dispatch({ type: "spoken" }));
        return;
      }
      case "stopSpeaking":
        sayId.current++;
        stopSpeaking();
        return;
      case "transcribe": {
        const wav = wavRef.current;
        wavRef.current = null;
        if (wav) void transcribe(wav);
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
        void onSend(f.text).catch((err: Error) => toast(err.message));
        return;
      case "summarize": {
        const done = (say: string) => dispatch({ type: "summary", text: f.direct ? say : `${VOICE_LINES.done[he ? "he" : "en"]} ${say}` });
        if (stateRef.current.fallback) return done(shortSpoken(f.text, he));
        void api<{ say: string }>(`/api/voice/${encodeURIComponent(chatId)}/summary`, { method: "POST", body: { text: f.text, he } }).then((r) => done(r.say), () => done(shortSpoken(f.text, he)));
        return;
      }
    }
  };

  const transcribe = async (wav: Blob) => {
    try {
      const res = await fetch(withToken("/api/speech/transcribe"), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const j = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      const text = (j.text ?? "").trim();
      if (text) setHeard(text);
      dispatch({ type: "transcript", text });
    } catch (e) {
      toast((e as Error).message);
      dispatch({ type: "transcript", text: "" });
    }
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
  const chunks = useRef<Float32Array[]>([]);
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        // Blocked: stay open in push-to-talk, so a press after allowing the microphone tries again.
        toast(t("micDenied"));
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
    const node = ctx.createScriptProcessor(2048, 1, 1);
    const block = 2048 / ctx.sampleRate;
    let loudFor = 0;
    let quietFor = 0;
    node.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < d.length; i += 32) peak = Math.max(peak, Math.abs(d[i]!));
      setLevel(peak);
      const buf = chunks.current;
      if (pttRef.current) {
        if (holdRef.current) buf.push(new Float32Array(d));
        return;
      }
      const p = stateRef.current.phase;
      if (p === "speaking") {
        // Barge-in: sustained speech over the answer stops it.
        loudFor = peak > BARGE_IN ? loudFor + block : 0;
        if (loudFor > 0.3) {
          buf.length = 0;
          loudFor = 0;
          quietFor = 0;
          dispatch({ type: "speechStart" });
        }
        return;
      }
      if (p === "ready" || p === "replying") {
        if (peak > SPEECH) {
          quietFor = 0;
          dispatch({ type: "speechStart" });
        } else {
          // Keep a little audio from just before speech starts.
          buf.push(new Float32Array(d));
          if (buf.length > 4) buf.shift();
          return;
        }
      }
      if (stateRef.current.phase !== "hearing") return;
      buf.push(new Float32Array(d));
      quietFor = peak > SPEECH ? 0 : quietFor + block;
      const length = buf.length * block;
      if (quietFor > END_SILENCE || length > 30) {
        wavRef.current = encodeWav(buf.splice(0), ctx.sampleRate);
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
      sayId.current++;
      stopSpeaking();
      m.stream?.getTracks().forEach((tr) => tr.stop());
      void m.ctx?.close();
    };
  }, []);

  // Push-to-talk: press starts (and stops an answer being said), release sends.
  const press = async () => {
    if (holdRef.current) return;
    if (phone) return void nativeOnce();
    holdRef.current = true;
    setHolding(true);
    chunks.current.length = 0;
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
    const ctx = mic.current.ctx;
    const buf = chunks.current.splice(0);
    const seconds = ctx ? (buf.length * 2048) / ctx.sampleRate : 0;
    if (ctx && buf.length) wavRef.current = encodeWav(buf, ctx.sampleRate);
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
    <div className="voice-mode" role="dialog" aria-modal="true" aria-label={t("voiceMode")}>
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
      {heard && <p className="voice-heard muted" dir="auto">“{heard}”</p>}
      {said && phase === "speaking" && <p className="voice-said small" dir="auto">{said}</p>}
      {job && <p className={`voice-job small${vs.job === "approval" ? " warn" : ""}`} role="status">{job}</p>}
      {vs.job === "approval" && approvalCards && <div className="voice-approvals">{approvalCards}</div>}
      <p className="muted small voice-model">
        {vs.fallback
          ? L("אין מודל קול קטן: המודל הראשי עונה, ומוקרא בקצרה.", "No small voice model: the main model answers, read shorter.")
          : model
            ? L(`קול: ${model} · עבודה: המודל הראשי`, `Voice: ${model} · work: the main model`)
            : L("מכין את מודל הקול…", "Getting the voice model ready…")}
      </p>
      <p className="muted small">{ptt ? L("החזק את העיגול או רווח בזמן הדיבור. אישורים רק על המסך. Esc מסיים.", "Hold the circle or Space while you talk. Approvals only on screen. Esc ends.") : L("דבר רגיל; זה נשלח כשאתה עוצר. אישורים רק על המסך. Esc מסיים.", "Talk normally; it sends when you pause. Approvals only on screen. Esc ends.")}</p>
      <button type="button" onClick={onClose}>{t("voiceEnd")}</button>
    </div>
  );
}
