import type { TryOnRenderer } from './try-on-renderer';

/**
 * Matches the virtual lighting to the room: a few times per second the camera image is
 * downsampled to a tiny canvas (locally, never leaves the device), and its mean linear luminance
 * drives environment and key-light intensity, so glasses don't glow in a dim room or look dull in
 * daylight. Changes are eased to avoid flicker.
 */
export class LightEstimator {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  private last = 0;
  private luminance = 0.18;
  private target = 0.18;
  intervalMs = 400;
  enabled = true;

  constructor(private readonly renderer: TryOnRenderer) {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(24, 14) : document.createElement('canvas');
    this.canvas.width = 24;
    this.canvas.height = 14;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as typeof this.ctx;
  }

  /** Call once per rendered frame. */
  update(video: HTMLVideoElement, nowMs: number, dtSec: number): void {
    if (!this.enabled || !this.ctx) return;
    if (nowMs - this.last >= this.intervalMs && video.readyState >= 2) {
      this.last = nowMs;
      this.ctx.drawImage(video, 0, 0, 24, 14);
      const d = this.ctx.getImageData(0, 0, 24, 14).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += 0.2126 * srgbToLinear(d[i]) + 0.7152 * srgbToLinear(d[i + 1]) + 0.0722 * srgbToLinear(d[i + 2]);
      }
      this.target = sum / (d.length / 4);
    }
    const a = 1 - Math.exp(-dtSec / 0.5);
    this.luminance += (this.target - this.luminance) * a;
    // Mid-grey (≈0.18 linear) → intensity 1. Gentle response, clamped.
    const k = Math.min(1.35, Math.max(0.45, Math.pow(this.luminance / 0.18, 0.45)));
    this.renderer.scene.environmentIntensity = k;
    this.renderer.keyLight.intensity = 1.1 * k;
  }

  get sceneLuminance(): number {
    return this.luminance;
  }
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
