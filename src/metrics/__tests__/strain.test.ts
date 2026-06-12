import { describe, it, expect } from 'vitest';
import { tanakaHRmax, defaultMaxHR, trimpToStrain, strainScore, estimateHRmax, fitStrainDenominator } from '../strain';

// 1 Hz HR series at a constant bpm.
const hr = (bpm: number, n: number): number[] => new Array(n).fill(bpm);

// Parity vectors from NOOP StrainScorerTests (Karvonen/Edwards/Banister + Tanaka).
describe('strain parity', () => {
  it('Tanaka + classic max', () => {
    expect(tanakaHRmax(30)).toBeCloseTo(187, 9);
    expect(defaultMaxHR(30)).toBe(190);
    expect(tanakaHRmax(24)).toBeCloseTo(191.2, 9); // owner's profile
  });

  it('TRIMP→strain ceiling maps to 21 with D=7201', () => {
    expect(trimpToStrain(7200)).toBeCloseTo(21, 9);
  });

  it('TRIMP→strain known values', () => {
    expect(trimpToStrain(0)).toBeCloseTo(0, 9);
    expect(trimpToStrain(-5)).toBeCloseTo(0, 9);
    expect(trimpToStrain(100)).toBeCloseTo(10.91, 9);
  });

  it('Edwards zone-5 golden: 600 samples @ ~96%HRR → ~9.3', () => {
    const s = strainScore(hr(185, 600), { maxHR: 190, restingHR: 60 });
    expect(s!).toBeCloseTo(9.3, 2);
  });

  it('null when too few readings or invalid HRR', () => {
    expect(strainScore(hr(150, 599), { maxHR: 190, restingHR: 60 })).toBeNull();
    expect(strainScore(hr(150, 600), { maxHR: 60, restingHR: 60 })).toBeNull();
    expect(strainScore(hr(150, 600), { maxHR: 50, restingHR: 60 })).toBeNull();
  });

  it('monotonic in zone time and intensity', () => {
    const short = strainScore(hr(185, 600), { maxHR: 190, restingHR: 60 })!;
    const long = strainScore(hr(185, 1200), { maxHR: 190, restingHR: 60 })!;
    expect(long).toBeGreaterThan(short);
    const z3 = strainScore(hr(155, 600), { maxHR: 190, restingHR: 60 })!;
    const z5 = strainScore(hr(185, 600), { maxHR: 190, restingHR: 60 })!;
    expect(z5).toBeGreaterThan(z3);
  });

  it('Banister method bounded (0, 21]', () => {
    const s = strainScore(hr(185, 600), { maxHR: 190, restingHR: 60, method: 'banister' })!;
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(21);
  });

  it('estimateHRmax: tanaka / unknown / observed', () => {
    const a = estimateHRmax([150, 160, 170], 30);
    expect(a.hrmax).toBeCloseTo(187, 9);
    expect(a.source).toBe('tanaka');

    const b = estimateHRmax([150], null);
    expect(b.hrmax).toBe(0);
    expect(b.source).toBe('unknown');

    const hist = [...new Array(690).fill(120), ...new Array(10).fill(195)];
    const c = estimateHRmax(hist, 30);
    expect(c.source).toBe('observed');
    expect(c.hrmax).toBeGreaterThan(187);
  });

  it('fitStrainDenominator recovers a known D; too few pairs → null', () => {
    const knownD = 5000;
    const strainFor = (t: number) => (21 * Math.log(t + 1)) / Math.log(knownD);
    const fitted = fitStrainDenominator([
      { trimp: 100, strain: strainFor(100) },
      { trimp: 1000, strain: strainFor(1000) },
      { trimp: 50, strain: strainFor(50) },
    ]);
    expect(fitted!).toBeCloseTo(knownD, 0);
    expect(fitStrainDenominator([{ trimp: 100, strain: 10 }])).toBeNull();
  });
});
