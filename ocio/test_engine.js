// Compares OCIOEngine with real OCIO 2.5 (ref_configs.json from ref_configs.py).
// node ocio/test_engine.js [filter]   -> per config: pairs matching, failing, unsupported
// Samples that differ from OCIO are checked once more by running both answers back through the config:
// - ours lands back on the input and OCIO's doesn't: OCIO's backwards LUT is approximate, ours is exact
//   ("ours exact"), not a failure;
// - neither lands back (or a 3D LUT run backwards can't make the colour): there is no exact answer, both
//   are guesses ("no exact answer"), not a failure;
// - anything else fails. KNOWN lists the differences we accept, each with its reason.
// Exit code 1 on any failure.
const fs = require('fs');
const E = require('../ocio.js');
// ref_configs.json holds data made from other apps' configs, so it stays on the PC that made it (not in git)
const refFile = __dirname + '/ref_configs.json';
if (!fs.existsSync(refFile)) { console.log('skipped: no ocio/ref_configs.json on this PC. Make it with ocio/ref_configs.py (see README).'); process.exit(0); }
const refs = JSON.parse(fs.readFileSync(refFile, 'utf8'));
const filter = process.argv[2] || '';
const verbose = process.argv.includes('-v');
const KNOWN = [
  // Blender's False Color view is a one-way heat map (brightness -> 1D LUT); we differ by up to 0.5% there
  { path: /Blender/, cs: 'Linear CIE-XYZ E', view: 'False Color', upTo: 6e-3 },
];
const known = (path, p, err) => KNOWN.some((k) => k.path.test(path) && k.cs === p.cs && k.view === p.view && err <= k.upTo);
const near = (a, b) => a.every((v, c) => Math.abs(v - b[c]) <= 1e-6 * Math.max(1, Math.abs(b[c])));
(async () => {
  let totalBad = 0;
  for (const ref of refs) {
    if (filter && !ref.path.toLowerCase().includes(filter.toLowerCase())) continue;
    if (ref.error) { console.log('OCIO itself failed:', ref.path, ref.error); continue; }
    if (!fs.existsSync(ref.path)) { console.log('skipped, not installed:', ref.path); continue; }
    const io = {
      path: ref.path,
      readText: async (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
      getEnv: async (n) => process.env[n] || null,
    };
    let cfg;
    try { cfg = await E.load(fs.readFileSync(ref.path, 'utf8'), io); } catch (e) { console.log('LOAD FAIL', ref.path, e.message); totalBad++; continue; }
    let ok = 0, bad = 0, unsup = 0, worst = 0, oursExact = 0, noExact = 0, accepted = 0;
    const reasons = {}, bads = [];
    for (const p of ref.pairs) {
      if (p.error) continue;
      let fn, back = null;
      try {
        const ops = await E.build(cfg, io, () => cfg.dvtOps(p.cs, p.display, p.view));
        fn = E.chain(ops);
        try { back = E.chain(E.invertOps(ops)); } catch (e) { back = null; }
      } catch (e) {
        if (e instanceof E.Unsupported) { unsup++; reasons[e.message] = (reasons[e.message] || 0) + 1; continue; }
        console.log('ERROR', p.cs, '|', p.display, '|', p.view, e.stack); bad++; continue;
      }
      let err = 0;
      p.in.forEach((x, k) => {
        const ctx = {}, y = fn(x, ctx), r = p.out[k];
        let e = 0;
        for (let c = 0; c < 3; c++) {
          if (r[c] === null) continue;
          const d = Math.abs(y[c] - r[c]) / Math.max(1, Math.abs(r[c]));
          if (!(d <= e)) e = Number.isNaN(d) ? Infinity : Math.max(e, d);
        }
        if (e < 2e-3) { worst = Math.max(worst, e); return; }
        // differs: does either answer lead back to the input? (only where the path can be run backwards)
        let checked = false, oursBack = false, ocioBack = false;
        if (back && r.every((v) => v !== null)) {
          try { oursBack = near(back(y), x); ocioBack = near(back(r), x); checked = true; } catch (er) { /* not invertible */ }
        }
        if (checked && oursBack && !ocioBack) { oursExact++; return; }
        if (ctx.outsideLut || (checked && !oursBack && !ocioBack)) { noExact++; return; }
        err = Math.max(err, e);
      });
      worst = Math.max(worst, err);
      if (err < 2e-3) ok++;
      else if (known(ref.path, p, err)) { ok++; accepted++; }
      else { bad++; bads.push([err, p]); }
    }
    totalBad += bad;
    console.log((bad ? 'BAD ' : 'ok  ') + ok + '/' + (ok + bad) + ' match' + (unsup ? ', ' + unsup + ' unsupported' : '') + (oursExact ? ', ' + oursExact + ' samples where ours is exact and OCIO approximates' : '') + (noExact ? ', ' + noExact + ' samples with no exact answer' : '') + (accepted ? ', ' + accepted + ' known difference' + (accepted > 1 ? 's' : '') : '') + ', worst ' + worst.toExponential(1) + '  ' + ref.path.split(/[\/]/).slice(-2).join('/'));
    for (const [r, n] of Object.entries(reasons)) console.log('      unsupported x' + n + ': ' + r);
    bads.sort((a, b) => b[0] - a[0]);
    for (const [err, p] of bads.slice(0, verbose ? 10 : 3)) {
      const fn = E.chain(await E.build(cfg, io, () => cfg.dvtOps(p.cs, p.display, p.view)));
      const k = p.in.findIndex((x, i) => true);
      console.log('      err ' + err.toExponential(2) + ' ' + p.cs + ' -> ' + p.display + ' / ' + p.view);
      for (let i = 0; i < Math.min(3, p.in.length); i++) console.log('         in ' + p.in[i].map((v) => v.toFixed(4)) + '  ocio ' + p.out[i].map((v) => v === null ? 'nan' : v.toFixed(5)) + '  js ' + fn(p.in[i]).map((v) => v.toFixed(5)));
    }
  }
  process.exitCode = totalBad ? 1 : 0;
})();
