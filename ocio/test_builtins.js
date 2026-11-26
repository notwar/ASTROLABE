// Every OCIO builtin: forward and inverse against OCIO 2.5 (ref_builtins.json from ref_builtins.py)
const fs = require('fs');
const E = require('../ocio.js');
const refs = JSON.parse(fs.readFileSync(__dirname + '/ref_builtins.json', 'utf8'));
const only = process.argv[2] || '';
const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
let bad = 0;
for (const [style, r] of Object.entries(refs)) {
  if (only && !style.includes(only)) continue;
  if (r.error) { console.log('ocio error', style); continue; }
  let ops;
  try { ops = E.builtinOps(style); } catch (e) { console.log('UNSUPPORTED ' + style + ': ' + e.message); continue; }
  const f = E.chain(ops);
  let ef = 0, eb = 0, wf = null, wb = null;
  r.in.forEach((x, k) => {
    const y = f(x), o = r.out[k];
    for (let c = 0; c < 3; c++) if (o[c] !== null) { const e = rel(y[c], o[c]); if (!(e <= ef)) { ef = Number.isNaN(e) ? Infinity : e; wf = [x, o, y]; } }
    if (r.back && o.every((v) => v !== null)) {
      // compare round trips: our inverse of OCIO's output vs OCIO's inverse of it
      const bOcio = r.back[k];
      const bJs = E.chain(ops.slice().reverse().map((op) => ({ f: op.i || ((v) => E.newton(op.f, v, v)) })))(o);
      for (let c = 0; c < 3; c++) if (bOcio[c] !== null) { const e = rel(bJs[c], bOcio[c]); if (!(e <= eb)) { eb = Number.isNaN(e) ? Infinity : e; wb = [o, bOcio, bJs]; } }
    }
  });
  const okF = ef < 1e-3, okB = eb < 5e-3;
  if (!okF || !okB) bad++;
  console.log((okF && okB ? 'ok  ' : 'BAD ') + 'fwd ' + ef.toExponential(1) + ' inv ' + eb.toExponential(1) + '  ' + style);
  const f4 = (v) => v.map((x) => (x === null ? 'nan' : x.toFixed(5))).join(',');
  if (!okF) console.log('      fwd in ' + f4(wf[0]) + ' ocio ' + f4(wf[1]) + ' js ' + f4(wf[2]));
  if (!okB) console.log('      inv in ' + f4(wb[0]) + ' ocio ' + f4(wb[1]) + ' js ' + f4(wb[2]));
}
console.log(bad ? bad + ' builtins differ' : 'all builtins match');
process.exitCode = bad ? 1 : 0;
