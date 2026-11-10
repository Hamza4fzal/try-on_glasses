// Vendors MediaPipe runtime assets so the app is fully self-hosted:
//   public/mediapipe/wasm/*            <- copied from node_modules/@mediapipe/tasks-vision/wasm
//   public/mediapipe/face_landmarker.task <- downloaded once from Google's public model bucket
// At runtime the browser never contacts a third-party server.
//
// Usage: npm run vendor   (idempotent; pass --force to re-download)

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'mediapipe');
const force = process.argv.includes('--force');

// Pinned model version (float16 v1). Bumping this is a deliberate change.
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  await cp(wasmSrc, join(outDir, 'wasm'), { recursive: true });
  console.log('✓ copied MediaPipe wasm runtime');

  const modelPath = join(outDir, 'face_landmarker.task');
  if (force || !(await exists(modelPath))) {
    console.log('… downloading face_landmarker.task');
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(modelPath, buf);
  }
  const model = await readFile(modelPath);
  const sha = createHash('sha256').update(model).digest('hex');
  if (sha !== MODEL_SHA256) {
    throw new Error(`face_landmarker.task integrity check failed: got ${sha}, expected ${MODEL_SHA256}`);
  }
  console.log(`✓ face_landmarker.task ${(model.length / 1e6).toFixed(2)} MB (sha256 verified)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
