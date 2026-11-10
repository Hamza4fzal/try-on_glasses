/**
 * Approximate head geometry behind the face, in MediaPipe canonical face space (cm; +x = the
 * subject's left, +y up, +z out of the face). The canonical mesh only covers the face front, so the
 * temples' ear rest and the occluders for the skull and ears are modelled here.
 *
 * Values come from adult anthropometry relative to the canonical mesh: the face-oval landmarks
 * 127/356 sit at x ≈ ±7.74 near the temples, and the ear root (where temples rest) is about one
 * temple length behind a typical lens plane, near eye height. They scale with the face (canonical
 * space), so they follow the tracked face size automatically.
 */
export const HEAD_MODEL = {
  /** Where the temple centreline rests on top of the ear root (left side; mirror x for right). */
  earRest: { x: 7.95, y: 3.05, z: -4.3 },
  /** Skull ellipsoid: hides temples behind the head when it turns. */
  skull: { center: [0, 2.0, -5.5] as const, radii: [7.45, 9.5, 9.6] as const },
  /** Ear proxies (left; mirrored): hide temple tips that wrap behind the ears. */
  ear: { center: [8.3, 0.6, -5.8] as const, radii: [0.7, 2.4, 1.6] as const },
  /** The face occluder is pushed this far inside the canonical surface (cm) so frames resting on the skin are not clipped. */
  faceInset: 0.25,
} as const;
