import { describe, it, expect } from 'vitest';
import { sleepNeed, sleepPerformance } from '../sleepNeed';

describe('sleepNeed', () => {
  it('defaults to an 8h baseline with no debt or strain', () => {
    const n = sleepNeed({});
    expect(n).toEqual({ needMin: 480, baselineMin: 480, debtMin: 0, strainMin: 0 });
  });

  it('adds repaid debt (half the recent deficit vs baseline)', () => {
    // deficits vs 480: (480-360)+(480-420) = 120+60 = 180; repay half = 90.
    const n = sleepNeed({ recentAsleepMin: [360, 420] });
    expect(n.debtMin).toBe(90);
    expect(n.needMin).toBe(570);
  });

  it('caps repaid debt at 2h', () => {
    const n = sleepNeed({ recentAsleepMin: [60, 60, 60] }); // huge deficit
    expect(n.debtMin).toBe(120);
  });

  it('adds strain need proportional to day strain (max +45m at strain 21)', () => {
    expect(sleepNeed({ dayStrain: 21 }).strainMin).toBe(45);
    expect(sleepNeed({ dayStrain: 10.5 }).strainMin).toBe(23); // round(0.5*45)
    expect(sleepNeed({ dayStrain: 0 }).strainMin).toBe(0);
  });

  it('clamps an out-of-range personalized baseline to 6–10h', () => {
    expect(sleepNeed({ baselineMin: 1000 }).baselineMin).toBe(600);
    expect(sleepNeed({ baselineMin: 60 }).baselineMin).toBe(360);
  });

  it('sleepPerformance is asleep / need %', () => {
    expect(sleepPerformance(420, 480)!).toBeCloseTo(87.5, 1);
    expect(sleepPerformance(null, 480)).toBeNull();
    expect(sleepPerformance(420, 0)).toBeNull();
  });
});
