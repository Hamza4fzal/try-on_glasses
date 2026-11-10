import type { EngineErrorCode } from '../app/try-on-engine';
import type { GuidanceHint } from '../app/guidance';

/**
 * Every customer-facing text in one place (overridable per store / translated by the WordPress
 * plugin later). `{name}` is replaced with the product name.
 */
export const DEFAULT_STRINGS = {
  eyebrow: 'Virtual try-on',
  close: 'Close virtual try-on',

  introTitle: 'See {name} on you',
  introLive: 'Live 3D try-on with your camera, true to size.',
  introPrivate: 'Private: your camera feed is processed only on this device. Nothing is recorded, uploaded or saved.',
  introTips: 'For the best fit: face the camera in good light and take off your own glasses.',
  start: 'Start camera',
  permissionNote: 'Your browser will ask for permission to use the camera.',

  waitingTitle: 'Allow camera access',
  waitingBody: 'Choose “Allow” in your browser’s prompt to start the try-on.',
  cancel: 'Cancel',

  loading: 'Preparing your try-on…',
  loadingFrame: 'Loading {name}…',

  colour: 'Colour',
  moreFrames: 'More frames',
  takePhoto: 'Take a photo',
  privacyBadge: 'Private · stays on this device',

  photoTitle: 'Your try-on photo',
  photoNote: 'This photo is only on your device until you save or share it.',
  download: 'Save photo',
  share: 'Share',
  retake: 'Back to try-on',
  photoFailed: 'The photo could not be taken. Please try again.',
  frameFailed: 'That frame could not be loaded.',

  pausedTitle: 'Camera paused',
  pausedBody: 'We turned your camera off while this page was in the background.',
  resume: 'Resume try-on',

  retry: 'Try again',
  closeButton: 'Close',

  hints: {
    'no-face': 'Look at the screen so we can find your face',
    'move-closer': 'Move a little closer',
    'move-back': 'Move back a little',
    center: 'Center your face in the frame',
    'low-light': 'It’s quite dark — face a light for a better look',
    'face-camera': 'Turn towards the camera',
  } satisfies Record<Exclude<GuidanceHint, null>, string>,

  errors: {
    'insecure-context': {
      title: 'Secure connection needed',
      body: 'Browsers only allow the camera on secure (https://) pages. Please let the store know.',
    },
    unsupported: {
      title: 'Camera not available here',
      body: 'This browser can’t share the camera with web pages. Try the latest Chrome, Safari, Edge or Firefox. If you opened this link inside an app, open it in your browser instead.',
    },
    'permission-denied': {
      title: 'Camera access is blocked',
      body: 'The try-on needs your camera, and it never leaves your device.',
    },
    'no-camera': {
      title: 'No camera found',
      body: 'Connect a camera and try again, or open this page on your phone.',
    },
    'camera-busy': {
      title: 'Your camera is busy',
      body: 'Another app or browser tab is using the camera. Close it, then try again.',
    },
    constraints: {
      title: 'Camera couldn’t start',
      body: 'Your camera didn’t accept the video settings. Please try again.',
    },
    interrupted: {
      title: 'The camera stopped',
      body: 'It was disconnected or taken over by another app.',
    },
    'webgl-unavailable': {
      title: '3D graphics are turned off',
      body: 'The try-on needs WebGL 2. Turn on hardware acceleration in your browser settings, or try another browser.',
    },
    'tracking-load-failed': {
      title: 'Couldn’t load face tracking',
      body: 'Please check your internet connection and try again.',
    },
    'model-load-failed': {
      title: 'Couldn’t load this frame',
      body: 'Please check your internet connection and try again.',
    },
    'context-lost': {
      title: 'Graphics were reset',
      body: 'Your browser reset its 3D graphics (this can happen when memory runs low).',
    },
    unknown: {
      title: 'Something went wrong',
      body: 'The try-on couldn’t start. Please try again.',
    },
  } satisfies Record<EngineErrorCode | 'context-lost', { title: string; body: string }>,

  /** How to unblock the camera, by platform. */
  permissionHelp: {
    ios: 'On iPhone or iPad: tap “aA” in the address bar → Website Settings → Camera → Allow. Or open Settings → Apps → Safari → Camera.',
    android: 'Tap the icon left of the address bar → Permissions → Camera → Allow.',
    firefox: 'Click the crossed-out camera icon in the address bar and remove the block.',
    safari: 'In the menu bar choose Safari → Settings for This Website… → Camera → Allow.',
    chromium: 'Click the camera icon in the address bar, choose “Always allow”, then try again.',
    generic: 'Allow camera access for this site in your browser settings, then try again.',
  },
};

export type Strings = typeof DEFAULT_STRINGS;
export type ErrorKey = keyof Strings['errors'];

export function permissionHelpKey(): keyof Strings['permissionHelp'] {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (iOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'safari';
  if (/Chrome|Chromium|Edg\//.test(ua)) return 'chromium';
  return 'generic';
}

/** Deep-merges partial overrides (e.g. translations) over the defaults. */
export function mergeStrings(over?: DeepPartial<Strings>): Strings {
  const out = structuredClone(DEFAULT_STRINGS) as Strings;
  const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && dst[k] && typeof dst[k] === 'object') merge(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
      else if (typeof v === 'string' && k in dst) dst[k] = v;
    }
  };
  if (over) merge(out as unknown as Record<string, unknown>, over as Record<string, unknown>);
  return out;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const fill = (s: string, name: string) => s.replaceAll('{name}', name);
