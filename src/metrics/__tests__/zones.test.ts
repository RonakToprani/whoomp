import { describe, it, expect } from 'vitest';
import { maxHr, zoneForHr, zoneSecondsFromHrSeries, caloriesPerMinute, caloriesFromHrSeries } from '../zones';

describe('zones + calories', () => {
  it('maxHr uses Tanaka (208 − 0.7·age) with overrides', () => {
    expect(maxHr(24)).toBe(191); // 208 − 16.8 = 191.2 → 191
    expect(maxHr(30)).toBe(187);
    expect(maxHr(30, 195)).toBe(195); // explicit override wins
    expect(maxHr(200)).toBe(120); // floored
  });

  it('zoneForHr maps %max to Z1–Z5; below 50% is no zone (Rest)', () => {
    const m = 190;
    expect(zoneForHr(94, m)).toBeNull(); // 0.49 → below Z1
    expect(zoneForHr(95, m)).toBe(1); // 0.50 inclusive
    expect(zoneForHr(114, m)).toBe(2); // 0.60
    expect(zoneForHr(133, m)).toBe(3); // 0.70
    expect(zoneForHr(152, m)).toBe(4); // 0.80
    expect(zoneForHr(180, m)).toBe(5); // 0.947
    expect(zoneForHr(null, m)).toBeNull();
  });

  it('zoneSecondsFromHrSeries buckets seconds per zone', () => {
    const counts = zoneSecondsFromHrSeries([95, 95, 114, 180, 50], 190);
    expect(counts[0]).toBe(2); // two Z1
    expect(counts[1]).toBe(1); // one Z2
    expect(counts[4]).toBe(1); // one Z5
    // the 50 bpm sample is Rest → counted in no zone
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('calories: Keytel positive while active, zero below floor', () => {
    expect(caloriesPerMinute(150, 30, 70, 'M')).toBeGreaterThan(0);
    expect(caloriesPerMinute(20, 30, 70, 'M')).toBe(0); // below HR floor
    const total = caloriesFromHrSeries(new Array(600).fill(150), 30, 70, 'M');
    expect(total).toBeGreaterThan(0);
    // a male at a given HR/weight burns more than the sex-neutral average
    expect(caloriesPerMinute(150, 30, 70, 'M')).toBeGreaterThan(caloriesPerMinute(150, 30, 70, 'F'));
  });
});
