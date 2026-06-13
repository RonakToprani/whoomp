// Sleep-need model — how much sleep the body needs tonight, broken into the same components WHOOP
// shows: a baseline need + accumulated recent sleep debt + extra need from recent strain. Kept
// deliberately simple and NON-circular: debt is measured against the fixed baseline (not against a
// recursively-defined "need"), so a chronically short night never spirals the number.

export interface SleepNeed {
  needMin: number;     // total recommended sleep (minutes)
  baselineMin: number; // baseline need
  debtMin: number;     // added to repay accumulated recent deficit
  strainMin: number;   // added for recent day strain
}

const DEFAULT_BASELINE_MIN = 480; // 8h — typical adult baseline
const BASELINE_FLOOR = 360;       // clamp personalization to 6–10h
const BASELINE_CEIL = 600;
const MAX_DEBT_MIN = 120;         // repaid debt caps at 2h
const DEBT_REPAY_FRACTION = 0.5;  // repay half the recent deficit each night
const MAX_STRAIN_MIN = 45;        // up to +45 min on a maximal-strain day
const STRAIN_SCALE = 21;          // strain runs 0..21

export function sleepNeed(opts: {
  baselineMin?: number | null;     // habitual baseline; defaults to 480 (clamped 6–10h)
  recentAsleepMin?: number[];      // prior nights' asleep totals → debt vs baseline
  dayStrain?: number | null;       // today's strain 0..21 → extra need
}): SleepNeed {
  const baselineMin = Math.round(
    opts.baselineMin != null && opts.baselineMin > 0
      ? Math.min(BASELINE_CEIL, Math.max(BASELINE_FLOOR, opts.baselineMin))
      : DEFAULT_BASELINE_MIN,
  );
  const deficitSum = (opts.recentAsleepMin ?? []).reduce((a, m) => a + Math.max(0, baselineMin - m), 0);
  const debtMin = Math.round(Math.min(MAX_DEBT_MIN, deficitSum * DEBT_REPAY_FRACTION));
  const strain = opts.dayStrain != null ? Math.max(0, Math.min(STRAIN_SCALE, opts.dayStrain)) : 0;
  const strainMin = Math.round((strain / STRAIN_SCALE) * MAX_STRAIN_MIN);
  return { needMin: baselineMin + debtMin + strainMin, baselineMin, debtMin, strainMin };
}

// Sleep performance = asleep / need, as a percentage. Caller clamps for display (caps at 100%).
export function sleepPerformance(asleepMin: number | null | undefined, needMin: number | null | undefined): number | null {
  if (asleepMin == null || needMin == null || needMin <= 0) return null;
  return (asleepMin / needMin) * 100;
}
