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

// Kept in exact sync with HAIR_STYLES below and with HAIR_STYLE_FILES /
// sel-hairstyle in index.html — a style that exists in the app but isn't
// listed here can never be picked by the model (it has no way to know it
// exists), and one listed here but missing from HAIR_STYLES gets silently
// downgraded to "default" by the sanitizer even if the model does pick it.
// ("dreads" was added to the app as its own real hairstyle option, but this
// list — and the sanitizer's whitelist further down — never got updated to
// match, so a real dreadlocked photo could never actually be matched to it.)
// "casual"/"casual2"/"suit" are all "plain short hair" at a glance, which
// made them unstable in practice — the same ordinary short haircut with no
// strong distinguishing feature could plausibly read as any of the three,
// so re-running the exact same photo could flip between them (verified
// directly: three separate runs on the same test photo came back casual,
// then casual2, then suit). Sharpened each to a specific, checkable visual
// feature instead of a vague overall impression, and added an explicit
// "default is the right answer more often than you'd think" rule so a
// plain cut with none of those specific features lands on "default"
// consistently instead of getting forced into a three-way guess.
const HAIR_STYLE_DESCRIPTIONS = `
- "default": keep the body's own default short hair as-is. Use this whenever the photo's hairstyle doesn't clearly match one of the options below, or for any long/updo/braided/curly-voluminous style none of these cover (aside from "dreads" below, this app only has short-to-medium men's-style cuts available as real 3D swaps). IMPORTANT: this is the right answer for an ordinary plain short haircut that doesn't clearly show one of the specific features below — don't force a plain cut into "casual"/"casual2"/"suit" just because it's short hair; only pick one of those three when its own specific feature is clearly visible.
- "casual": hair strands visibly going in multiple different directions (tousled/messy texture), not lying flat or uniform.
- "casual2": a clearly visible, distinct hard part LINE separating the hair into two sections.
- "adventurer": short-to-medium hair with visible wave or curl texture throughout.
- "beach": short tousled hair with a sun-bleached/"surfer" look, often lighter at the tips.
- "suit": hair lying smooth and flat against the scalp with a combed/slicked-back sheen, no visible texture or volume on top.
- "king": short hair that is grey/silver/white in color — pick this whenever the person's real hair color is grey/white/silver, regardless of its shape.
- "punk": shaved sides with a raised mohawk strip down the center — ONLY pick this if the photo clearly shows an actual mohawk.
- "dreads": gathered dreadlocks/twists pulled back into a bun or ponytail — pick this for dreadlocked, locced, or twisted hair gathered at the back/crown, even if the exact length or bun position doesn't match precisely.
`.trim();

