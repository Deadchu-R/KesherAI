import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
/** Every speed a player offers (Roee: from a quarter to four times). */
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const KEY = "kesher-media-rate";

/** The listening speed, remembered on this device for every player. */
export function useSpeed(): [number, (r: number) => void] {
  const [rate, setRate] = useState(() => {
    try {
      const v = Number(localStorage.getItem(KEY));
      return SPEEDS.includes(v) ? v : 1;
    } catch {
      return 1;
    }
  });
  const set = (r: number) => {
    setRate(r);
    try {
      localStorage.setItem(KEY, String(r));
    } catch {
      /* a convenience */
    }
  };
  return [rate, set];
}

/** A speed picker (0.25× to 4×; `max` for players that go less far, as YouTube's 2×). */
export function SpeedSelect({ rate, onRate, max = 4 }: { rate: number; onRate: (r: number) => void; max?: number }) {
  return (
    <label className="media-speed small" dir="ltr">
      <span aria-hidden="true">⏩</span>
      <select value={Math.min(rate, max)} onChange={(e) => onRate(Number(e.target.value))} aria-label={L("מהירות ניגון", "Playback speed")}>
        {SPEEDS.filter((s) => s <= max).map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
    </label>
  );
}

type MediaProps = React.VideoHTMLAttributes<HTMLVideoElement> & { kind: "video" | "audio" };

/**
 * A video or audio player with the speed picker under it (every player in KesherAI, 0.25×–4×). The ref is the media
 * element itself.
 */
export const Media = forwardRef<HTMLMediaElement | null, MediaProps>(function Media({ kind, onLoadedMetadata, className, ...rest }, ref) {
  const el = useRef<HTMLMediaElement | null>(null);
  useImperativeHandle(ref, () => el.current!, []);
  const [rate, setRate] = useSpeed();
  useEffect(() => {
    if (el.current) el.current.playbackRate = rate;
  }, [rate]);
  const loaded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    e.currentTarget.playbackRate = rate;
    onLoadedMetadata?.(e);
  };
  return (
    <div className={`media-box ${kind}${className ? ` ${className}` : ""}`}>
      {kind === "video" ? <video ref={(n) => { el.current = n; }} {...rest} onLoadedMetadata={loaded} /> : <audio ref={(n) => { el.current = n; }} {...(rest as React.AudioHTMLAttributes<HTMLAudioElement>)} onLoadedMetadata={loaded} />}
      <SpeedSelect rate={rate} onRate={setRate} />
    </div>
  );
});
