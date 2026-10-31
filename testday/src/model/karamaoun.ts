import { FIG2 } from './data/karamaoun2022Fig2'
import { FRC_SPLINES } from './data/gli2021Frc'
import { karamaounThresholdLMin } from './airway'

/**
 * The athlete's own Figure 2 of Karamaoun et al. 2022, live.
 *
 * Karamaoun C, Haut B, Blain G, et al. J Appl Physiol 2022;132:1031-1040,
 * doi:10.1152/japplphysiol.00520.2021. Figure 2 plots the evaporation flux per
 * unit airway surface (10⁻³ µL mm⁻² s⁻¹, i.e. µm/s of surface liquid) for
 * generations 1 (trachea) to 17, at FRC 3 and 3.5 L, VE 75 to 115 L/min, in
 * 19 °C / 55 % air, against the gland-replenishment band 0.32 to 0.35.
 *
 * Port of `R/karamaoun_fig2.R` in the ventilation project, where the method,
 * the tests against the paper and the caveats live:
 *
 * - The digitised figure is interpolated linearly in VE and FRC and
 *   extrapolated linearly outside 75–115 L/min and 3–3.5 L, flagged when it is.
 * - It is moved to the room's air by the per-generation ratio of the Haut 2021
 *   complete model's flux in that air to its flux in 19 °C / 55 %
 *   ("Haut-shifted"). In colder air that LOWERS the proximal flux and raises
 *   the distal, so this threshold RISES in the cold.
 * - The water-deficit threshold (the older tile's method, scaled from the
 *   athlete's own 19 °C / 55 % threshold) FALLS in the cold. Both are shown
 *   (RMH 2026-10-31).
 *
 * The band is gland physiology (a maximal secretion rate and a bovine gland
 * density), not an injury threshold, and cc16 was measured in room air only.
 *
 * Pure.
 */

export const BAND = { low: 0.32, high: 0.35 } as const
export const GENERATIONS = 17

// --- GLI 2021 FRC ------------------------------------------------------------

/** 1 male, 2 female. */
export type Sex = 1 | 2

/**
 * Predicted FRC, L: GLI 2021 static volumes (Hall et al., Eur Respir J
 * 2021;57:2000289, Table 3 and the supplement's splines). Height cm, age 5–80.
 */
export function gliFrcL(sex: Sex, ageY: number, heightCm: number): number {
  const t = FRC_SPLINES[sex]
  if (!(ageY >= t.age[0] && ageY <= t.age[t.age.length - 1])) return NaN
  const msp = interp(t.age, t.m, ageY)
  const [a0, aAge, aH] = sex === 1 ? [-13.4898, 0.1111, 2.7634] : [-12.7674, 0.1251, 2.6049]
  return Math.exp(a0 + aAge * Math.log(ageY) + aH * Math.log(heightCm) + msp)
}

// --- Haut 2021 complete model, paper upper airway, mouth breathing ------------

const K = {
  D: 2.7e-5,
  nu: 1.7e-5,
  lambdaAir: 0.027,
  Lm: 43470,
  R: 8.314,
  rhoW: 993,
  cpW: 4180,
  lambdaW: 0.62,
  Sc: 0.63,
  Pr: 0.72,
  Tb: 37 + 273.15,
  pSatTb: 6283,
  Mw: 0.018,
}
/** Haut 2021 Table 2, cm, generations 1 to 17, scaled to FRC 3 L. */
const TABLE2_L = [11.19, 4.44, 1.77, 0.71, 1.17, 0.99, 0.84, 0.71, 0.6, 0.5, 0.43, 0.35, 0.3, 0.24, 0.19, 0.19, 0.15]
const TABLE2_R = [0.71, 0.48, 0.33, 0.22, 0.18, 0.14, 0.11, 0.09, 0.07, 0.06, 0.05, 0.04, 0.04, 0.03, 0.03, 0.03, 0.02]

