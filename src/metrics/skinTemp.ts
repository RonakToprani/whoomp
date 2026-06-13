// Skin temperature from the WHOOP 4.0's AS6221 digital sensor (named in the strap's firmware console
// logs). The historical V24 frame carries the raw u16 register at data offset 65; the AS6221 encodes
// temperature as °C × 128 (7.8125 m°C / LSB). Verified against NOOP's Interpreter (raw / 128.0, gated
// to a plausible 5–45 °C so an unseated sensor / garbage register doesn't poison the nightly mean).

const MIN_C = 5;
const MAX_C = 45;

export function skinTempC(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const c = raw / 128;
  return c >= MIN_C && c <= MAX_C ? c : null;
}

export function cToF(c: number | null | undefined): number | null {
  return c == null ? null : (c * 9) / 5 + 32;
}

// Mean skin temp (°C) over a set of raw ADC readings, ignoring implausible ones. null if none valid.
export function meanSkinTempC(raws: Array<number | null | undefined>): number | null {
  let sum = 0, n = 0;
  for (const r of raws) {
    const c = skinTempC(r);
    if (c != null) { sum += c; n += 1; }
  }
  return n > 0 ? sum / n : null;
}
