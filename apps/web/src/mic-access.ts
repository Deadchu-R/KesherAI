import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The phone app's native speech plugin, as far as the microphone permission goes (Capacitor's standard calls). */
interface NativeMicPermission {
  checkPermissions?: () => Promise<{ microphone?: string }>;
  requestPermissions?: (o?: { permissions: string[] }) => Promise<{ microphone?: string }>;
}

const nativeSpeech = (): NativeMicPermission | undefined =>
  (window as unknown as { Capacitor?: { Plugins?: { KesherSpeech?: NativeMicPermission } } }).Capacitor?.Plugins?.KesherSpeech;

/** Why the microphone could not be opened, in words for the user. */
export class MicError extends Error {}

/**
 * Opens the microphone. In the phone app it first asks Android for the microphone permission (the system prompt),
 * because the web view alone does not always show one; in a browser, getUserMedia shows the browser's own prompt.
 * Throws a {@link MicError} whose message says what to do.
 *
 * @param audio - The audio constraints for getUserMedia.
 */
export async function openMic(audio: MediaTrackConstraints | true = true): Promise<MediaStream> {
  const native = nativeSpeech();
  if (native?.requestPermissions) {
    const cur = await native.checkPermissions?.().catch(() => undefined);
    if (cur?.microphone !== "granted") {
      const r = await native.requestPermissions({ permissions: ["microphone"] }).catch(() => undefined);
      if (r?.microphone !== "granted") {
        throw new MicError(L("אין גישה למיקרופון. אשר גישה למיקרופון בחלון של הטלפון, או בהגדרות › אפליקציות › KesherAI › הרשאות.", "No access to the microphone. Allow it in the phone's prompt, or in Settings › Apps › KesherAI › Permissions."));
      }
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError(L("הדפדפן לא מאפשר מיקרופון בכתובת הזו (צריך https). פתח דרך אפליקציית KesherAI בטלפון או דרך ה-Hub.", "The browser blocks the microphone on this address (it needs https). Open it in the KesherAI phone app or through the Hub."));
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === "NotFoundError") throw new MicError(L("לא נמצא מיקרופון.", "No microphone found."));
    throw new MicError(L("אין גישה למיקרופון. אשר גישה בחלון שנפתח, או בהגדרות האתר/האפליקציה.", "No access to the microphone. Allow it in the prompt, or in the site or app settings."));
  }
}
