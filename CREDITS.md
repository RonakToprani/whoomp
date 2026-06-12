# Credits & Attribution

whoomp's v3 analytics engine reimplements published exercise-physiology and HRV methods in
TypeScript. The algorithms are grounded in the peer-reviewed literature below; the structure and
constants were cross-checked against the **NOOP** project, and whoomp's parity tests
(`src/metrics/__tests__/`) assert numerical agreement with NOOP's validated golden vectors.

## Reference implementation

- **NOOP** — <https://github.com/NoopApp/noop> — an offline WHOOP companion whose tested,
  calibrated on-device analytics (HRV, baselines, recovery, strain, sleep staging) and WHOOP 4.0
  protocol schema were used as a structural reference and correctness oracle.
  NOOP is licensed **PolyForm Noncommercial 1.0.0**. whoomp's metrics are an independent
  TypeScript reimplementation from the published methods (not a transliteration); whoomp is a
  personal, **non-commercial** project. If whoomp is ever distributed commercially, this code is
  already clean-room from the literature, but NOOP's noncommercial terms should be respected for
  any directly-derived material.

Protocol cross-checks: `madhursatija/whoof`, `cs-balazs/gowhoop`, `bWanShiTong/openwhoop`.

## Methods

- **HRV (RMSSD, SDNN, pNN50)** — Task Force of ESC/NASPE (1996). Ectopic rejection: Malik et al. (1989).
- **Strain / TRIMP** — Karvonen %HRR (Karvonen 1957); Edwards 5-zone TRIMP (Edwards 1993);
  Banister exponential TRIMP (Banister 1991).
- **Max HR** — Tanaka, Monahan & Seals (2001), HRmax = 208 − 0.7·age.
- **Recovery** — z-score + logistic composite over personal baselines (HRV-dominant). WHOOP-*like*,
  not the proprietary WHOOP algorithm.
- **Baselines** — Winsorized EWMA with EWMA-abs-dev spread; robust z via MAD→σ (1.253) conversion.
- **Sleep/wake** — Cole–Kripke (1992), 30 s formulation per te Lindert & Van Someren (2013/2018).
  HR-variability feature: difference-of-Gaussians per Walch et al. (2019). Calories: Keytel et al. (2005).

## Honest limitations

Recovery, strain, and sleep stages are **approximations**, not medical devices and not the WHOOP
algorithms. EEG-free 4-class sleep staging tops out around 65–73% epoch agreement. Raw SpO₂ / skin-
temp / respiration ADCs are converted approximately on-device (WHOOP does this in the cloud).
