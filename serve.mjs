// Zero-dependency static server + a small photo-matching proxy endpoint.
// Run: node serve.mjs
// Then open http://localhost:8099
//
// The "Match a Photo" feature needs an OpenAI API key. Put it in a file
// called .env.local next to this script (never commit that file):
//   OPENAI_API_KEY=sk-...
// The key is read here, server-side, and never sent to the browser — the
// page only ever talks to THIS server, never directly to OpenAI. Every
// other feature in the app works with no key at all.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8099;

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
const HAIR_STYLE_DESCRIPTIONS = `
- "default": keep the body's own default short hair as-is. Use this whenever the photo's hairstyle doesn't clearly match one of the options below, or for any long/updo/braided/curly-voluminous style none of these cover (aside from "dreads" below, this app only has short-to-medium men's-style cuts available as real 3D swaps).
- "casual": short, slightly tousled/messy hair with natural volume on top.
- "casual2": short hair, side-swept with a defined side part.
- "adventurer": short-to-medium wavy/textured hair.
- "beach": short tousled "surfer" textured hair.
- "suit": short, neat, combed-back professional hair.
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

TASK:
1. Determine gender from facial features, build, and clothing context
2. Extract the actual visible skin tone (not stereotypical - measure the real color in the photo)
3. Extract the actual visible hair color (measure the real color, accounting for lighting)
4. Match hairstyle to the closest option available
5. Estimate body build and facial structure

GENDER: Choose "male" or "female" based on visible characteristics.

SKIN TONE: Sample the skin color from the face (cheeks, forehead) and provide the average hex color. Account for:
- Lighting conditions in the photo
- Shadows vs. direct light areas
- Use the actual skin visible, not what you assume their ethnicity might be
- If lighting is very dim/bright, adjust mentally for normal lighting

HAIR COLOR: Sample from the hair that's clearly visible (avoid shadows). Provide the actual hex color you see, accounting for:
- Lighting (indoor vs outdoor affects perception)
- Natural vs dyed appearance
- Highlights and lowlights - use the dominant color
- Grey/white hair: use greyish or silver tones (#808080 range for grey, #f0f0f0 for white)

HAIRSTYLE: Pick the closest match from these options:
${HAIR_STYLE_DESCRIPTIONS}

BODY & FACE WEIGHT: most photos through this feature are a tight face/webcam selfie with the shoulders partly or fully out of frame — don't default to 1.0 (average) just because the torso isn't visible; commit to your best real estimate from whatever IS visible, the same way you'd size someone up from a face photo in person.
- faceWeight (use this first, it's usually visible even in a tight closeup): 0.8-0.85 = visibly narrow/angular — defined jawline and cheekbones, some hollow under the cheek. 1.0 = average fullness. 1.15-1.3 = visibly round/full — soft jawline, filled-out cheeks, any visible neck/chin fullness. Actually commit to a value on this scale based on what you see; only use exactly 1.0 when the face genuinely looks average, not as a default for "not sure."
- bodyWeight: 0.75=slim/athletic, 1.0=average, 1.4=heavier build. If shoulders/chest/neck ARE visible, judge directly from them. If the photo is cropped tight to just the face, a fuller face/neck (faceWeight above 1.1) usually goes with a heavier overall build and a narrow face (faceWeight below 0.9) with a slimmer one — use that correlation rather than falling back to 1.0 by default, but don't force bodyWeight and faceWeight to always move in lockstep either if the visible evidence disagrees.

EDGE CASES:
- If face is partially obscured, estimate from visible features
- If wearing hat/hair covered, still pick the closest hairstyle based on hair visible
- If no hair visible, use "default"
- If person is bald/shaved head (no mohawk strip), use "default"

Respond with ONLY valid JSON, no markdown, no explanation. Fill "observations" FIRST, in plain text, describing exactly what you actually see (hair length/texture/color, skin tone, build, any obscuring factors like hats or shadows) before committing to the structured fields below — ground every field that follows in what you just wrote, don't guess independently of it:
{
  "observations": "one or two plain-text sentences describing the real visible hair, skin, and build details this photo shows",
  "genderGuess": "male" or "female",
  "skinToneHex": "#rrggbb (actual color from face in photo)",
  "hairColorHex": "#rrggbb (actual color from hair in photo)",
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

http.createServer((req, res) => {
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
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Character Customizer running at http://localhost:${PORT}`);
  console.log(process.env.OPENAI_API_KEY ? "OPENAI_API_KEY loaded — Match a Photo is enabled." : "No OPENAI_API_KEY found (.env.local) — Match a Photo will show a setup message.");
});
