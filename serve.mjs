// Zero-dependency static server + a small photo-matching proxy endpoint.
// Run: node serve.mjs
// Then open https://localhost:8099 (see the HTTPS note below for why not http)
//
// The "Match a Photo" feature needs an OpenAI API key. Put it in a file
// called .env.local next to this script (never commit that file):
//   OPENAI_API_KEY=sk-...
// The key is read here, server-side, and never sent to the browser — the
// page only ever talks to THIS server, never directly to OpenAI. Every
// other feature in the app works with no key at all.
//
// ---- Why HTTPS, for a local dev server ----
// Camera access (getUserMedia, used by "Take selfie") only works in a
// "secure context" — HTTPS, or the exact hostname "localhost"/"127.0.0.1".
// Reported directly: opening this on a phone via the computer's LAN IP
// (e.g. http://192.168.1.23:8099, needed to test on an actual phone, not
// just a desktop browser) hit exactly that block — Chrome/Safari refuse
// getUserMedia outright on that origin and hand back a "not allowed by the
// user agent" error that reads like a permission denial but isn't one; no
// permission prompt ever even appears. Serving HTTPS (even a self-signed
// cert — this is a local dev server, not a public one) makes the LAN-IP
// case a secure context too, so the phone can actually test the camera.
// Every other feature already worked fine over plain HTTP; this only
// matters for the selfie path.
import https from "node:https";
import { execSync } from "node:child_process";
import os from "node:os";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePhotoCore } from "./lib/analyzePhotoCore.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8099;

// One-time self-signed cert, regenerated only if missing — not committed
// (see .gitignore), not meant to be a real production cert, just enough
// for a browser to treat this dev server as HTTPS. Includes both
// "localhost" and every LAN IP this machine currently has (via
// subjectAltName) so opening it from a phone on the same WiFi doesn't hit
// a hostname mismatch on top of the expected self-signed warning — a
// browser will still show a one-time "this connection isn't private"
// interstitial to click through (self-signed, unavoidable without a real
// CA), but accepting it does make the origin a secure context.
const CERT_DIR = path.join(ROOT, ".certs");
const CERT_PATH = path.join(CERT_DIR, "dev-cert.pem");
const KEY_PATH = path.join(CERT_DIR, "dev-key.pem");

function localIPv4s() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function ensureCert() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const altNames = ["DNS:localhost", "IP:127.0.0.1", ...localIPv4s().map((ip) => `IP:${ip}`)];
  const configPath = path.join(CERT_DIR, "openssl.cnf");
  fs.writeFileSync(configPath, `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = localhost
[v3_req]
subjectAltName = ${altNames.join(",")}
`.trim());
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" ` +
      `-days 3650 -nodes -config "${configPath}"`,
      { stdio: "pipe" }
    );
    console.log("Generated a local self-signed HTTPS cert (.certs/) — your browser will warn once, that's expected.");
  } catch (err) {
    console.error("Could not generate an HTTPS cert (is `openssl` installed?). Falling back to plain HTTP — camera access won't work except on localhost itself.");
    console.error(err.message);
  }
}

// ---- minimal .env.local loader (no dependency) ----
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

async function analyzePhoto(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; if (body.length > 12 * 1024 * 1024) req.destroy(); });
  req.on("end", async () => {
    let imageDataUrl;
    try {
      imageDataUrl = JSON.parse(body).imageDataUrl;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad request body" }));
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No OPENAI_API_KEY configured. Create .env.local next to serve.mjs with OPENAI_API_KEY=sk-... and restart the server." }));
      return;
    }
    const result = await analyzePhotoCore(apiKey, imageDataUrl);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
}

ensureCert();
const haveCert = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
const createServer = haveCert
  ? (handler) => https.createServer({ key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) }, handler)
  : (handler) => http.createServer(handler);

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze-photo") {
    analyzePhoto(req, res);
    return;
  }

  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  let filePath = path.join(ROOT, urlPath);
  filePath = path.normalize(filePath);

  const normalizedRoot = path.normalize(ROOT);
  if (!filePath.startsWith(normalizedRoot)) { res.writeHead(403); res.end("forbidden"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath);
    // No caching, ever — this app gets edited and reloaded constantly
    // during development, and index.html had no Cache-Control or
    // ETag/Last-Modified validator at all before this, so a plain reload
    // could silently keep serving whatever the browser last cached instead
    // of the actual current file on disk, with no visible sign anything was
    // stale. Small models (.glb/.bin) are the one exception — they're large,
    // never change without also changing their filename/path in practice,
    // and re-fetching them on every single reload would make iterating on
    // index.html itself noticeably slower for no real benefit.
    const cacheable = [".glb", ".bin"].includes(ext);
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": cacheable ? "public, max-age=3600" : "no-store"
    });
    res.end(data);
  });
}).listen(PORT, () => {
  const scheme = haveCert ? "https" : "http";
  console.log(`Character Customizer running at ${scheme}://localhost:${PORT}`);
  if (haveCert) {
    // Camera access needs this exact scheme+origin to be trusted, so the
    // LAN addresses are worth printing explicitly rather than making
    // someone go find their own IP just to test on a phone.
    for (const ip of localIPv4s()) console.log(`  Also reachable on your phone (same WiFi) at ${scheme}://${ip}:${PORT}`);
    console.log("  First visit will show a self-signed-certificate warning — click through it once (\"Advanced\" > \"Proceed\"), that's expected for a local dev cert.");
  } else {
    console.log("  Running over plain HTTP — camera access (\"Take selfie\") will only work when this is opened as exactly http://localhost, not a LAN IP.");
  }
  console.log(process.env.OPENAI_API_KEY ? "OPENAI_API_KEY loaded — Match a Photo is enabled." : "No OPENAI_API_KEY found (.env.local) — Match a Photo will show a setup message.");
});
