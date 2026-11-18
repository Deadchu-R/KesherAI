// The tiny client every plugin page can copy: talks to KesherAI through postMessage.
// kesher.call(method, params, onPartial?) → Promise. Methods (docs/PLUGINS.md → "The page API"):
// info, models, chat (stream: true sends pieces to onPartial), runTool, storage.get, storage.set,
// newChat, conversation, insertPrompt, toast, and with "uses" in the manifest:
// image.generate, image.edit, image.upscale ("image"), speech.transcribe, speech.speak ("speech").
/* global window, addEventListener, parent */
window.kesher = (() => {
  let next = 1;
  const waiting = new Map();
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.kesher !== 1 || !waiting.has(m.id)) return;
    const w = waiting.get(m.id);
    if (m.partial !== undefined) return w.onPartial?.(m.partial);
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(m.result);
  });
  return {
    call(method, params = {}, onPartial) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject, onPartial });
        parent.postMessage({ kesher: 1, id, method, params }, "*");
      });
    },
  };
})();
