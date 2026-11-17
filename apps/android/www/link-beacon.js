/* global crypto, fetch, TextEncoder, TextDecoder, atob, AbortSignal */
/**
 * The phone's half of finding the computer again (packages/shared/src/link-beacon.ts has the full story and the
 * computer's half; link-beacon.test.ts checks the two agree). When the saved addresses do not answer, the phone
 * reads the computer's new address, encrypted with its own key, from an ntfy topic only that key can name.
 */
(function () {
  const SERVER = "https://ntfy.sh";
  const bytes = (s) => new TextEncoder().encode(s);
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const secretOf = async (key) => hex(await crypto.subtle.digest("SHA-256", bytes(key)));
  const topicOf = async (secret) => `kai${hex(await crypto.subtle.digest("SHA-256", bytes(`kesherai-link-topic:${secret}`))).slice(0, 40)}`;
  const keyOf = async (secret) => crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", bytes(`kesherai-link-key:${secret}`)), "AES-GCM", false, ["decrypt"]);
  async function open(secret, sealed) {
    try {
      const all = unb64url(String(sealed).trim());
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await keyOf(secret), all.slice(12));
      const o = JSON.parse(new TextDecoder().decode(plain));
      if (typeof o.url !== "string" || !/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(o.url)) return undefined;
      return { url: o.url.replace(/\/$/, ""), t: Number(o.t) || 0, name: typeof o.name === "string" ? o.name.slice(0, 60) : undefined };
    } catch {
      return undefined;
    }
  }
  /**
   * The computer's newest address for these keys (the phone's own key first, then the shared one), or undefined.
   *
   * @param keys - The keys this phone holds for that computer.
   */
  async function find(keys) {
    let best;
    for (const key of keys.filter(Boolean)) {
      const secret = await secretOf(key);
      const text = await fetch(`${SERVER}/${await topicOf(secret)}/json?poll=1&since=24h`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
      for (const line of text.split("\n")) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m?.event !== "message" || typeof m.message !== "string") continue;
        const link = await open(secret, m.message);
        if (link && (!best || link.t > best.t)) best = link;
      }
      if (best) return best;
    }
    return best;
  }
  globalThis.KesherBeacon = { find, secretOf, topicOf, open };
})();
