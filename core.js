// Colour maths for AS_STUDIO ACES 1.0, the built-in config: ACES 1.0 (from the Academy's ACES 1.0.3 CTL)
// with the standard OCIO sRGB and Rec.709 displays. Same results as the AS_STUDIO_RS.ocio config.
// ACES: Copyright © 2015 Academy of Motion Picture Arts and Sciences (A.M.P.A.S.). Licence terms in app/README.md.
// Two paths:
//   "direct": sRGB display -> CIE-XYZ D65 -> ACES2065-1 via the default view transform
//             (Un-tone-mapped, Bradford). This is what OCIO does for sRGB -> ACEScg.
//   "view":   the ACES 1.0 SDR-video view (RRT + Rec.709 100-nit dim ODT) and its inverse,
//             i.e. the "Invert ACES 1.0 SDR-video" colour space in the same config.
const ACESCore = (() => {
  const mul = (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
  const mm = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  const inv = (m) => {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
      [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
    ];
  };

  // --- matrices -----------------------------------------------------------
  // sRGB (linear) -> ACEScg, read from OCIO 2.5 (the display path: CIE-XYZ D65, Bradford).
  const SRGB_TO_CG = [
    [0.613112211227417, 0.3395313024520874, 0.04738059267401695],
    [0.07019541412591934, 0.9163759350776672, 0.013452722690999508],
    [0.020616089925169945, 0.1095724105834961, 0.8698355555534363],
  ];
  const CG_TO_SRGB = inv(SRGB_TO_CG);
  // ACEScg -> ACES2065-1, from the config's ACEScg colour space.
  const AP1_TO_AP0 = [
    [0.695452241357, 0.14067869647, 0.163869062172],
    [0.044794563372, 0.859671118456, 0.095534318172],
    [-0.005525882558, 0.004025210306, 1.001500672252],
  ];
  const AP0_TO_AP1 = inv(AP1_TO_AP0);

  // Primaries -> XYZ (normalised primary matrix)
  const npm = (p, w) => {
    const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const P = [xyz(p[0]), xyz(p[1]), xyz(p[2])];
    const Pt = [[P[0][0], P[1][0], P[2][0]], [P[0][1], P[1][1], P[2][1]], [P[0][2], P[1][2], P[2][2]]];
    const S = mul(inv(Pt), xyz(w));
    return Pt.map((row) => row.map((v, j) => v * S[j]));
  };
  const W_ACES = [0.32168, 0.33767], W_D65 = [0.3127, 0.329];
  const AP1_TO_XYZ = npm([[0.713, 0.293], [0.165, 0.83], [0.128, 0.044]], W_ACES);
  const XYZ_TO_AP1 = inv(AP1_TO_XYZ);
  const REC709_TO_XYZ = npm([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], W_D65);
  const XYZ_TO_REC709 = inv(REC709_TO_XYZ);
  const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
  const cat = (ws, wd) => {
    const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const s = mul(BRADFORD, xyz(ws)), d = mul(BRADFORD, xyz(wd));
    const D = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
    return mm(inv(BRADFORD), mm(D, BRADFORD));
  };
  // linear AP1 (after ODT) -> linear Rec.709 D65 display
  const ODT_AP1_TO_709 = mm(XYZ_TO_REC709, mm(cat(W_ACES, W_D65), AP1_TO_XYZ));
  const ODT_709_TO_AP1 = inv(ODT_AP1_TO_709);
  const AP1_Y = AP1_TO_XYZ[1];

  // --- sRGB transfer ------------------------------------------------------
  const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const srgbEncode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // --- ACEScct ------------------------------------------------------------
  const toCct = (v) => (v <= 0.0078125 ? 10.5402377416545 * v + 0.0729055341958355 : (Math.log2(v) + 9.72) / 17.52);
  const fromCct = (v) => (v <= 0.155251141552511 ? (v - 0.0729055341958355) / 10.5402377416545 : Math.pow(2, v * 17.52 - 9.72));

  // --- ACES 1.0 RRT / ODT pieces (from the ACES 1.0.3 CTL) ----------------
  const satAdjust = (v, s) => {
    const y = AP1_Y[0] * v[0] + AP1_Y[1] * v[1] + AP1_Y[2] * v[2];
    return v.map((c) => (1 - s) * y + s * c);
  };
  const satInverse = (v, s) => {
    const y = AP1_Y[0] * v[0] + AP1_Y[1] * v[1] + AP1_Y[2] * v[2];
    return v.map((c) => (c - (1 - s) * y) / s);
  };
  const SPLINE_M = (c0, c1, c2) => [0.5 * c0 - c1 + 0.5 * c2, -c0 + c1, 0.5 * c0 + 0.5 * c1];
  const log10 = Math.log10, pow10 = (v) => Math.pow(10, v);

  function splineFwd(x, C, n) {
    const xs = x <= 0 ? 5.96046448e-8 : x;
    const lx = log10(xs);
    const lmin = log10(C.min[0]), lmid = log10(C.mid[0]), lmax = log10(C.max[0]);
    let ly;
    if (lx <= lmin) ly = lx * C.slopeLow + (log10(C.min[1]) - C.slopeLow * lmin);
    else if (lx < lmid) {
      const k = ((n - 1) * (lx - lmin)) / (lmid - lmin), j = Math.floor(k), t = k - j;
      const m = SPLINE_M(C.low[j], C.low[j + 1], C.low[j + 2]);
      ly = t * t * m[0] + t * m[1] + m[2];
    } else if (lx < lmax) {
      const k = ((n - 1) * (lx - lmid)) / (lmax - lmid), j = Math.floor(k), t = k - j;
      const m = SPLINE_M(C.high[j], C.high[j + 1], C.high[j + 2]);
      ly = t * t * m[0] + t * m[1] + m[2];
    } else ly = lx * C.slopeHigh + (log10(C.max[1]) - C.slopeHigh * lmax);
    return pow10(ly);
  }
  function splineRev(y, C, n) {
    const ly = log10(Math.max(y, 1e-10));
    const lmin = log10(C.min[0]), lmid = log10(C.mid[0]), lmax = log10(C.max[0]);
    const seg = (coefs, base, inc) => {
      const knots = [];
      for (let i = 0; i < n; i++) knots.push((coefs[i] + coefs[i + 1]) / 2);
      // pick the knot interval holding ly; values a hair outside fall into the end intervals
      let j = n - 2;
      for (let i = 0; i < n - 1; i++) if (ly <= knots[i + 1]) { j = i; break; }
      const m = SPLINE_M(coefs[j], coefs[j + 1], coefs[j + 2]);
      const a = m[0], b = m[1], c = m[2] - ly;
      const d = Math.sqrt(Math.max(0, b * b - 4 * a * c));
      const t = Math.min(1, Math.max(0, (2 * c) / (-d - b)));
      return base + (t + j) * inc;
    };
    let lx;
    if (ly <= log10(C.min[1])) lx = lmin;
    else if (ly <= log10(C.mid[1])) lx = seg(C.low, lmin, (lmid - lmin) / (n - 1));
    else if (ly < log10(C.max[1])) lx = seg(C.high, lmid, (lmax - lmid) / (n - 1));
    else lx = lmax;
    return pow10(lx);
  }
  const C5 = {
    low: [-4.0, -4.0, -3.1573765773, -0.4852499958, 1.8477324706, 1.8477324706],
    high: [-0.7185482425, 2.0810307172, 3.6681241237, 4.0, 4.0, 4.0],
    min: [0.18 * Math.pow(2, -15), 0.0001], mid: [0.18, 4.8], max: [0.18 * Math.pow(2, 18), 10000],
    slopeLow: 0, slopeHigh: 0,
  };
  const c5f = (x) => splineFwd(x, C5, 4), c5r = (y) => splineRev(y, C5, 4);
  const C9 = {
    low: [-1.6989700043, -1.6989700043, -1.4779, -1.2291, -0.8648, -0.448, 0.00518, 0.4511080334, 0.9113744414, 0.9113744414],
    high: [0.5154386965, 0.8470437783, 1.1358, 1.3802, 1.5197, 1.5985, 1.6467, 1.6746091357, 1.687873339, 1.687873339],
    min: [c5f(0.18 * Math.pow(2, -6.5)), 0.02], mid: [c5f(0.18), 4.8], max: [c5f(0.18 * Math.pow(2, 6.5)), 48.0],
    slopeLow: 0, slopeHigh: 0.04,
  };
  const c9f = (x) => splineFwd(x, C9, 8), c9r = (y) => splineRev(y, C9, 8);

  const rgbSat = (v) => {
    const mx = Math.max(...v), mn = Math.min(...v);
    return (Math.max(mx, 1e-10) - Math.max(mn, 1e-10)) / Math.max(mx, 1e-2);
  };
  const rgbYc = ([r, g, b]) => {
    const ch = Math.sqrt(Math.max(0, b * (b - g) + g * (g - r) + r * (r - b)));
    return (b + g + r + 1.75 * ch) / 3;
  };
  const sigmoid = (x) => {
    const t = Math.max(1 - Math.abs(x / 2), 0);
    return (1 + Math.sign(x) * (1 - t * t)) / 2;
  };
  const glowFwd = (yc, gain, mid) => (yc <= (2 / 3) * mid ? gain : yc >= 2 * mid ? 0 : gain * (mid / yc - 0.5));
  const glowInv = (yc, gain, mid) =>
    yc <= (1 + gain) * (2 / 3) * mid ? -gain / (1 + gain) : yc >= 2 * mid ? 0 : (gain * (mid / yc - 0.5)) / (gain / 2 - 1);
  const hueOf = ([r, g, b]) => {
    if (r === g && g === b) return 0;
    let h = (180 / Math.PI) * Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
    return h < 0 ? h + 360 : h;
  };
  const centerHue = (h) => (h < -180 ? h + 360 : h > 180 ? h - 360 : h);
  const cubicBasis = (x, w) => {
    const M = [[-1 / 6, 3 / 6, -3 / 6, 1 / 6], [3 / 6, -1, 3 / 6, 0], [-3 / 6, 0, 3 / 6, 0], [1 / 6, 4 / 6, 1 / 6, 0]];
    const k0 = -w / 2, k4 = w / 2;
    if (!(x > k0 && x < k4)) return 0;
    const kc = ((x - k0) * 4) / w, j = Math.floor(kc), t = kc - j;
    const mono = [t * t * t, t * t, t, 1];
    const col = 3 - j;
    if (col < 0 || col > 3) return 0;
    return (mono[0] * M[0][col] + mono[1] * M[1][col] + mono[2] * M[2][col] + mono[3] * M[3][col]) * 1.5;
  };
  const HALF_MAX = 65504;

  function rrt(ap0) {
    let a = ap0.slice();
    const sat = rgbSat(a);
    const s = sigmoid((sat - 0.4) / 0.2);
    const glow = 1 + glowFwd(rgbYc(a), 0.05 * s, 0.08);
    a = a.map((c) => c * glow);
    const hw = cubicBasis(centerHue(hueOf(a)), 135);
    a[0] = a[0] + hw * sat * (0.03 - a[0]) * (1 - 0.82);
    a = a.map((c) => Math.min(Math.max(c, 0), HALF_MAX));
    let p = mul(AP0_TO_AP1, a).map((c) => Math.min(Math.max(c, 0), HALF_MAX));
    p = satAdjust(p, 0.96);
    return p.map(c5f); // OCES in AP1
  }
  function rrtInv(ocesAp1) {
    let p = ocesAp1.map(c5r);
    p = satInverse(p, 0.96).map((c) => Math.min(Math.max(c, 0), HALF_MAX));
    let a = mul(AP1_TO_AP0, p);
    const hue = centerHue(hueOf(a));
    const hw = cubicBasis(hue, 135);
    const minChan = hue < 0 ? a[1] : a[2];
    const qa = hw * (1 - 0.82) - 1;
    const qb = a[0] - hw * (0.03 + minChan) * (1 - 0.82);
    const qc = hw * 0.03 * minChan * (1 - 0.82);
    a[0] = (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
    const sat = rgbSat(a);
    const s = sigmoid((sat - 0.4) / 0.2);
    const g = 1 + glowInv(rgbYc(a), 0.05 * s, 0.08);
    return a.map((c) => c * g);
  }
  const darkToDim = (v, gamma) => {
    const X = mul(AP1_TO_XYZ, v);
    let d = X[0] + X[1] + X[2];
    if (d === 0) d = 1e-10;
    const x = X[0] / d, y = X[1] / d;
    const Y = Math.pow(Math.max(X[1], 0), gamma);
    const yy = Math.max(y, 1e-10);
    return mul(XYZ_TO_AP1, [(x * Y) / yy, Y, ((1 - x - y) * Y) / yy]);
  };
  function odt(ocesAp1) {
    let v = ocesAp1.map((c) => (c9f(c) - 0.02) / (48 - 0.02));
    v = darkToDim(v, 0.9811);
    v = satAdjust(v, 0.93);
    return mul(ODT_AP1_TO_709, v); // linear Rec.709 display
  }
  function odtInv(lin709) {
    let v = mul(ODT_709_TO_AP1, lin709);
    v = satInverse(v, 0.93);
    v = darkToDim(v, 1 / 0.9811);
    return v.map((c) => c9r(c * (48 - 0.02) + 0.02));
  }

  // --- the ACES 1.0 SDR-video look as linear Rec.709 display light ------
  // ACEScg -> linear Rec.709/sRGB display (RRT + ODT, before the display encoding)
  function cgToDisplayLin(cg) {
    return odt(rrt(mul(AP1_TO_AP0, cg)));
  }
  // linear display -> ACEScg. The CTL inverse (red modifier, glow) is approximate, so the forward
  // look of its result can be ~1/255 off. Nudge the scene value until the forward look lands on the target.
  function displayLinToCg(lin) {
    const target = lin.map(clamp01);
    const invView = (l) => rrtInv(odtInv(l));
    const fwdView = (ap0) => odt(rrt(ap0));
    const err = (a) => Math.max(...fwdView(a).map(clamp01).map((v, k) => Math.abs(v - target[k])));
    const goal = invView(target);
    let ap0 = goal.slice();
    for (let i = 0; i < 8; i++) {
      const seen = fwdView(ap0).map(clamp01);
      if (Math.max(...seen.map((v, k) => Math.abs(v - target[k]))) < 1e-7) break;
      const back = invView(seen);
      const next = ap0.map((v, k) => v + (goal[k] - back[k]));
      if (err(next) >= err(ap0)) break; // only accept a step that gets closer
      ap0 = next;
    }
    return mul(AP0_TO_AP1, ap0);
  }

  // --- final output encodings ---------------------------------------------
  // sRGB: the config's sRGB display (piecewise curve). Rec.709: ACES 1.0 Rec.709 output,
  // the same tone map encoded with BT.1886 (pure 2.4 gamma, black 0, white 1).
  const OUTPUTS = {
    srgb: { enc: (v) => srgbEncode(clamp01(v)), dec: (v) => srgbDecode(clamp01(v)) },
    rec709: { enc: (v) => Math.pow(clamp01(v), 1 / 2.4), dec: (v) => Math.pow(clamp01(v), 2.4) },
  };
  const exportOf = (cg, out) => cgToDisplayLin(cg).map(OUTPUTS[out].enc);
  const cgForExport = (exp, out) => displayLinToCg(exp.map(OUTPUTS[out].dec));

  // --- how a colour typed in the comp is interpreted ----------------------
  // sRGB is extended (values above 1 or below 0 keep the curve, mirrored), like a 32 bpc comp.
  const srgbDecodeX = (v) => (v < 0 ? -srgbDecode(-v) : srgbDecode(v));
  const srgbEncodeX = (v) => (v < 0 ? -srgbEncode(-v) : srgbEncode(v));
  function interpToCg(interp, v) {
    if (interp === 'invert') return displayLinToCg(v.map((c) => srgbDecode(clamp01(c))));
    if (interp === 'srgb') return mul(SRGB_TO_CG, v.map(srgbDecodeX));
    if (interp === 'ap0') return mul(AP0_TO_AP1, v);
    if (interp === 'cct') return v.map(fromCct);
    return v.slice();
  }
  function cgToInterp(interp, cg) {
    if (interp === 'invert') return cgToDisplayLin(cg).map((c) => srgbEncode(clamp01(c)));
    if (interp === 'srgb') return mul(CG_TO_SRGB, cg).map(srgbEncodeX);
    if (interp === 'ap0') return mul(AP1_TO_AP0, cg);
    if (interp === 'cct') return cg.map(toCct);
    return cg.slice();
  }

  // --- public API ---------------------------------------------------------
  // srgb: encoded display values 0..1. Returns { cg, ap0, cct } linear ACES values.
  function fromCg(cg) {
    return { cg, ap0: mul(AP1_TO_AP0, cg), cct: cg.map(toCct) };
  }
  function toCg(space, v) {
    if (space === 'ap0') return mul(AP0_TO_AP1, v);
    if (space === 'cct') return v.map(fromCct);
    return v.slice();
  }
  function srgbToAces(srgb, mode) {
    const lin = srgb.map((c) => srgbDecode(clamp01(c)));
    if (mode === 'view') return fromCg(displayLinToCg(lin));
    return fromCg(mul(SRGB_TO_CG, lin));
  }
  // Returns { srgb (clamped, encoded), raw (encoded, unclamped linear->encode), clipped }
  function acesToSrgb(space, v, mode) {
    const cg = toCg(space, v);
    let lin;
    if (mode === 'view') lin = odt(rrt(mul(AP1_TO_AP0, cg)));
    else lin = mul(CG_TO_SRGB, cg);
    const eps = 1e-5;
    const clipped = lin.some((c) => c < -eps || c > 1 + eps);
    return { srgb: lin.map((c) => srgbEncode(clamp01(c))), lin, clipped };
  }
  return { srgbToAces, acesToSrgb, srgbEncode, srgbDecode, cgToDisplayLin, displayLinToCg, exportOf, cgForExport, interpToCg, cgToInterp };
})();
if (typeof module !== 'undefined') module.exports = ACESCore;