const cSat = (tK: number) => (K.pSatTb * Math.exp((K.Lm / K.R) * (1 / K.Tb - 1 / tK))) / (K.R * tK)
const shNu = (re: number, beta: number, x: number) =>
  re / beta >= 1 ? 1.5 + 0.4 * Math.sqrt((re * x) / beta) : Math.max(0.05, (1.5 * re) / beta)

/** Blood-renewal time of the airway wall from VE, as `haut_t_w_from_ve()`. */
export function wallRenewalS(veLMin: number): number {
  const ve = [7.5, 15, 30, 60, 120]
  const tw = [2000, 1000, 900, 800, 700]
  const v = Math.min(Math.max(veLMin, ve[0]), ve[ve.length - 1])
  return interp(ve.map(Math.log), tw, Math.log(v))
}

/** Karamaoun 2022 Table 2 breathing pattern: te/ti from VE. */
export function expInspRatio(veLMin: number): number {
  const titot = interp([75, 80, 85, 100, 115], [0.46, 0.46, 0.47, 0.48, 0.49], veLMin)
  return (1 - titot) / titot
}

/**
 * Evaporation flux per lung generation, Fig 2 units, from the Haut 2021
 * complete model on an FRC-scaled tree (`haut_condition()` with mouth = TRUE,
 * urt = "paper"). Null if the solver is given nonsense.
 */