async function analyzePhoto(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No OPENAI_API_KEY configured. Create .env.local next to serve.mjs with OPENAI_API_KEY=sk-... and restart the server." }));
    return;
  }

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
    if (!imageDataUrl || !imageDataUrl.startsWith("data:image/")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no image provided" }));
      return;
    }

    const prompt = `Analyze this photo and create a detailed 3D avatar description. Focus on accurately capturing the person's appearance.

CRITICAL: IGNORE BACKGROUND COLORS COMPLETELY. Only extract colors from the person's face and hair.

TASK:
1. Determine gender from facial features, build, and clothing context
2. Extract the actual visible skin tone from FACE ONLY (ignore background, clothing, surroundings)
3. Extract the actual visible hair color from SCALP/HAIR ONLY (ignore background, clothing, surroundings)
4. Match hairstyle to the closest option available
5. Estimate body build and facial structure

GENDER: Choose "male" or "female" based on visible characteristics.

SKIN TONE: Sample ONLY from exposed face areas (cheeks, forehead, chin, nose). Provide the average hex color. Account for:
- Focus exclusively on the person's facial skin, ignore all background colors
- Lighting conditions in the photo (adjust for shadows on face)
- Use the actual exposed skin visible, not what you assume their ethnicity might be
- If lighting is very dim/bright, adjust mentally for neutral/normal lighting
- IMPORTANT: If background is similar color to skin, ignore background entirely - sample from face only

HAIR COLOR: Sample from hair on the SCALP ONLY (top of head, crown, visible hair). Provide the actual hex color. Account for:
- Focus exclusively on hair strands, ignore background and surrounding colors
- Lighting (indoor vs outdoor affects perception - adjust for this)
- Natural vs dyed appearance
- Highlights and lowlights - use the dominant hair color
- Grey/white hair: use greyish or silver tones (#808080 range for grey, #f0f0f0 for white)
- IMPORTANT: Do NOT sample from background colors that might resemble hair

HAIRSTYLE: Pick the closest match from these options:
${HAIR_STYLE_DESCRIPTIONS}

BODY & FACE WEIGHT: most photos through this feature are a tight face/webcam selfie with the shoulders partly or fully out of frame — don't default to 1.0 (average) just because the torso isn't visible; commit to your best real estimate from whatever IS visible, the same way you'd size someone up from a face photo in person.
- faceWeight (use this first, it's usually visible even in a tight closeup): 0.8-0.85 = visibly narrow/angular — defined jawline and cheekbones, some hollow under the cheek. 1.0 = average fullness. 1.15-1.3 = visibly round/full — soft jawline, filled-out cheeks, any visible neck/chin fullness. Actually commit to a value on this scale based on what you see; only use exactly 1.0 when the face genuinely looks average, not as a default for "not sure."
- bodyWeight: 0.75=slim/athletic, 1.0=average, 1.4=heavier build. If shoulders/chest/neck ARE visible, judge directly from them. If the photo is cropped tight to just the face, a fuller face/neck (faceWeight above 1.1) usually goes with a heavier overall build and a narrow face (faceWeight below 0.9) with a slimmer one — use that correlation rather than falling back to 1.0 by default, but don't force bodyWeight and faceWeight to always move in lockstep either if the visible evidence disagrees.

EDGE CASES:
- If face is partially obscured, estimate from visible features only
- If wearing hat/hair covered, still pick the closest hairstyle based on visible hair
- If no hair visible, use "default"
- If person is bald/shaved head (no mohawk strip), use "default"
- If background matches skin/hair color, ONLY use the person's actual body colors, not background

Respond with ONLY valid JSON, no markdown, no explanation. Fill "observations" FIRST, in plain text, describing exactly what you actually see (hair length/texture/color, skin tone, build, any obscuring factors like hats or shadows) before committing to the structured fields below — ground every field that follows in what you just wrote, don't guess independently of it:
{
  "observations": "one or two plain-text sentences describing the real visible hair, skin, and build details this photo shows",
  "genderGuess": "male" or "female",
  "skinToneHex": "#rrggbb (actual color from person's face only, not background)",
  "hairColorHex": "#rrggbb (actual color from person's hair/scalp only, not background)",
  "hairStyle": "default, casual, casual2, adventurer, beach, suit, king, punk, or dreads",
  "bodyWeight": 0.75 to 1.4,
  "faceWeight": 0.8 to 1.3
}`;

    try {
      const apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          // Low, not zero — this is factual extraction (a hairstyle/color
          // either matches or it doesn't), not creative writing, and the
          // default temperature was visibly part of why re-running the same
          // exact photo could land on a different hairStyle each time
          // (verified directly: default temperature flipped between 3
          // different styles across 3 runs on one unchanged photo).
          temperature: 0.2,
          max_tokens: 550, // bumped from 400 to leave room for the new "observations" field ahead of the structured ones
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageDataUrl } }
              ]
            }
          ]
        })
      });
      const apiJson = await apiRes.json();
      if (!apiRes.ok) {
        res.writeHead(apiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: apiJson.error?.message || "OpenAI API error" }));
        return;
      }
      const raw = apiJson.choices?.[0]?.message?.content;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "model returned non-JSON output" }));
        return;
      }

      // Sanitize before this ever reaches the page's color/style code —
      // model output is untrusted input, not something to hand straight to
      // hexToRgb or a style lookup that assumes a valid enum value.
      const HEX_RE = /^#[0-9a-fA-F]{6}$/;
      const HAIR_STYLES = ["default", "casual", "casual2", "adventurer", "beach", "suit", "king", "punk", "dreads"];
      const clamp = (v, lo, hi, fallback) => (typeof v === "number" && isFinite(v)) ? Math.min(Math.max(v, lo), hi) : fallback;
      const safe = {
        genderGuess: parsed.genderGuess === "female" ? "female" : "male",
        skinToneHex: HEX_RE.test(parsed.skinToneHex) ? parsed.skinToneHex : null,
        hairColorHex: HEX_RE.test(parsed.hairColorHex) ? parsed.hairColorHex : null,
        hairStyle: HAIR_STYLES.includes(parsed.hairStyle) ? parsed.hairStyle : "default",
        bodyWeight: clamp(parsed.bodyWeight, 0.75, 1.4, 1),
        faceWeight: clamp(parsed.faceWeight, 0.8, 1.3, 1)
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safe));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request to OpenAI failed: " + err.message }));
    }
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
