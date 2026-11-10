/**
 * Camera access with explicit, user-initiated start and graceful error classification.
 *
 * Privacy: the stream is attached only to a local <video> element. Nothing here sends frames
 * anywhere. stop() ends every track so the browser's camera indicator turns off.
 */

export type CameraErrorCode =
  | 'insecure-context' // getUserMedia requires HTTPS (or localhost)
  | 'unsupported' // no mediaDevices API (very old browser / some in-app webviews)
  | 'permission-denied'
  | 'no-camera'
  | 'camera-busy' // in use by another app, or hardware error
  | 'constraints' // no camera satisfies the constraints (rare after fallback)
  | 'interrupted' // stream ended while running (unplugged, revoked, OS took it)
  | 'unknown';

export class CameraError extends Error {
  constructor(
    readonly code: CameraErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export type FacingMode = 'user' | 'environment';

export interface CameraStartOptions {
  deviceId?: string;
  facingMode?: FacingMode;
  /** Ideal capture height. 720 balances tracking accuracy, photo quality and mobile perf. */
  idealHeight?: number;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export class CameraController {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private currentFacing: FacingMode = 'user';
  private currentDeviceId: string | null = null;
  private onEndedHandler = () => this.handleTrackEnded();
  private gen = 0;

  /** Called if the stream dies while running. */
  onInterrupted: ((err: CameraError) => void) | null = null;

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement('video');
    // Required for inline autoplay on iOS Safari.
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.muted = true;
    this.video.autoplay = true;
  }

  /**
   * Changes on every start()/stop(). A caller that started the camera can compare it later to
   * know whether the running stream is still the one it asked for.
   */
  get generation(): number {
    return this.gen;
  }

  /** Frame rate the camera actually delivers (track settings), if the browser reports it. */
  get frameRate(): number | undefined {
    const fr = this.stream?.getVideoTracks()[0]?.getSettings().frameRate;
    return typeof fr === 'number' && fr > 0 ? fr : undefined;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  get facingMode(): FacingMode {
    return this.currentFacing;
  }

  /** True when the preview should be mirrored (front/selfie camera — what people expect). */
  get shouldMirror(): boolean {
    return this.currentFacing === 'user';
  }

  get deviceId(): string | null {
    return this.currentDeviceId;
  }

  static checkSupport(): CameraError | null {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return new CameraError('insecure-context', 'Camera access requires a secure (HTTPS) connection.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return new CameraError('unsupported', 'This browser does not support camera access.');
    }
    return null;
  }

  /** Lists video inputs. Labels are only populated after permission has been granted. */
  async listCameras(): Promise<CameraInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  async start(opts: CameraStartOptions = {}): Promise<void> {
    const unsupported = CameraController.checkSupport();
    if (unsupported) throw unsupported;
    this.stop();
    const gen = this.gen;
    // stop() or a newer start() while the browser was asking: never keep a stream nobody wants.
    const superseded = (s: MediaStream | null) => {
      if (gen === this.gen) return;
      for (const t of s?.getTracks() ?? []) t.stop();
      throw new CameraError('interrupted', 'Camera start was cancelled.');
    };

    const idealHeight = opts.idealHeight ?? 720;
    const base: MediaTrackConstraints = {
      height: { ideal: idealHeight },
      width: { ideal: Math.round((idealHeight * 16) / 9) },
      frameRate: { ideal: 30, max: 60 },
    };
    const primary: MediaTrackConstraints = opts.deviceId
      ? { ...base, deviceId: { exact: opts.deviceId } }
      : { ...base, facingMode: { ideal: opts.facingMode ?? 'user' } };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: primary, audio: false });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
        // Retry with the loosest request before giving up.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (err2) {
          throw classify(err2);
        }
      } else {
        throw classify(err);
      }
    }

    superseded(stream);
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings() ?? {};
    this.currentDeviceId = settings.deviceId ?? opts.deviceId ?? null;
    // Desktop webcams usually report no facingMode; treat them as user-facing (mirror).
    this.currentFacing = (settings.facingMode as FacingMode | undefined) ?? opts.facingMode ?? 'user';
    track?.addEventListener('ended', this.onEndedHandler);

    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (err) {
      // Autoplay rejections are rare here (muted + user gesture) but must not leak the camera.
      this.stop();
      throw new CameraError('unknown', 'The camera stream could not be played.', err);
    }
    superseded(null);
    await waitForDimensions(this.video);
    superseded(null);
  }

  /** Cycles to the next camera (by deviceId when known, otherwise by flipping facingMode). */
  async switchCamera(): Promise<void> {
    const cams = await this.listCameras();
    if (cams.length > 1 && this.currentDeviceId) {
      const i = cams.findIndex((c) => c.deviceId === this.currentDeviceId);
      const next = cams[(i + 1) % cams.length];
      await this.start({ deviceId: next.deviceId });
    } else {
      await this.start({ facingMode: this.currentFacing === 'user' ? 'environment' : 'user' });
    }
  }

  stop(): void {
    this.gen++;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.removeEventListener('ended', this.onEndedHandler);
        track.stop();
      }
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
  }

  private handleTrackEnded(): void {
    this.stop();
    this.onInterrupted?.(new CameraError('interrupted', 'The camera stopped unexpectedly.'));
  }
}

function classify(err: unknown): CameraError {
  const name = (err as DOMException)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('permission-denied', 'Camera permission was denied.', err);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('no-camera', 'No camera was found on this device.', err);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('camera-busy', 'The camera is in use by another application.', err);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError('constraints', 'No camera matches the requested settings.', err);
    default:
      return new CameraError('unknown', 'The camera could not be started.', err);
  }
}

function waitForDimensions(video: HTMLVideoElement, timeoutMs = 4000): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new CameraError('unknown', 'The camera did not deliver any frames.'));
    }, timeoutMs);
    const onMeta = () => {
      if (video.videoWidth > 0) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(t);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('resize', onMeta);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('resize', onMeta);
  });
}
