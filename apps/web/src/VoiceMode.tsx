import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { encodeWav } from "./Mic";
import { speak, stopSpeaking } from "./Speak";
import { toast } from "./library";
import { t } from "./i18n";

type Phase = "listening" | "hearing" | "working" | "thinking" | "speaking";

/** Loudness (peak of the samples) above which the microphone counts as speech. */
const SPEECH = 0.06;
/** While an answer is read aloud, louder speech is needed to interrupt it (its echo is quieter). */
const BARGE_IN = 0.14;
/** Quiet after speech, in seconds, that ends what the user said. */
const END_SILENCE = 1.1;

/**
 * Voice conversation: the microphone stays open, what the user says is sent
 * when they pause, the answer is read aloud, and then it listens again.
 * Speaking while an answer is read stops it and listens (interrupting).
 *
 * @param props.onSend - Sends the recognized words as a message.
 * @param props.answer - The latest answer that arrived, with its sequence number.
 * @param props.busy - Whether the agent is still working.
 * @param props.onClose - Ends voice mode.
 */
export function VoiceMode({ onSend, answer, busy, onClose }: { onSend: (text: string) => Promise<void>; answer?: { seq: number; text: string }; busy: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("listening");
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState("");
  const phaseRef = useRef<Phase>("listening");
  const lastSeq = useRef(answer?.seq ?? 0);
  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // The microphone, open for the whole session, with a simple loudness detector.
  useEffect(() => {
    let closed = false;
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    const chunks: Float32Array[] = [];
    let loudFor = 0;
    let quietFor = 0;
    void (async () => {
      const info = await api<{ choice: string; local: { engine: boolean; model?: string }; clouds: unknown[] }>("/api/speech/stt").catch(() => null);
      if (info && !(info.local.engine && info.local.model) && !(info.choice.startsWith("cloud:") || (info.choice === "auto" && info.clouds.length))) {
        toast(t("voiceNeedsStt"));
        onClose();
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        toast(t("micDenied"));
        onClose();
        return;
      }
      if (closed) return stream.getTracks().forEach((tr) => tr.stop());
      ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const block = 2048 / ctx.sampleRate;
      node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < d.length; i += 32) peak = Math.max(peak, Math.abs(d[i]!));
        setLevel(peak);
        const p = phaseRef.current;
        if (p === "speaking") {
          // Interrupting: sustained speech over the answer stops it.
          loudFor = peak > BARGE_IN ? loudFor + block : 0;
          if (loudFor > 0.3) {
            stopSpeaking();
            chunks.length = 0;
            loudFor = 0;
            quietFor = 0;
            go("hearing");
          }
          return;
        }
        if (p === "listening") {
          if (peak > SPEECH) {
            chunks.length = 0;
            quietFor = 0;
            go("hearing");
          } else {
            // Keep a little audio from just before speech starts.
            chunks.push(new Float32Array(d));
            if (chunks.length > 4) chunks.shift();
            return;
          }
        }
        if (phaseRef.current !== "hearing") return;
        chunks.push(new Float32Array(d));
        quietFor = peak > SPEECH ? 0 : quietFor + block;
        const length = chunks.length * block;
        if (quietFor > END_SILENCE || length > 30) {
          const wav = encodeWav(chunks.splice(0), ctx!.sampleRate);
          quietFor = 0;
          if (length - END_SILENCE < 0.4) return go("listening"); // a click or a cough
          go("working");
          void transcribe(wav);
        }
      };
      src.connect(node);
      node.connect(ctx.destination);
    })();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => {
      closed = true;
      removeEventListener("keydown", esc);
      stopSpeaking();
      stream?.getTracks().forEach((tr) => tr.stop());
      void ctx?.close();
    };
  }, []);

  const transcribe = async (wav: Blob) => {
    try {
      const res = await fetch(withToken("/api/speech/transcribe"), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const j = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      const text = (j.text ?? "").trim();
      if (!text) return go("listening");
      setHeard(text);
      go("thinking");
      await onSend(text);
    } catch (e) {
      toast((e as Error).message);
      go("listening");
    }
  };

  // A new answer: read it aloud, then listen again.
  useEffect(() => {
    if (!answer || answer.seq <= lastSeq.current) return;
    lastSeq.current = answer.seq;
    if (phaseRef.current === "hearing" || phaseRef.current === "working") return;
    go("speaking");
    void speak(answer.text, () => {
      if (phaseRef.current === "speaking") go("listening");
    });
  }, [answer?.seq]);

  const label = { listening: t("voiceListening"), hearing: t("voiceHearing"), working: t("voiceWorking"), thinking: t("voiceThinking"), speaking: t("voiceSpeaking") }[phase];
  return (
    <div className="voice-mode" role="dialog" aria-modal="true" aria-label={t("voiceMode")}>
      <button
        type="button"
        className={`voice-orb ${phase}`}
        style={{ "--lvl": String(Math.min(1, level * 4)) } as React.CSSProperties}
        aria-label={phase === "speaking" ? t("voiceInterrupt") : label}
        title={phase === "speaking" ? t("voiceInterrupt") : label}
        onClick={() => {
          if (phaseRef.current === "speaking") {
            stopSpeaking();
            go("listening");
          }
        }}
      />
      <p className="voice-status" aria-live="polite">{phase === "thinking" && !busy ? t("voiceThinking") : label}</p>
      {heard && <p className="voice-heard muted" dir="auto">“{heard}”</p>}
      <p className="muted small">{t("voiceHint")}</p>
      <button type="button" onClick={onClose}>{t("voiceEnd")}</button>
    </div>
  );
}
