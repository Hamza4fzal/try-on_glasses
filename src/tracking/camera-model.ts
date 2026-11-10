/**
 * Virtual pinhole camera that matches MediaPipe's face-geometry environment.
 *
 * Face Landmarker computes the facial transformation matrix assuming:
 *   perspective camera, vertical FOV = 63°, aspect = frameWidth / frameHeight,
 *   camera at the origin looking down −Z, +Y up, +X right (OpenGL convention),
 *   in an UNMIRRORED image.
 *
 * Using the exact same model for rendering means any depth/FOV error in the
 * assumption cancels out: what MediaPipe "saw" re-projects to the same pixels.
 *
 * Units are centimetres (the canonical face model's unit).
 *
 * Normalized image coordinates (u, v): u ∈ [0,1] left→right, v ∈ [0,1] top→bottom,
 * exactly as Face Landmarker reports landmark x/y.
 */
export const MEDIAPIPE_VERTICAL_FOV_DEG = 63;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export class CameraModel {
  readonly fovYDeg: number;
  private tanHalfY: number;
  private aspectRatio = 4 / 3;
  private widthPx = 640;
  private heightPx = 480;

  constructor(fovYDeg = MEDIAPIPE_VERTICAL_FOV_DEG) {
    this.fovYDeg = fovYDeg;
    this.tanHalfY = Math.tan((fovYDeg * Math.PI) / 360);
  }

  setFrameSize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.widthPx = width;
      this.heightPx = height;
      this.aspectRatio = width / height;
    }
  }

  get aspect(): number {
    return this.aspectRatio;
  }
  get frameWidth(): number {
    return this.widthPx;
  }
  get frameHeight(): number {
    return this.heightPx;
  }

  /** Width (cm) of the visible frustum slice at distance `dist` (> 0) in front of the camera. */
  frustumWidthAt(dist: number): number {
    return 2 * dist * this.tanHalfY * this.aspectRatio;
  }

  /**
   * Point on the ray through normalized image coord (u, v) at camera-space depth `z` (< 0).
   * Writes into `out` and returns it.
   */
  unproject<T extends Vec3Like>(u: number, v: number, z: number, out: T): T {
    const dist = -z;
    out.x = (2 * u - 1) * dist * this.tanHalfY * this.aspectRatio;
    out.y = (1 - 2 * v) * dist * this.tanHalfY;
    out.z = z;
    return out;
  }

  /**
   * Projects a camera-space point to normalized image coords. Returns false if the point
   * is behind the camera. `out` receives { x: u, y: v }.
   */
  project(p: Vec3Like, out: { x: number; y: number }): boolean {
    const dist = -p.z;
    if (dist <= 1e-6) return false;
    out.x = (p.x / (dist * this.tanHalfY * this.aspectRatio) + 1) * 0.5;
    out.y = (1 - p.y / (dist * this.tanHalfY)) * 0.5;
    return true;
  }
}
