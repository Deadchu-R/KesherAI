import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The phone app's native speech plugin, as far as the microphone permission goes (Capacitor's standard calls). */
interface NativeMicPermission {
  checkPermissions?: () => Promise<{ microphone?: string; camera?: string }>;
  requestPermissions?: (o?: { permissions: string[] }) => Promise<{ microphone?: string; camera?: string }>;
}

const nativeSpeech = (): NativeMicPermission | undefined =>
  (window as unknown as { Capacitor?: { Plugins?: { KesherSpeech?: NativeMicPermission } } }).Capacitor?.Plugins?.KesherSpeech;

/** Why the microphone could not be opened, in words for the user. */
export class MicError extends Error {}

/**
 * In the phone app, asks Android for a device permission (the system prompt) unless it is already granted. Remote
 * use from the phone records with the phone's own microphone and camera, so the phone is the one that must allow it.
 * Outside the phone app it does nothing (the browser asks on its own).
 *
 * @param kind - Which permission.
 * @returns False when the phone app was asked and the user refused.
 */
export async function askPhone(kind: "microphone" | "camera"): Promise<boolean> {
  const native = nativeSpeech();
  if (!native?.requestPermissions) return true;
  const cur = await native.checkPermissions?.().catch(() => undefined);
  if (cur?.[kind] === "granted") return true;
  const r = await native.requestPermissions({ permissions: [kind] }).catch(() => undefined);
  return r?.[kind] === "granted";
}

/**
 * Opens the camera (video only), asking the phone first like {@link openMic}. Throws a {@link MicError}.
 *
 * @param video - The video constraints for getUserMedia.
 */
export async function openCamera(video: MediaTrackConstraints | true = true): Promise<MediaStream> {
  if (!(await askPhone("camera"))) {
    throw new MicError(L("אין גישה למצלמה. אשר גישה בחלון של הטלפון, או בהגדרות › אפליקציות › KesherAI › הרשאות.", "No access to the camera. Allow it in the phone's prompt, or in Settings › Apps › KesherAI › Permissions."));
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError(L("הדפדפן לא מאפשר מצלמה בכתובת הזו (צריך https).", "The browser blocks the camera on this address (it needs https)."));
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") throw new MicError(L("לא נמצאה מצלמה.", "No camera found."));
    throw new MicError(L("אין גישה למצלמה. אשר גישה בחלון שנפתח, או בהגדרות האתר/האפליקציה.", "No access to the camera. Allow it in the prompt, or in the site or app settings."));
  }
}

/**
 * Opens the microphone. In the phone app it first asks Android for the microphone permission (the system prompt),
 * because the web view alone does not always show one; in a browser, getUserMedia shows the browser's own prompt.
 * Throws a {@link MicError} whose message says what to do.
 *
 * @param audio - The audio constraints for getUserMedia.
 */
export async function openMic(audio: MediaTrackConstraints | true = true): Promise<MediaStream> {
  if (!(await askPhone("microphone"))) {
    throw new MicError(L("אין גישה למיקרופון. אשר גישה למיקרופון בחלון של הטלפון, או בהגדרות › אפליקציות › KesherAI › הרשאות.", "No access to the microphone. Allow it in the phone's prompt, or in Settings › Apps › KesherAI › Permissions."));
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
