// The tiny client every plugin page can copy: talks to KesherAI through postMessage.
// kesher.call(method, params) → Promise. Methods: info, models, chat, runTool,
// storage.get, storage.set, newChat, conversation, insertPrompt, toast.
/* global window, addEventListener, parent */
window.kesher = (() => {
  let next = 1;
  const waiting = new Map();
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.kesher !== 1 || !waiting.has(m.id)) return;
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) reject(new Error(m.error));
    else resolve(m.result);
  });
  return {
    call(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        parent.postMessage({ kesher: 1, id, method, params }, "*");
      });
    },
  };
})();
