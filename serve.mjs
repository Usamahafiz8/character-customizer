// Zero-dependency static server. Run: node serve.mjs
// Then open http://localhost:8099
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8099;

const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

http.createServer((req, res) => {
  let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Character Customizer running at http://localhost:${PORT}`);
});
