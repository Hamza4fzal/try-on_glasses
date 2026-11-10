/**
 * Allocation-free replacements for Math.hypot. V8 does not inline Math.hypot (it is variadic),
 * and its result is boxed as a heap number on every call — measurable garbage in per-frame code.
 */
export function len2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}
