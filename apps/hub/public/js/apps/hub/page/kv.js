/**
 * The hub page's IndexedDB: one key-value store (`kesher-hub` › `kv`), used by the page and by the service worker.
 * Structured clone keeps the device's CryptoKey usable but not exportable, so the private key never leaves the browser.
 *
 * Keys: `device` (this browser's identity: id, token, key pair), `tasks`, `pcKeys` (the paired PCs' public keys and
 * names, for the service worker), `answered` (asks answered from a notification). No DOM here: the service worker
 * imports this file too.
 */
const DB = "kesher-hub";
let dbp;
/** Opens the page's database. */
function db() {
    dbp ??= new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
    return dbp;
}
/**
 * Reads one value of the page's database.
 *
 * @param key - The key.
 * @returns The value, or undefined.
 */
export async function get(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const r = d.transaction("kv").objectStore("kv").get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
/**
 * Writes (or, with undefined, deletes) one value of the page's database.
 *
 * @param key - The key.
 * @param value - The value (structured clone), or undefined to delete it.
 */
export async function put(key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const tx = d.transaction("kv", "readwrite");
        if (value === undefined)
            tx.objectStore("kv").delete(key);
        else
            tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
