// User profile — drives age-dependent physiology (Tanaka HRmax), Keytel calories, and the
// Banister TRIMP coefficient. All values are USER INPUT (entered in Settings) and persisted in
// AsyncStorage; nothing personal is baked in. Until a field is set it is null/empty, and the
// calculations fall back to neutral, non-personal defaults (see NEUTRAL_AGE / the Keytel 70 kg
// default). Age auto-derives from the entered DOB.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Sex = 'M' | 'F' | null;

export interface UserProfile {
  dob: string; // YYYY-MM-DD, '' until entered
  age: number; // derived from dob, else NEUTRAL_AGE
  sex: Sex; // null until entered
  weightKg: number | null; // null until entered
  heightCm: number | null; // null until entered
  /** True once the user has entered enough to personalize calories/zones (DOB + weight + sex). */
  complete: boolean;
}

const KEYS = {
  dob: '@whoomp/dob',
  sex: '@whoomp/sex',
  weight: '@whoomp/weightKg',
  height: '@whoomp/heightCm',
  age: '@whoomp/age', // legacy; only used if dob is missing
} as const;

/** Neutral age used only for HRmax when the user hasn't entered a DOB yet. */
export const NEUTRAL_AGE = 30;

export function ageFromDob(dob: string): number | null {
  if (!dob) return null;
  const b = new Date(dob);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  const mo = now.getMonth() - b.getMonth();
  if (mo < 0 || (mo === 0 && now.getDate() < b.getDate())) a--;
  return a > 0 && a < 120 ? a : null;
}

export async function getProfile(): Promise<UserProfile> {
  let dob = '';
  let sex: Sex = null;
  let weightKg: number | null = null;
  let heightCm: number | null = null;
  let legacyAge: number | null = null;
  try {
    const [d, s, w, h, a] = await Promise.all([
      AsyncStorage.getItem(KEYS.dob), AsyncStorage.getItem(KEYS.sex),
      AsyncStorage.getItem(KEYS.weight), AsyncStorage.getItem(KEYS.height),
      AsyncStorage.getItem(KEYS.age),
    ]);
    if (d) dob = d;
    if (s === 'M' || s === 'F') sex = s;
    if (w != null && Number.isFinite(parseFloat(w))) weightKg = parseFloat(w);
    if (h != null && Number.isFinite(parseFloat(h))) heightCm = parseFloat(h);
    if (a != null && Number.isFinite(parseInt(a, 10))) legacyAge = parseInt(a, 10);
  } catch {
    // fall through to neutral defaults
  }
  const age = ageFromDob(dob) ?? legacyAge ?? NEUTRAL_AGE;
  const complete = ageFromDob(dob) != null && weightKg != null && sex != null;
  return { dob, age, sex, weightKg, heightCm, complete };
}

export async function setProfile(p: Partial<Pick<UserProfile, 'dob' | 'sex' | 'weightKg' | 'heightCm'>>): Promise<void> {
  const writes: Promise<void>[] = [];
  if (p.dob !== undefined) writes.push(AsyncStorage.setItem(KEYS.dob, p.dob));
  if (p.sex !== undefined) writes.push(AsyncStorage.setItem(KEYS.sex, p.sex ?? ''));
  if (p.weightKg !== undefined) writes.push(AsyncStorage.setItem(KEYS.weight, String(p.weightKg ?? '')));
  if (p.heightCm !== undefined) writes.push(AsyncStorage.setItem(KEYS.height, String(p.heightCm ?? '')));
  await Promise.all(writes);
}