export function hautFlux(frcL: number, veLMin: number, tempC: number, rhPct: number, sex: Sex = 1): number[] | null {
  if (![frcL, veLMin, tempC, rhPct].every(Number.isFinite) || veLMin <= 0 || frcL <= 0) return null
  const gamma = expInspRatio(veLMin)
  const tW = wallRenewalS(veLMin)
  const s = Math.cbrt(frcL / 3)
  const sR = s * (sex === 2 ? 0.86 : 1)
  // pharynx, larynx, then the lungs
  const Lm = [0.02 * s, 0.03 * s, ...TABLE2_L.map((l) => (l / 100) * s)]
  const Rm = [0.01 * sR, 0.01 * sR, ...TABLE2_R.map((r) => (r / 100) * sR)]
  const nAir = [1, 1, ...TABLE2_L.map((_, i) => 2 ** i)]
  const n = Lm.length

  const T0 = tempC + 273.15
  const C0 = (rhPct / 100) * cSat(T0)
  const dT = K.Tb - T0
  const dC = cSat(K.Tb) - C0
  const Q = (veLMin * (1 + gamma)) / 1000 / 60
  const Qexp = Q / gamma
  const alphaW = K.lambdaW / (K.rhoW * K.cpW)

  const PsiI = new Array<number>(n), PsiE = new Array<number>(n)
  const PbI = new Array<number>(n), PbE = new Array<number>(n)
  const Lam = new Array<number>(n), Phi = new Array<number>(n)
  const rs = new Array<number>(n), rn = new Array<number>(n)
  for (let j = 0; j < n; j++) {
    const area = nAir[j] * Math.PI * Rm[j] ** 2
    const reI = (2 * Rm[j] * Q) / (K.nu * area)
    const reE = (2 * Rm[j] * Qexp) / (K.nu * area)
    const beta = Lm[j] / Rm[j]
    const shI = shNu(reI, beta, K.Sc), shE = shNu(reE, beta, K.Sc)
    const nuI = shNu(reI, beta, K.Pr), nuE = shNu(reE, beta, K.Pr)
    PsiI[j] = Math.exp((4 * beta * shI) / (reI * K.Sc))
    PsiE[j] = Math.exp((4 * beta * shE) / (reE * K.Sc))
    PbI[j] = Math.exp((4 * beta * nuI) / (reI * K.Pr))
    PbE[j] = Math.exp((4 * beta * nuE) / (reE * K.Pr))
    Lam[j] = (Rm[j] * K.lambdaW * dT) / (K.Lm * shI * K.D * dC * Math.sqrt(alphaW * tW))
    Phi[j] = (nuI * K.lambdaAir * dT) / (shI * K.D * K.Lm * dC)
    rs[j] = shE / shI
    rn[j] = nuE / nuI
  }
  const g1 = 1 / (1 + gamma)
  const g2 = gamma / (1 + gamma)
  const cMu = (t: number) => (cSat(t * dT + T0) - C0) / dC

  const Tmu = new Array<number>(n).fill(1)
  const Ci = new Array<number>(n).fill(0), Ti = new Array<number>(n).fill(0)
  const Ce = new Array<number>(n).fill(0), Te = new Array<number>(n).fill(0)
  for (let it = 0; it < 4000; it++) {
    let pc = 0, pt = 0
    for (let j = 0; j < n; j++) {
      const cm = cMu(Tmu[j])
      Ci[j] = (pc - cm) / PsiI[j] + cm
      Ti[j] = (pt - Tmu[j]) / PbI[j] + Tmu[j]
      pc = Ci[j]; pt = Ti[j]
    }
    let nc = 1, nt = 1
    for (let j = n - 1; j >= 0; j--) {
      const cm = cMu(Tmu[j])
      Ce[j] = (nc - cm) / PsiE[j] + cm
      Te[j] = (nt - Tmu[j]) / PbE[j] + Tmu[j]
      nc = Ce[j]; nt = Te[j]
    }
    let diff = 0
    for (let j = 0; j < n; j++) {
      const ciA = (Ci[j] + (j ? Ci[j - 1] : 0)) / 2
      const tiA = (Ti[j] + (j ? Ti[j - 1] : 0)) / 2
      const ceA = (Ce[j] + (j < n - 1 ? Ce[j + 1] : 1)) / 2
      const teA = (Te[j] + (j < n - 1 ? Te[j + 1] : 1)) / 2
      const f = (t: number) => {
        const cm = cMu(t)
        return (
          Lam[j] * (1 - t) -
          (g1 * (cm - ciA + Phi[j] * (t - tiA)) + g2 * (rs[j] * (cm - ceA) + Phi[j] * rn[j] * (t - teA)))
        )
      }
      let t = Tmu[j]
      let ok = false
      for (let k = 0; k < 12; k++) {
        const ft = f(t)
        const d = (f(t + 1e-6) - ft) / 1e-6
        if (!Number.isFinite(d) || d === 0) break
        const tn = t - ft / d
        if (tn < -3 || tn > 1) break
        if (Math.abs(tn - t) < 1e-10) { t = tn; ok = true; break }
        t = tn
      }
      if (!ok) {
        let lo = -3, hi = 1, flo = f(lo)
        const fhi = f(hi)
        if (flo * fhi > 0) t = Math.abs(fhi) < Math.abs(flo) ? 1 : lo
        else {
          for (let b = 0; b < 60; b++) {
            const mid = (lo + hi) / 2, fm = f(mid)
            if (flo * fm <= 0) hi = mid
            else { lo = mid; flo = fm }
          }
          t = (lo + hi) / 2
        }
      }
      diff = Math.max(diff, Math.abs(t - Tmu[j]))
      Tmu[j] = t
    }
    if (diff < 1e-7) break
  }
  const Qm = Q / (1 + gamma)
  const out: number[] = []
  for (let j = 2; j < n; j++) {
    const w = Qm * dC * (Ci[j] - Ci[j - 1] + Ce[j] - (j < n - 1 ? Ce[j + 1] : 1))
    const umMin = ((w / (nAir[j] * 2 * Math.PI * Rm[j] * Lm[j])) * (K.Mw / K.rhoW)) * 1e6 * 60
    out.push(umMin / 60)
  }
  return out
}

// --- Figure 2 ------------------------------------------------------------------

export interface Fig2Curve {
  /** Flux per generation 1..17, 10⁻³ µL mm⁻² s⁻¹. */
  karamaoun: number[]
  haut: number[] | null
  extrapolated: boolean
}

