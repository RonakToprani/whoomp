// Design tokens — one source of truth for the WHOOP-style dark UI. Every screen/component reads
// from here so the look stays cohesive.

export const colors = {
  bg: '#000000',
  surface: '#121317',
  surfaceAlt: '#1a1c22',
  border: '#24272e',
  borderFaint: '#1b1e24',

  text: '#ffffff',
  textDim: '#9aa0a6',
  textFaint: '#5b606a',
  textGhost: '#3a3e45',

  // Recovery band (WHOOP scheme)
  green: '#16d885',
  yellow: '#f5c518',
  red: '#ff5a5f',

  // Strain (WHOOP cyan-blue)
  strain: '#00a3e0',

  // Accent for recovery-adjacent metrics
  violet: '#a78bfa',
} as const;

// Per-metric accent colors — one distinct hue per metric so every card, value, and sparkline reads
// at a glance (the dashboard was mostly white text before). Tuned to sit on the #000 background.
export const metricColors = {
  recovery:  '#16d885', // green
  strain:    '#00a3e0', // cyan
  sleep:     '#7c83ff', // indigo
  hrv:       '#a78bfa', // violet
  rhr:       '#ff5a7a', // rose
  resp:      '#2dd4bf', // teal
  skinTemp:  '#fbbf24', // amber
  spo2:      '#38bdf8', // sky
  steps:     '#60a5fa', // blue
  calories:  '#fb923c', // orange
  hr:        '#f87171', // live HR red
} as const;
export type MetricKey = keyof typeof metricColors;

// Add an alpha suffix to a #rrggbb hex (0..1) for fills/bands. e.g. withAlpha(green, 0.12).
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `${hex}${a}`;
}

// HR zones (Z1→Z5) + a "Rest" band below Z1.
export const restColor = '#3f8cff';
export const zoneColors = ['#60a5fa', '#34d399', '#fbbf24', '#f97316', '#ef4444'] as const;
export const zoneNames = ['Recovery', 'Aerobic', 'Tempo', 'Threshold', 'Max'] as const;

// Sleep stages
export const stageColors: Record<string, string> = {
  deep: '#6d6af5',
  rem: '#34d399',
  light: '#5b9bf5',
  wake: '#f87171',
};
export const stageLabels: Record<string, string> = { deep: 'DEEP', rem: 'REM', light: 'LIGHT', wake: 'WAKE' };

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radii = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;

export function recoveryColor(score: number | null | undefined): string {
  if (score == null) return colors.textGhost;
  if (score >= 67) return colors.green;
  if (score >= 34) return colors.yellow;
  return colors.red;
}

// Deviation arrow color: positive = better (green), negative = worse (red), neutral = dim.
export function deviationColor(z: number | null | undefined): string {
  if (z == null) return colors.textFaint;
  if (z > 0.5) return colors.green;
  if (z < -0.5) return colors.red;
  return colors.textDim;
}

// One-word recovery descriptor matching the WHOOP band (color comes from recoveryColor()).
export function recoveryLabel(score: number | null | undefined): string {
  if (score == null) return '—';
  if (score >= 67) return 'Primed';
  if (score >= 34) return 'Adequate';
  return 'Low';
}

// Sleep-performance color (asleep / needed). Green ≥85%, yellow ≥70%, else red.
export function sleepPerfColor(pct: number | null | undefined): string {
  if (pct == null) return colors.textGhost;
  if (pct >= 85) return colors.green;
  if (pct >= 70) return colors.yellow;
  return colors.red;
}
