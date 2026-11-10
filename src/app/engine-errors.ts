import type { CameraErrorCode } from '../camera/camera-controller';

/**
 * Engine error codes. Kept in a tiny module of its own so the UI can classify errors without
 * pulling in the engine (three.js + MediaPipe), which is loaded on demand.
 */
export type EngineErrorCode = CameraErrorCode | 'webgl-unavailable' | 'tracking-load-failed' | 'model-load-failed';

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
