# Eyewear model specification (GLB) — v1

Each product needs **its own** model built to real-world size. The try-on engine handles placement,
true-to-scale sizing per face, temple fitting and occlusion. The model only has to follow the
conventions below. The dev models in `public/models/` (made by `npm run models`) follow this spec
exactly, so open one in Blender as a reference.

## File

- **glTF 2.0 binary (`.glb`)**, one pair of glasses per file, with textures embedded.
- Must pass the [Khronos glTF validator](https://github.khronos.org/glTF-Validator/) with 0 errors.
  `npm run test:render` checks every file in `public/models`.
- Budget: aim for ≤ 60k triangles and ≤ 2.5 MB per model **as exported**, with textures ≤ 1024².
- **Optimise before publishing:** `npm run optimize-model -- exported.glb public/models/name.glb`.
  - It quantises and meshopt-compresses the geometry, converts textures to WebP and validates
    the result.
  - Typically 3–4× smaller, with fit and look unchanged.
  - It needs unique names for materials that use `KHR_materials_volume`.
  - `npm run test:render` expects shipped models to be optimised and under 700 KB.

## Units and axes

| | |
|---|---|
| Units | **metres** at **true physical size**, so a 140 mm frame is 0.140 wide |
| +X | the **wearer's left** (viewer's right when looking at the front of the glasses) |
| +Y | up |
| +Z | forward, out of the wearer's face. Temples point to **−Z** |

Blender's glTF exporter with **"+Y Up"** enabled produces these axes from Blender's default
orientation (front of the frame facing Blender −Y).

## Origin: the nose rest

The origin `(0, 0, 0)` is the point **on the wearer's nose ridge where the frame rests**, on the
symmetry plane:

- **Acetate / saddle bridge:** the top of the bridge's nose arch, at the back surface of the front.
- **Frames with nose pads:** the nose-ridge point at pad height. That is midway between the pads,
  about `0.9 × (half the gap between the pad faces)` in front of the pads. The nose's sides slope
  at about 42°.

The engine puts this point on the tracked nose. Per-product calibration fine-tunes it.

## Pose and shape

- Model the glasses **as worn**: built-in **pantoscopic tilt** (≈ 6–10°, lower rim towards the
  cheeks), face-form wrap and lens base curve.
- **Temples straight back**, both at the same angle, pointing −Z. The engine opens them to the
  wearer's head width and droops them to the ears automatically.

## Node structure

```
glasses                 (root; extras.vto = metadata, optional)
├─ frame                front: rims, bridge, end pieces (mesh)
├─ lens_L, lens_R       lenses as separate meshes (mesh)
├─ nose_pads            optional (mesh)
├─ hardware             optional hinges / screws / rivets on the front (mesh)
├─ temple_L             EMPTY or mesh node whose origin is the LEFT hinge pivot
│   └─ … temple meshes  (arm, tip, hinge knuckle)
└─ temple_R             same for the right side
```

- `temple_L` and `temple_R` (names are case-insensitive; `temple-left` also works) must be **direct
  children of the root**. Their **origin is the hinge axis**, so rotating the node swings the temple
  realistically.
- Optional temple extras: `{"vtoTemple": {"earBend": [x, y, z]}}` is the point (temple-local,
  metres) where the temple bends down over the ear. If it's missing, the engine assumes the temple
  points straight back (−Z).
- Optional node extras: `{"vtoSlot": "<slot>"}` names the part for colour variants and per-product
  overrides. Slots used so far are `frame`, `temple`, `lens`, `metal`, `hinge`, `pad`, `tip`.
  Without it, the slot is inferred from names: anything containing `lens`/`glass` is a lens, `pad`
  is a pad, `temple`/`arm` is a temple, and everything else is `frame`.

## Materials (glTF PBR)

| Part | Recommended |
|---|---|
| Acetate | `metallic 0`, `roughness 0.15–0.3`, **KHR_materials_clearcoat** 1 / 0.03–0.08, IOR 1.49. Tortoise etc. as baseColor texture |
| Crystal / translucent acetate | add **KHR_materials_transmission** 0.8–0.95 + **KHR_materials_volume** (thickness ≈ 0.004 m, attenuation colour/distance for the tint) |
| Metal | `metallic 1`, `roughness 0.15–0.35`, measured base colours (gold ≈ 1.0/0.77/0.34, silver ≈ 0.95/0.94/0.92) |
| Clear lens | `transmission 1`, `roughness ≈ 0.02`, **IOR 1.5–1.6**, optional thin-film **iridescence** for the AR-coating tint |
| Sun lens | `transmission 1` with baseColor = tint (e.g. G-15 ≈ 0.15/0.19/0.13). Gradients as a baseColor texture (v = 0 at the top) |
| Nose pads | silicone: `transmission ≈ 0.7`, `roughness ≈ 0.3`, IOR 1.41 |

Lenses must be closed solids (front, back and edge). Their edges should sit **inside the rim
groove**, so no gap is visible.

## Colourways

Put every colourway in the same file as **KHR_materials_variants** (Blender: *glTF Material
Variants* panel). The product configuration then maps a swatch to a variant name. Simple colour
changes can instead be done per product with `materialOverrides` (slot → colour / roughness /
metalness / tint), without touching the file.

## Metadata (optional, recommended)

Root node extras:

```json
{ "vto": { "spec": 1, "lensWidthMm": 52, "bridgeMm": 18, "templeLengthMm": 145,
           "lensHeightMm": 40, "frameWidthMm": 137.4,
           "lensCenters": [[0.035, -0.0072, 0.0024], [-0.035, -0.0072, 0.0024]] } }
```

`lensCenters` are glasses-space positions (metres) of the left and right lens box centres. They
are used by fit checks and diagnostics.

## Per-product calibration

Stored with the product: `public/products/products.json` now, WooCommerce product meta later. The
fitting lab (`demo/tryon.html`) and the 3D fit preview (`demo/viewer.html`) edit these values live
and export them as JSON.

| Field | Meaning |
|---|---|
| `scale` | multiplier on the modelled physical size (keep 1 for correctly-sized models) |
| `offsetMm` | `[x, y, z]` real millimetres from the nose rest (+y up the nose, +z away from the face) |
| `rotationDeg` | `[tilt, yaw, roll]` about the nose rest; + tilt moves the lower rim towards the cheeks |
| `bridgeAlignment` | where on the nose the frame rests: 0 = nasion (landmark 168), 1 = lower bridge (landmark 6). Default 0.25 |
| `templeAutoFit` | aim the temples at the ears (default true) |
| `templeSpreadDeg`, `templeDroopDeg` | added to the temple fit |
| `faceWidthAdaptation` | 0 = true size on every face (default), 1 = scale with the face |
