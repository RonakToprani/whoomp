import { describe, it, expect } from 'vitest';
import { skinTempC, cToF, meanSkinTempC } from '../skinTemp';

describe('skinTempC (AS6221 raw/128 °C)', () => {
  it('decodes a typical wrist temp (raw 4339 ≈ 33.9 °C ≈ 93.0 °F)', () => {
    const c = skinTempC(4339)!;
    expect(c).toBeCloseTo(33.9, 1);
    expect(cToF(c)!).toBeCloseTo(93.0, 0);
  });

  it('rejects implausible readings (unseated sensor / garbage register)', () => {
    expect(skinTempC(100)).toBeNull();    // 0.78 °C
    expect(skinTempC(10000)).toBeNull();  // 78 °C
    expect(skinTempC(null)).toBeNull();
    expect(skinTempC(NaN)).toBeNull();
  });

  it('meanSkinTempC averages only the plausible readings', () => {
    // 4339/128=33.9, 4352/128=34.0 valid; null + 100 (0.78°C) ignored.
    expect(meanSkinTempC([4339, 4352, null, 100])!).toBeCloseTo((4339 + 4352) / 2 / 128, 5);
    expect(meanSkinTempC([null, 100, 99999])).toBeNull();
  });

  it('cToF(null) is null', () => {
    expect(cToF(null)).toBeNull();
  });
});
