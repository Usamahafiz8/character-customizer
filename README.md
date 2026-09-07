# Character Customizer

Two real 3D human characters — male and female — viewable and customizable in the browser.

- `models/Masculine.glb`, `models/Feminine.glb` — real Ready Player Me human 3D scans (reused from `avatar-anim-v2`), not procedural shapes.
- `models/*_hair_mask.png` — hand-verified per-pixel masks marking exactly the hair pixels in each model's baked texture.
- `models/hair/*.bin` — real hair meshes, sourced from an actual open-source asset pack (see below), refit onto this model's head bone.
- Single-page app: `index.html`. Three.js loaded from CDN, no npm install, no build step.

## Run it

Opening `index.html` directly (`file://`) will show a blank canvas — browsers block loading local `.glb`/`.bin` files that way. Serve it instead:

```
node serve.mjs
```

Then open http://localhost:8099

## What's customizable

- **Male / Female** toggle — switches between the two full-body models.
- **Hair color** — real per-pixel recoloring of the model's own baked texture. Only hair pixels change; skin, eyes, clothes, and shoes are untouched.
- **Hair style** — 7 real hair meshes (Casual, Casual 2, Adventurer, Beach, Suit, King, Punk) plus "Default" (the body's own baked hair, no accessory). Each recolors to match the current hair color.
- **Height** slider.
- Drag to orbit, scroll to zoom, auto-rotate toggle.

## Where the hairstyle asset actually came from

Asked to find and use a real open-source asset instead of generating shapes. What I checked, and what I found:

- Every `.glb` already in this workspace: only the two base avatars + RPM's animation clips. No alternate-hairstyle variants anywhere locally.
- Ready Player Me itself shut down permanently (Jan 2026) — no new variants generatable from it.
- Meshy/MetaPerson (AI generators) both need a paid API key nobody has.
- **Found: [Quaternius's "Ultimate Modular Characters"](https://quaternius.com/packs/ultimatemodularcharacters.html) pack — CC0 (public domain, [creativecommons.org/publicdomain/zero/1.0](https://creativecommons.org/publicdomain/zero/1.0/)), free, no login required, downloaded directly from Quaternius's own publicly-shared Google Drive folder.** It ships 12 pre-built character heads (face+hair+eyes combined, several materials per head) for characters like Adventurer/Beach/Suit/King/Punk/Swat/Farmer/Worker/SpaceSuit. **Most of them wear a hat or full helmet over hair, not a distinct hairstyle** — Swat and SpaceSuit are full helmets, Farmer/Worker wear hats — so only 7 of the 12 heads actually have extractable hair: 6 similar short/medium cuts under a material literally named "Hair"/"Hair_White" (Casual, Casual 2, Adventurer, Beach, Suit, King), plus Punk's mohawk, which the pack didn't tag as "hair" at all (it's under "Red"/"Red_Dark" — found by listing every material each head's primitives actually use, not by name-searching for "hair").

**What extraction actually involved** (this pack's rig ≠ this project's rig, so it wasn't a drag-and-drop):
1. Inspected the pack's FBX (via `assimp`) to find the material names, then which meshes used the "Hair"/"Hair_White" material — 6 distinct hairstyles (Casual, Casual 2, Adventurer, Beach, Suit, King).
2. Wrote a one-off Python script (not part of the shipped app) that walks that pack's own node hierarchy, computes each hair mesh's true world-space vertices in bind pose, and re-expresses them **relative to that pack's own Head bone, normalized by that pack's own head size** — a scale-and-rig-independent representation.
3. Separately measured this project's own RPM rig's head size (Head→HeadTop_End = 0.229m), and rescaled the normalized hair geometry into this rig's meters. Verified the result's bounding box was sane (comparable order of magnitude to a head) before ever loading it into three.js.
4. Packed each style's positions/normals/UVs/indices into a small binary file (`models/hair/*.bin`, ~100-240KB each) that `index.html` fetches and turns into a `THREE.BufferGeometry` at runtime, parented onto whichever model's own Head bone — no glTF/skinning needed since it's a static accessory mesh.
5. Rendered every style on both genders, screenshotted, and inspected up close before calling it done (the earlier procedural-dome attempt had already taught this project the hard way not to skip that step).

**Two real rendering bugs hit and fixed along the way** (found by sampling actual rendered pixels, not by inspection):
1. The accessory first used a lit `MeshStandardMaterial`; the avatar's own material is `KHR_materials_unlit` (flat, ignores scene lighting) — the hair rendered grey/washed-out next to it. Fixed by switching to `MeshBasicMaterial` to match.
2. Even unlit, colors still rendered lighter than picked — `renderer.outputEncoding = sRGBEncoding` re-encodes the whole framebuffer on output; a texture has its own `.encoding` to compensate, a plain hex `Color` doesn't. Fixed with `.convertSRGBToLinear()` on the material color. Confirmed by sampling a rendered pixel against the exact hex chosen.

**A real fit bug found and fixed after shipping:** a zoomed screenshot showed visible gaps — dark background showing through — between individual hair-card pieces and the scalp near the temple/ear. This pack's hair is built from 700+ small disconnected "hair card" quads (a normal stylized-hair technique), each originally fit tight against *Quaternius's* head. Uniform scale-up (tried up to 1.4x) did **not** fix it — scaling from the head-bone origin grows the whole cap's distance from the surface right along with it, so the gap doesn't close, it just gets bigger too. What worked, confirmed by re-screenshotting: pulling the cards radially inward — X/Z only, toward the head's own vertical axis, not a uniform 3-axis scale — so they hug this rig's slightly different head contour (`HAIR_FIT_RADIAL = 0.75`), plus a small downward nudge (`HAIR_FIT_OFFSET_Y = -0.02`). Re-verified against all 7 styles on both genders after the fix.

**Another real bug found and fixed after that:** Punk's mohawk only covers a narrow strip, but the baked scalp hair underneath was still showing at full coverage — a mohawk with a full head of hair still on it, not shaved sides. Fixed by "shaving" the baked hair to the model's own sampled skin tone wherever a style like this is active. First pass shaved it for *every* style, which broke the full-coverage ones (Casual, Beach, ...) — their accessory doesn't quite reach the very front hairline the baked hair used to cover, so shaving there left a visible bald patch at the forehead (caught by screenshot, not assumed). Fixed by making it per-style (`HAIR_STYLE_SHAVE`) — only Punk shaves; the rest keep the normal blend.

**Honest limits:** 6 of the 7 styles are all variations on short/medium realistic-style men's hair (that's genuinely what this pack has for non-headgear characters) — only Punk stands out as a clearly different silhouette. No long hair, buns, or afro-type volume among them. If a wider style range is wanted, the same extraction pipeline can be pointed at Quaternius's companion "Ultimate Modular Women" pack (not yet pulled in) or a different pack entirely.
