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

To also enable **Match a Photo** (selfie/upload → AI-configured character), copy `.env.local.example` to `.env.local` and put a real OpenAI API key in it, then restart `node serve.mjs`. Every other feature works with no key at all.

## What's customizable

- **Match a Photo** — take a selfie or upload a photo; an AI vision call estimates skin tone, hair color, hair style (from the real options this app has), gender, and build, then applies all of it the same way the manual controls would. See below for how this works and its limits.
- **Male / Female** toggle — switches between the two full-body models.
- **Skin tone** — real per-pixel recoloring of the model's own baked texture, across every region that's actually skin (face, neck, ears, arms, hands), independent of clothes/eyes/hair.
- **Hair color** — real per-pixel recoloring of the model's own baked texture. Only hair pixels change; skin, eyes, clothes, and shoes are untouched.
- **Hair style** — 7 real hair meshes (Casual, Casual 2, Adventurer, Beach, Suit, King, Punk) plus "Default" (the body's own baked hair, no accessory). Each recolors to match the current hair color.
- **Height**, **Body weight** (slim ↔ heavy), and **Face weight** (narrow ↔ chubby) sliders.
- Drag to orbit, scroll to zoom, auto-rotate toggle.

## Match a Photo

Take a selfie (camera capture, downscaled client-side to a max 512px JPEG before sending) or upload one, then click "Analyze & apply to character".

**The API key never touches the browser.** The page POSTs the photo to this app's own local server (`/api/analyze-photo` in `serve.mjs`), which reads `OPENAI_API_KEY` from `.env.local` and makes the OpenAI call itself, server-side. If the page called OpenAI directly with the key embedded in its JS, anyone who opened devtools on it could read the key back out and use it on your account — routing through a server you control is the standard fix, not a hypothetical concern.

The server sends the photo to `gpt-4o-mini` (vision) with a prompt listing this app's actual available options — it can't invent a hairstyle that doesn't exist here, only pick the closest real one — and asks for a small structured JSON result: `genderGuess`, `skinToneHex`, `hairColorHex`, `hairStyle`, `bodyWeight`, `faceWeight`. The server validates every field before it ever reaches the page's own code (clamped numeric ranges, hex-format check, hairStyle restricted to the real enum) — model output is untrusted input, not something to hand straight to color-parsing code that assumes it's already valid.

Applying the result reuses the exact same functions the manual sliders/pickers call (`refreshBakedHair`, `rebuildHairAccessory`, `applyBodyShape`, `setGender`) — no separate/duplicate apply logic for the AI path.

**Honest limits:**
- Hair style can only match one of this app's 7 real options (see below) — mostly short/medium men's cuts. A photo with long hair, braids, or an updo will reasonably fall back to "Default" rather than force a bad match.
- Height isn't estimated — there's no reliable way to judge someone's actual height from a photo with no size reference in frame.
- It's one AI's visual estimate, not a measurement — skin tone and hair color will be close, not pixel-exact.
- Requires OpenAI API credit on your account (a few cents per photo with `gpt-4o-mini`) — separate from a ChatGPT subscription, which doesn't include API access.

## Skin tone

The hair-mask technique (per-pixel mask on the baked texture, same "hue/sat replace, keep shading" trick) extends to skin — but skin turned out to be a much harder mask to build correctly, and the color math needed a real fix too. Both problems were only found by actually rendering and looking, not by reasoning about the code.

**Mask problem:** my first attempt built the skin mask the same way as the hair mask — flood-fill by color from a seed pixel, all within the "head" texture quadrant that visibly looks like a front-projected face photo. Result: half the face recolored, half didn't, with a hard boundary across the cheek. Investigated by tracing actual mesh vertices (forehead, cheek, jaw) back to their real UV coordinates — turned out this model's face/neck/skin sample from texture pixels **scattered across the entire 1024×1024 atlas** (forehead samples from pixel (847,1020), a cheek vertex from (1015,142), jaw from inside the "obvious" quadrant at (254,305)) — nothing like one contiguous region. 2D flood-fill from a single seed can never find disconnected islands like that. Fixed by building the mask from the actual geometry instead of image color: read every vertex's real bone weights (Head/Neck/arm/hand/leg/foot bones = skin, explicitly excluding eye-bone-weighted vertices) and its real UV coordinate, mark those exact texture pixels, dilate to bridge the gaps between individual vertex samples, then intersect with a skin-color classifier so the dilation can't bleed onto clothing or hair it happens to touch.

**Color problem:** even with a correct mask, picking a very dark tone barely changed anything. The hue/sat-replace-keep-luminance trick that works well for hair actively defeats the point for skin — light-vs-dark IS what "skin tone" mostly means, and preserving each pixel's original (bright, well-lit) luminance regardless of the picked swatch keeps the result looking like the original tone no matter how dark a color is chosen. First fix (multiply the luminance by a ratio) blew light presets out to solid white — a bright target's luminance multiplied against already-bright highlight pixels overflows past 1.0. Second fix (add a flat offset) still did, for the same reason. Final fix: a screen/multiply hybrid — lightening approaches white asymptotically, darkening approaches black asymptotically — so neither direction can ever clip however extreme the target color or however bright/dark the pixel already was, no clamping needed. Verified across the full preset range (near-white to near-black) before shipping.

## Body weight and face weight

Neither model has morph targets (checked — see below), so there's no built-in "fat/slim" blend shape. Same technique as everywhere else in this app: reshape the bind-pose vertices, keyed off which bone dominates each vertex's skin weight — skinning itself is never touched, so the model still poses/animates correctly afterward.

- **Body weight**: torso+hips, each arm, and each leg are five independent bone groups, each scaled on the axis pair that's actually its girth (torso/legs: X/Z, since they run vertically; arms: Y/Z, since they run horizontally in this T-pose).
- **Face weight**: ported directly from a proven `applyFaceShape`/jaw-width function already sitting unused in the sibling `avatar-component` project — a Y-banded influence zone between the chin and browline, smoothstepped to zero at both ends.

**Two real bugs found while building this, both caught by rendering and fixed before shipping:**
1. First version hard-assigned each vertex to exactly one bone group (≥50% dominant weight) and scaled that group as a rigid block. Screenshot evidence: the shirt's chest logo came out visibly skewed right at the shoulder, because two neighboring vertices smoothly weighted across Spine2/LeftShoulder could land in *different* groups that scale on different axes — a hard seam exactly where the rig blends smoothly. Fixed by giving every vertex a *fractional* membership per group (its real skin-weight sum toward that group) and blending continuously instead of assigning it to one.
2. Face weight then broke the eyes at anything but a mild setting — a real "googly eye" disconnect: the eyeballs are separate geometry (their own bones) that never moves, but the skin around them did, exposing white sclera past the still-fixed eyeball. This is a known failure mode the sibling project's own code comments already describe hitting once. Fixed by finding each eyeball's own position (the weighted centroid of its own bone's vertices) and excluding any head vertex within a protective radius of either eye from the reshape entirely, so the socket ring stays anchored around the fixed eyeball no matter how far the slider goes.

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

**A third bug found and fixed:** on the female model, Punk's shaved sides still showed a large skin-toned *bump* behind the mohawk. Turned out the baked "hair" isn't only texture — a real cluster of the body mesh's own vertices bulges outward to give hair its 3D volume (confirmed by inspecting the glb directly: those vertices' UVs land exactly on the same flat-color swatch already identified for bulk hair). Recoloring that region to skin only changes its color, not its shape, so the bump stayed. Fixed by identifying those ~600 vertices by UV and, only while a shave-style is active, collapsing them inward toward their own centroid (tucking them inside the head's own surface) — then restoring their original positions when switching back to Default or a non-shave style. Re-verified after the fix: gender-switching mid-style and rapid style-toggling both hold up with no stale bump state.

**Honest limits:** 6 of the 7 styles are all variations on short/medium realistic-style men's hair (that's genuinely what this pack has for non-headgear characters) — only Punk stands out as a clearly different silhouette. No long hair, buns, or afro-type volume among them. If a wider style range is wanted, the same extraction pipeline can be pointed at Quaternius's companion "Ultimate Modular Women" pack (not yet pulled in) or a different pack entirely.

## Outfits (in progress, currently hidden — `sel-outfit` is `display:none` in `index.html`)

A "Casual" outfit (top/bottom/shoes, both genders) was built from **[Quaternius's "Ultimate Modular Men/Women"](https://quaternius.com/packs/ultimatemodularcharacters.html)** packs — the same CC0 source as the hairstyles, downloaded in full to `models/ultimate-modular-men/` and `models/ultimate-modular-women/` (not committed — 264MB/222MB). Unlike the hair pack, this one already ships each outfit pre-split per body region as real skinned FBX (`Separate Skeletal Meshes and Animations/<Outfit>/<Outfit>_Body|Legs|Feet.fbx`), so extraction was picking the non-"Skin" material out of each region rather than a mask hack.

**Why this needed more than a straight port, and where it stands:**

1. **First attempt (hair's technique — rigid, non-skinned, glued to the Hips bone) looked completely broken.** Root cause, confirmed by comparing bone rotations, not assumed: rigid attachment only works for geometry that doesn't cross a joint (a head cap). A hoodie's sleeves and pants' legs cross the shoulder/elbow/hip/knee, and Quaternius's own source FBX is authored in a classic arms-out T-pose — a rigid mesh can only ever show up in the pose it was authored in.
2. **Second attempt: real skinning via nearest-vertex weight transfer** (for each outfit vertex, copy the skin weights of the closest RPM body-mesh vertex). Mechanically worked, but nearest-vertex-in-absolute-space only makes sense when both meshes are already in roughly the same pose — they weren't (see #1), so a sleeve-cuff vertex's "nearest" RPM vertex was often on the torso, not the arm. Confirmed by inspecting the actual bone assignments live (e.g. shoulder-area vertices coming back weighted to the *Head* bone).
3. **Third attempt: bone-name correspondence instead of proximity.** Built an explicit Quaternius→RPM bone name map (`Shoulder.L`→`LeftShoulder`, `UpperArm.L`→`LeftArm`, etc., with a parent-walk fallback for anything unmapped or gender-inconsistent, e.g. RPM male has no `LeftHandPinky4`), and copied each vertex's *own* real Quaternius skin weights across under the mapped bone identity. Verified correct by direct inspection — a hoodie shoulder vertex now genuinely resolves to `LeftShoulder`/`LeftArm`/`Spine2`/`Neck`, not `Head`. **This part is done and correct.**
4. **What's still missing: the geometry itself is still Quaternius's T-pose shape**, just rigidly rescaled into RPM's coordinate frame — correct bone weights don't fix a vertex that was authored in the wrong place, since skinning only reproduces *changes* from a bind pose, and the bind pose here is still "arm out." Fixing this for real needs full FK pose-retargeting: compute the rotation delta between each rig's bone segment directions (Quaternius UpperArm.L→LowerArm.L vs. RPM LeftArm→LeftForeArm, etc.) and re-pose the garment's vertices through that chain before baking. Not done yet.
5. **Verifying #4 is separately blocked right now:** the app's own "T-pose (static)" option doesn't reproduce the model's real authored rest pose — live-checked by comparing `LeftForeArm`'s world position right after selecting it against the same bone's position read directly from the `.glb` file, and they don't match (the arm is visibly bent partway down, not the file's actual horizontal rest angle). That's a bug in the Animation feature itself, not in the outfit code, but it means there's currently no reliable rest pose to retarget *against* or screenshot-verify a fix with.

The extraction/remap script (`build_outfit_retarget.py`, not checked into this repo — same one-off-script convention as the hair pipeline) reads each piece's real FBX skin data via `assimp export ... gltf2`, applies the mesh node's own baked transform (a 100×-scale + axis-fix matrix Quaternius's exporter adds — verified by comparing against the equivalent `-ptv` OBJ export, which matched exactly), rebases onto this rig's own Hips position, and writes the same 5-attribute `.bin` layout as hair plus `skinIndex`/`skinWeight` (`models/outfits/*.bin`).

**Bottom line:** the harder-than-expected half (correct real skinning onto a differently-authored rig) is done and verified. The remaining half (pose retargeting) is a distinct, well-understood problem, but real work, and there's no reliable rest pose in the live app to verify it against until the Animation feature's own T-pose bug is fixed first.
