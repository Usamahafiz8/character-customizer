// Shared core for the "Match a Photo" AI call — the actual prompt, the
// OpenAI request, and the response sanitizer, used by BOTH:
//   - serve.mjs (local dev server, plain Node http/https)
//   - api/analyze-photo.js (Vercel serverless function, for the deployed
//     site — https://character-customizer-flame.vercel.app/ had NO backend
//     at all before this file existed: it's a static deployment of
//     index.html with no serverless function behind /api/analyze-photo, so
//     every "Analyze & apply" click there hit Vercel's own 404 page
//     ("This page could not be found") instead of this endpoint. That 404
//     HTML, not any bug in the analysis logic itself, is what the
//     "Unexpected token 'T', "The page c"... is not valid JSON" error was.
// Pulled out into one file specifically because this project already has a
// documented case of the same logic drifting out of sync across two
// call sites (the dreads hairstyle existing in the app but never being
// added to a second, separate copy of this exact prompt) — one shared
// module makes that class of bug structurally impossible instead of
// something to remember to keep in sync by hand.
//
// Kept as plain framework-free Node (no dependencies) so it works
// unchanged under both a raw http.Server handler and Vercel's Node
// serverless runtime.

// Kept in exact sync with HAIR_STYLES below and with HAIR_STYLE_FILES /
// sel-hairstyle in index.html — a style that exists in the app but isn't
// listed here can never be picked by the model (it has no way to know it
// exists), and one listed here but missing from HAIR_STYLES gets silently
// downgraded to "default" by the sanitizer even if the model does pick it.
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
export const HAIR_STYLE_DESCRIPTIONS = `
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

export const HAIR_STYLES = ["default", "casual", "casual2", "adventurer", "beach", "suit", "king", "punk", "dreads"];

export function buildPrompt() {
  return `Analyze this photo and create a detailed 3D avatar description. Focus on accurately capturing the person's appearance.

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
}

// Sanitize before this ever reaches the page's color/style code — model
// output is untrusted input, not something to hand straight to hexToRgb or
// a style lookup that assumes a valid enum value.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function clamp(v, lo, hi, fallback) {
  return (typeof v === "number" && isFinite(v)) ? Math.min(Math.max(v, lo), hi) : fallback;
}
export function sanitizeResult(parsed) {
  return {
    genderGuess: parsed.genderGuess === "female" ? "female" : "male",
    skinToneHex: HEX_RE.test(parsed.skinToneHex) ? parsed.skinToneHex : null,
    hairColorHex: HEX_RE.test(parsed.hairColorHex) ? parsed.hairColorHex : null,
    hairStyle: HAIR_STYLES.includes(parsed.hairStyle) ? parsed.hairStyle : "default",
    bodyWeight: clamp(parsed.bodyWeight, 0.75, 1.4, 1),
    faceWeight: clamp(parsed.faceWeight, 0.8, 1.3, 1)
  };
}

// The whole request/response cycle to OpenAI, returning a plain
// {status, body} pair — deliberately NOT touching any http.ServerResponse
// or Vercel res object, so both callers just take this result and write it
// out however their own runtime expects.
export async function analyzePhotoCore(apiKey, imageDataUrl) {
  if (!apiKey) {
    return { status: 400, body: { error: "No OPENAI_API_KEY configured." } };
  }
  if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return { status: 400, body: { error: "no image provided" } };
  }

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
        max_tokens: 550, // leaves room for the "observations" field ahead of the structured ones
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt() },
              { type: "image_url", image_url: { url: imageDataUrl } }
            ]
          }
        ]
      })
    });
    const apiJson = await apiRes.json();
    if (!apiRes.ok) {
      return { status: apiRes.status, body: { error: apiJson.error?.message || "OpenAI API error" } };
    }
    const raw = apiJson.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 502, body: { error: "model returned non-JSON output" } };
    }
    return { status: 200, body: sanitizeResult(parsed) };
  } catch (err) {
    return { status: 502, body: { error: "request to OpenAI failed: " + err.message } };
  }
}
