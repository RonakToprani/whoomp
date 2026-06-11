const MIN_BEATS_FOR_HRV = 5;

export function filterRr(rrMs: Iterable<number>): number[] {
  const arr = Array.from(rrMs ?? []);
  if (arr.length === 0) return [];
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    const r = arr[i];
    const prev = out[out.length - 1];
    if (Math.abs(r - prev) / Math.max(prev, 1) <= 0.2) {
      out.push(r);
    }
  }
  return out;
}

export function rmssd(rrMs: Iterable<number>): number | null {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  let sumSq = 0;
  const n = rr.length - 1;
  for (let i = 0; i < n; i++) {
    const d = rr[i + 1] - rr[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

export function sdnn(rrMs: Iterable<number>): number | null {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  const n = rr.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rr[i];
  const mean = sum / n;
  let sqAcc = 0;
  for (let i = 0; i < n; i++) {
    const dev = rr[i] - mean;
    sqAcc += dev * dev;
  }
  return Math.sqrt(sqAcc / n);
}

export function pnn50(rrMs: Iterable<number>): number | null {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  const n = rr.length - 1;
  let over = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(rr[i + 1] - rr[i]) > 50) over++;
  }
  return (100.0 * over) / n;
}
