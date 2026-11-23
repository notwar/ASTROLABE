const A = require('./core.js'); const R = require('./ref.json');
function report(name, ins, refs, fn, rel) {
  let worst = 0, wi = -1;
  ins.forEach((v, i) => { const o = fn(v); for (let k=0;k<3;k++){ const r=refs[i][k]; const e = Math.abs(o[k]-r)/(rel?Math.max(Math.abs(r),1e-3):1); if (e>worst){worst=e;wi=i;} } });
  console.log(name.padEnd(12), 'worst', worst.toExponential(2), wi>=0? JSON.stringify(ins[wi])+' -> ours '+JSON.stringify(fn(ins[wi]).map(x=>+x.toFixed(5)))+' ocio '+JSON.stringify(refs[wi].map(x=>+x.toFixed(5))):'');
}
report('tex cg', R.srgb, R.tex_cg, v => A.srgbToAces(v,'direct').cg, false);
report('tex cct', R.srgb, R.tex_cct, v => A.srgbToAces(v,'direct').cct, false);
report('inv view', R.srgb, R.inv_cg, v => A.srgbToAces(v,'view').cg, true);
report('fwd view', R.cg, R.view_srgb, v => A.acesToSrgb('cg', v,'view').srgb, false);
// round trips
let w=0; R.srgb.forEach(s=>{const c=A.srgbToAces(s,'view'); const b=A.acesToSrgb('cg',c.cg,'view').srgb; for(let k=0;k<3;k++) w=Math.max(w,Math.abs(b[k]-s[k]));}); console.log('roundtrip view', w.toExponential(2));
w=0; R.srgb.forEach(s=>{const c=A.srgbToAces(s,'direct'); for (const sp of ['cg','ap0','cct']){const b=A.acesToSrgb(sp,c[sp],'direct').srgb; for(let k=0;k<3;k++) w=Math.max(w,Math.abs(b[k]-s[k]));}}); console.log('roundtrip direct', w.toExponential(2));
