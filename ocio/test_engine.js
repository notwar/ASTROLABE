// Compares OCIOEngine with real OCIO 2.5 (ref_configs.json from ref_configs.py).
// node ocio/test_engine.js [filter]   -> per config: pairs matching, failing, unsupported
const fs = require('fs');
const E = require('../ocio.js');
const refs = JSON.parse(fs.readFileSync(__dirname + '/ref_configs.json', 'utf8'));
const filter = process.argv[2] || '';
const verbose = process.argv.includes('-v');
(async () => {
  let totalBad = 0;
  for (const ref of refs) {
    if (filter && !ref.path.toLowerCase().includes(filter.toLowerCase())) continue;
    if (ref.error) { console.log('OCIO itself failed:', ref.path, ref.error); continue; }
    const io = {
      path: ref.path,
      readText: async (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
      getEnv: async (n) => process.env[n] || null,
    };
    let cfg;
    try { cfg = await E.load(fs.readFileSync(ref.path, 'utf8'), io); } catch (e) { console.log('LOAD FAIL', ref.path, e.message); totalBad++; continue; }
    let ok = 0, bad = 0, unsup = 0, worst = 0;
    const reasons = {}, bads = [];
    for (const p of ref.pairs) {
      if (p.error) continue;
      let fn;
      try { fn = E.chain(await E.build(cfg, io, () => cfg.dvtOps(p.cs, p.display, p.view))); } catch (e) {
        if (e instanceof E.Unsupported) { unsup++; reasons[e.message] = (reasons[e.message] || 0) + 1; continue; }
        console.log('ERROR', p.cs, '|', p.display, '|', p.view, e.stack); bad++; continue;
      }
      let err = 0;
      p.in.forEach((x, k) => {
        const y = fn(x), r = p.out[k];
        for (let c = 0; c < 3; c++) {
          if (r[c] === null) continue;
          const e = Math.abs(y[c] - r[c]) / Math.max(1, Math.abs(r[c]));
          if (!(e <= err)) err = Number.isNaN(e) ? Infinity : Math.max(err, e);
        }
      });
      worst = Math.max(worst, err);
      if (err < 2e-3) ok++; else { bad++; bads.push([err, p]); }
    }
    totalBad += bad;
    console.log((bad ? 'BAD ' : 'ok  ') + ok + '/' + (ok + bad) + ' match' + (unsup ? ', ' + unsup + ' unsupported' : '') + ', worst ' + worst.toExponential(1) + '  ' + ref.path.split(/[\/]/).slice(-2).join('/'));
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