/** Figure 2 at any FRC and VE, in the paper's 19 °C / 55 %. */
export function fig2Reference(frcL: number, veLMin: number): number[] {
  const ves = [75, 80, 85, 100, 115]
  return Array.from({ length: GENERATIONS }, (_, g) => {
    const at = (key: '3' | '3.5') => linExtrap(ves, ves.map((v) => FIG2[key][v][g]), veLMin)
    return Math.max(0, linExtrap([3, 3.5], [at('3'), at('3.5')], frcL))
  })
}

/** Haut-shift ratios per generation, this air against 19 °C / 55 %. */
function shift(frcL: number, veLMin: number, tempC: number, rhPct: number, sex: Sex): { air: number[]; ratio: number[] } | null {
  const air = hautFlux(frcL, veLMin, tempC, rhPct, sex)
  const ref = hautFlux(frcL, veLMin, 19, 55, sex)
  if (!air || !ref) return null
  return { air, ratio: air.map((a, i) => (ref[i] > 0 ? a / ref[i] : 1)) }
}

export function fig2Curve(frcL: number, veLMin: number, tempC: number, rhPct: number, sex: Sex = 1): Fig2Curve {
  const base = fig2Reference(frcL, veLMin)
  const s = shift(frcL, veLMin, tempC, rhPct, sex)
  return {
    karamaoun: s ? base.map((b, i) => b * s.ratio[i]) : base,
    haut: s?.air ?? null,
    extrapolated: veLMin < 75 || veLMin > 115 || frcL < 3 || frcL > 3.5,
  }
}

export interface PersonalThreshold {
  /** VE where the Haut-shifted peak reaches the band's lower and upper edges, L/min. */
  hautShifted: [number, number]
  /** The 19 °C / 55 % threshold moved to this air by water flux, L/min. */
  waterDeficit: [number, number]
  /** The athlete's threshold in the paper's own air, L/min. */
  reference: [number, number]
}

/**
 * Threshold VE for this athlete and air. Peak over all 17 generations
 * (RMH 2026-10-31), bisection on 20 to 250 L/min; Infinity if never reached.
 */
export function personalThreshold(
  frcL: number,
  tempC: number,
  rhPct: number,
  pressurePa = 101325,
  sex: Sex = 1,
): PersonalThreshold {
  const solve = (peak: (ve: number) => number, ceiling: number) => {
    let lo = 20, hi = 250
    if (peak(hi) < ceiling) return Infinity
    if (peak(lo) >= ceiling) return lo
    while (hi - lo > 0.1) {
      const mid = (lo + hi) / 2
      if (peak(mid) >= ceiling) hi = mid
      else lo = mid
    }
    return (lo + hi) / 2
  }
  const refPeak = (ve: number) => Math.max(...fig2Reference(frcL, ve))
  const airPeak = (ve: number) => Math.max(...fig2Curve(frcL, ve, tempC, rhPct, sex).karamaoun)
  const reference: [number, number] = [solve(refPeak, BAND.low), solve(refPeak, BAND.high)]
  const scale = karamaounThresholdLMin(tempC, rhPct, pressurePa) / karamaounThresholdLMin(19, 55, 101325)
  return {
    reference,
    hautShifted: [solve(airPeak, BAND.low), solve(airPeak, BAND.high)],
    waterDeficit: [reference[0] * scale, reference[1] * scale],
  }
}

// --- helpers -------------------------------------------------------------------

function interp(x: readonly number[], y: readonly number[], v: number): number {
  if (v <= x[0]) return y[0]
  if (v >= x[x.length - 1]) return y[y.length - 1]
  let i = 1
  while (x[i] < v) i++
  return y[i - 1] + ((v - x[i - 1]) * (y[i] - y[i - 1])) / (x[i] - x[i - 1])
}

function linExtrap(x: readonly number[], y: readonly number[], v: number): number {
  const n = x.length
  if (v <= x[0]) return y[0] + ((v - x[0]) * (y[1] - y[0])) / (x[1] - x[0])
  if (v >= x[n - 1]) return y[n - 1] + ((v - x[n - 1]) * (y[n - 1] - y[n - 2])) / (x[n - 1] - x[n - 2])
  return interp(x, y, v)
}
