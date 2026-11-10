/**
 * Face Landmarker landmark indices used by the try-on engine.
 *
 * "Right"/"left" are the SUBJECT's right/left (anatomical), not the viewer's.
 * In an unmirrored camera image the subject's right eye appears on the image's left.
 * Indices 468–477 are the iris landmarks (present in the 478-point model).
 */
export const LM = {
  /** Glabella-lower / sellion region — top of the nose bridge. */
  noseBridgeTop: 168,
  /** Mid nose bridge — where nose pads typically rest. */
  noseBridgeMid: 6,
  noseTip: 1,

  rightEyeOuter: 33,
  rightEyeInner: 133,
  leftEyeInner: 362,
  leftEyeOuter: 263,
  rightEyeUpper: 159,
  rightEyeLower: 145,
  leftEyeUpper: 386,
  leftEyeLower: 374,

  /** Face silhouette near the cheekbones/temples — face width reference. */
  rightFaceEdge: 234,
  leftFaceEdge: 454,
  rightTemple: 127,
  leftTemple: 356,

  forehead: 10,
  chin: 152,

  rightIrisCenter: 468,
  /** Right iris boundary: 469 (one side), 470 (top), 471 (other side), 472 (bottom). */
  rightIrisRing: [469, 470, 471, 472] as const,
  leftIrisCenter: 473,
  leftIrisRing: [474, 475, 476, 477] as const,
} as const;

export const LANDMARK_COUNT_WITH_IRIS = 478;
export const MESH_LANDMARK_COUNT = 468;

/** Average human horizontal visible iris diameter (HVID), millimetres. Population SD ≈ 0.4–0.5 mm. */
export const IRIS_DIAMETER_MM = 11.7;
