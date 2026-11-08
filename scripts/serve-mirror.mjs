// Serves a folder on 127.0.0.1 (with Range requests), so electron-builder downloads the files
// the release workflow already fetched instead of going to GitHub. Usage: node scripts/serve-mirror.mjs <folder> <port>
import { createServer } from "node:http";
import { createReadStream, stat } from "node:fs";
import { join, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "mirror");
const port = Number(process.argv[3] ?? 8099);
createServer((req, res) => {
  const file = resolve(join(root, decodeURIComponent((req.url ?? "/").split("?")[0])));
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404).end();
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = st.size - 1;
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
      end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) return res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
      res.writeHead(206, { "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes" });
    } else res.writeHead(200, { "content-length": st.size, "accept-ranges": "bytes" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file, { start, end }).pipe(res);
  });
}).listen(port, "127.0.0.1", () => console.log(`Serving ${root} on http://127.0.0.1:${port}/`));
