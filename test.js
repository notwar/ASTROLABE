// The built-in AS_STUDIO ACES 1.0 maths (core.js) against OCIO 2.5 (ref.json from ref.py).
// node test.js -> one line per check; exit code 1 when a check is over its limit or gives a non-number.
// The limits are what this maths reaches today, so a change that makes it worse fails:
// - texture, ACEScct and the forward view match OCIO closely;
// - "inv view" is the CTL-style inverse of the view, which is approximate (up to ~1.6% off); the app
//   refines it afterwards, which the last check (target hex -> value -> same hex) covers.
const A = require('./core.js'); const R = require('./ref.json');
let failed = 0;
function report(name, ins, refs, fn, rel, limit) {
  let worst = 0, wi = -1;
  ins.forEach((v, i) => { const o = fn(v); for (let k = 0; k < 3; k++) { const r = refs[i][k]; const e = Math.abs(o[k] - r) / (rel ? Math.max(Math.abs(r), 1e-3) : 1); if (!(e <= worst)) { worst = Number.isNaN(e) ? Infinity : e; wi = i; } } });
  const ok = worst <= limit;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(16), 'worst', worst.toExponential(2), 'limit', limit.toExponential(0), ok || wi < 0 ? '' : JSON.stringify(ins[wi]) + ' -> ours ' + JSON.stringify(fn(ins[wi]).map((x) => +x.toFixed(5))) + ' ocio ' + JSON.stringify(refs[wi].map((x) => +x.toFixed(5))));
}
report('tex cg', R.srgb, R.tex_cg, (v) => A.srgbToAces(v, 'direct').cg, false, 1e-4);
report('tex cct', R.srgb, R.tex_cct, (v) => A.srgbToAces(v, 'direct').cct, false, 1e-4);
report('inv view', R.srgb, R.inv_cg, (v) => A.srgbToAces(v, 'view').cg, true, 0.02);
report('fwd view', R.cg, R.view_srgb, (v) => A.acesToSrgb('cg', v, 'view').srgb, false, 1e-4);
// round trip without the view: exact
let w = 0;
R.srgb.forEach((s) => { const c = A.srgbToAces(s, 'direct'); for (const sp of ['cg', 'ap0', 'cct']) { const b = A.acesToSrgb(sp, c[sp], 'direct').srgb; for (let k = 0; k < 3; k++) w = Math.max(w, Math.abs(b[k] - s[k])); } });
const okDirect = w <= 1e-9; if (!okDirect) failed++;
console.log((okDirect ? 'ok   ' : 'FAIL ') + 'roundtrip direct'.padEnd(16), 'worst', w.toExponential(2));
// what the app does: target hex -> value to type -> forward -> same hex? (the app then looks harder for the rest)
const hex = (c) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',');
let seed = 7, hits = 0, n = 0, nan = 0;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let i = 0; i < 2000; i++) {
  const t = [rnd(), rnd(), rnd()].map((x) => Math.round(x * 255) / 255);
  for (const out of ['srgb', 'rec709']) {
    n++;
    const cg = A.cgForExport(t, out);
    if (!cg.every(Number.isFinite)) { nan++; continue; }
    if (hex(A.exportOf(cg, out)) === hex(t)) hits++;
  }
}
const okApp = nan === 0 && hits >= 0.99 * n; if (!okApp) failed++;
console.log((okApp ? 'ok   ' : 'FAIL ') + 'hex round trip'.padEnd(16), hits + '/' + n + ' land on the target (at least 99%)' + (nan ? ', ' + nan + ' not a number' : ''));
console.log(failed ? failed + ' checks failed' : 'all checks pass');
process.exitCode = failed ? 1 : 0;
