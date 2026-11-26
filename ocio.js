// OCIO engine for ASTROLABE: reads an OpenColorIO config (v1 or v2) and runs its colour
// transforms in plain JavaScript, so the app can use any config without OCIO installed.
//
// What it covers: every transform type in the configs we use (matrix, exponent, log, range,
// CDL, allocation, builtin, fixed function, file LUTs .spi1d/.spi3d/.spimtx/.cube/.3dl,
// group, colour space, display/view, look). Builtin transforms come as op lists dumped from
// OCIO 2.5 itself (ocio/builtins_ops.json). The ACES 1.x fixed functions and the ACES 2.0
// output transform are ports of OpenColorIO 2.5 (BSD-3-Clause, Copyright Contributors to the
// OpenColorIO Project). Checked against PyOpenColorIO 2.5 by ocio/test_engine.js.
// Licence texts (OpenColorIO BSD-3-Clause, ACES): app/README.md, "Licences".
const OCIOEngine = (() => {
  'use strict';
  const BUILTINS = typeof OCIO_BUILTINS !== 'undefined' ? OCIO_BUILTINS : require('./ocio/builtins_ops.json');

  class Unsupported extends Error {}
  class NeedFile extends Error { constructor(path) { super('needs file ' + path); this.path = path; } }

  // ---------------------------------------------------------------- small maths
  const m3mul = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
  const m3m3 = (a, b) => {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  };
  const m3inv = (m) => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det) throw new Unsupported('A matrix in the config can’t be inverted.');
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  };
  // primaries [[rx,ry],[gx,gy],[bx,by],[wx,wy]] -> RGB to XYZ (white Y = 1), no adaptation
  const npm = (P) => {
    const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const R = xyz(P[0]), G = xyz(P[1]), B = xyz(P[2]), W = xyz(P[3]);
    const M = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
    const S = m3mul(m3inv(M), W);
    return [M[0] * S[0], M[1] * S[1], M[2] * S[2], M[3] * S[0], M[4] * S[1], M[5] * S[2], M[6] * S[0], M[7] * S[1], M[8] * S[2]];
  };
  // C++ std::max / std::min keep the first argument when the other is NaN; Math.max does not.
  const cmax = (a, b) => (a < b ? b : a);
  const cmin = (a, b) => (b < a ? b : a);
  const lerp = (a, b, t) => a + t * (b - a);
  const FLTMIN = 1.175494e-38;
  const num = (v, d) => {
    if (v === undefined || v === null || v === '') return d;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  const tri = (v, d) => {
    if (Array.isArray(v)) return [num(v[0], d), num(v.length > 1 ? v[1] : v[0], d), num(v.length > 2 ? v[2] : v[0], d)];
    const n = num(v, d);
    return [n, n, n];
  };
  const isTrue = (v) => v === true || /^(true|yes|on|1)$/i.test(String(v || ''));
  const isInverse = (d) => /^inverse$/i.test(String(d || ''));

  // Solve f(x) = y for x with Newton steps (finite difference Jacobian), starting from x0.
  // Used for ops with no exact inverse (3D LUTs) and to refine the whole chain.
  // Solve f(x) = y for x (Levenberg-Marquardt with a finite difference Jacobian), from x0, optionally
  // inside a box [lo, hi]. Used for ops with no exact inverse (3D LUTs) and to refine the whole chain.
  // Damping keeps it moving where a channel goes flat (clipped LUT edges, clamps).
  function newton(f, y, x0, iters = 40, tol = 1e-10, lo = null, hi = null) {
    const box = (v) => (lo ? v.map((q, k) => Math.min(Math.max(q, lo[k]), hi[k])) : v);
    const resid = (o) => [o[0] - y[0], o[1] - y[1], o[2] - y[2]];
    const cost = (r) => r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    let x = box(x0.slice());
    let r = resid(f(x)), c = cost(r);
    if (!Number.isFinite(c)) return x;
    let lambda = 1e-6;
    for (let it = 0; it < iters && Math.sqrt(c) > tol; it++) {
      const J = []; // J[k] = column for input k
      for (let k = 0; k < 3; k++) {
        const h = 1e-6 * Math.max(1, Math.abs(x[k]));
        const xp = x.slice(); xp[k] += lo && xp[k] + h > hi[k] ? -h : h;
        const hk = xp[k] - x[k];
        const rp = resid(f(xp));
        J.push([(rp[0] - r[0]) / hk, (rp[1] - r[1]) / hk, (rp[2] - r[2]) / hk]);
      }
      // normal equations: (JtJ + lambda * diag) dx = Jt r
      const A = new Array(9), g = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        g[i] = J[i][0] * r[0] + J[i][1] * r[1] + J[i][2] * r[2];
        for (let j = 0; j < 3; j++) A[i * 3 + j] = J[i][0] * J[j][0] + J[i][1] * J[j][1] + J[i][2] * J[j][2];
      }
      let moved = false;
      for (let tries = 0; tries < 12 && !moved; tries++) {
        const M = A.slice();
        for (let i = 0; i < 3; i++) M[i * 4] += lambda * Math.max(A[i * 4], 1e-12);
        let dx;
        try { dx = m3mul(m3inv(M), g); } catch (e) { lambda *= 10; continue; }
        if (!dx.every(Number.isFinite)) { lambda *= 10; continue; }
        const xn = box([x[0] - dx[0], x[1] - dx[1], x[2] - dx[2]]);
        const rn = resid(f(xn)), cn = cost(rn);
        if (cn < c) { x = xn; r = rn; c = cn; lambda = Math.max(lambda / 10, 1e-12); moved = true; } else lambda *= 10;
      }
      if (!moved) break;
    }
    return x;
  }

  // An op maps [r,g,b] -> [r,g,b]. f = forward, i = exact inverse (or null: solved numerically).
  // ctx.measure: skip the final [0,1] clamps, to see if a colour clips in the final file.
  // key: identifies the op, so an op next to its own inverse can be dropped (OCIO's optimizer does
  // the same, which is why e.g. an inverted view followed by that same view is an exact pass-through).
  const op = (f, i, key) => ({ f, i: i || null, key: key || null, inv: false });
  const invOp = (o) => ({ f: o.i || ((v, ctx) => newton((x) => o.f(x, ctx), v, v)), i: o.f, key: o.key, inv: !o.inv, pair: o.pair });
  const keyed = (o, key) => { o.key = key; return o; };
  function simplify(ops) {
    const out = [];
    for (const o of ops) {
      const top = out[out.length - 1];
      if (top && o.key && top.key === o.key && top.inv !== o.inv) {
        out.pop();
        // a LUT and its inverse still clamp to the table's range, as in OCIO
        const keep = o.pair ? o.pair(top.inv) : null;
        if (keep) out.push(keep);
      } else out.push(o);
    }
    return out;
  }

  // ---------------------------------------------------------------- YAML (the subset OCIO writes)
  function parseYAML(src) {
    const stripComment = (s) => {
      let q = null;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { if (i === 0 || /[\s\[{,:]/.test(s[i - 1])) q = c; continue; }
        if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
      }
      return s;
    };
    const lines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map((raw) => {
      const text = stripComment(raw).replace(/\s+$/, '');
      return { raw, text, ind: text.search(/\S/) };
    });
    let li = 0;
    const peek = () => { while (li < lines.length && lines[li].ind < 0) li++; return li < lines.length ? lines[li] : null; };
    const isSeq = (ln) => /^-(\s|$)/.test(ln.text.slice(ln.ind));
    const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'\[\]{},#][^#]*?)\s*:(?:\s+|$)/;
    const TAG = /^!<([^>]*)>\s*|^!(\w+)\s*/;
    const unquote = (s) => {
      s = s.trim();
      if (s[0] === '"') return JSON.parse(s.replace(/\\\//g, '/').replace(/\\x([0-9a-f]{2})/gi, '\\u00$1'));
      if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
      return s;
    };
    const tag = (v, t) => {
      if (!t) return v;
      if (v && typeof v === 'object') { v.$tag = t; return v; }
      return { $tag: t, value: v };
    };
    function flowAt(lineIdx, col) {
      // gather the flow collection, which may run over several lines
      let s = lines[lineIdx].text.slice(col), depth = 0, q = null, last = lineIdx;
      const balance = (str) => {
        for (let i = 0; i < str.length; i++) {
          const c = str[i];
          if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
          if (c === '"' || c === "'") q = c;
          else if (c === '[' || c === '{') depth++;
          else if (c === ']' || c === '}') depth--;
        }
      };
      balance(s);
      while (depth > 0 && last + 1 < lines.length) { last++; s += ' ' + lines[last].text; balance(' ' + lines[last].text); }
      li = last + 1;
      let p = 0;
      const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
      const quoted = () => {
        const qc = s[p];
        let j = p + 1;
        while (j < s.length && s[j] !== qc) { if (s[j] === '\\' && qc === '"') j++; j++; }
        const out = unquote(s.slice(p, j + 1));
        p = j + 1;
        return out;
      };
      const plain = (isKey) => {
        let j = p;
        while (j < s.length) {
          const c = s[j];
          if (c === ',' || c === ']' || c === '}') break;
          if (isKey && c === ':' && (j + 1 >= s.length || /[\s,\]}]/.test(s[j + 1]))) break;
          j++;
        }
        const out = s.slice(p, j).trim();
        p = j;
        return out;
      };
      // every pass through a list or map must read something: a stray "}" in a list (or "]" in a map)
      // would otherwise stop the reader in place forever. Stop with an error instead.
      const stuck = (from) => {
        if (p > from) return;
        throw new Error('Could not read line ' + (lineIdx + 1) + ' of the config: unexpected "' + s[p] + '" in ' + s.trim().slice(0, 80));
      };
      function value(isKey) {
        ws();
        let t = null;
        const m = TAG.exec(s.slice(p));
        if (m) { t = m[1] || m[2]; p += m[0].length; ws(); }
        const c = s[p];
        let v;
        if (c === '{') {
          p++; v = {};
          for (;;) {
            ws();
            if (s[p] === '}') { p++; break; }
            if (p >= s.length) break;
            const from = p;
            const k = value(true);
            ws();
            let val = null;
            if (s[p] === ':') { p++; ws(); val = s[p] === ',' || s[p] === '}' ? null : value(false); }
            v[k] = val;
            ws();
            if (s[p] === ',') p++;
            stuck(from);
          }
        } else if (c === '[') {
          p++; v = [];
          for (;;) {
            ws();
            if (s[p] === ']') { p++; break; }
            if (p >= s.length) break;
            const from = p;
            v.push(value(false));
            ws();
            if (s[p] === ',') p++;
            stuck(from);
          }
        } else if (c === '"' || c === "'") v = quoted();
        else v = plain(isKey);
        return tag(v, t);
      }
      return value(false);
    }
    function blockScalar(ind, indicator) {
      li++;
      const out = [];
      let base = -1;
      while (li < lines.length) {
        const ln = lines[li];
        const rawInd = ln.raw.search(/\S/);
        if (rawInd < 0) { out.push(''); li++; continue; }
        if (rawInd <= ind) break;
        if (base < 0) base = rawInd;
        out.push(ln.raw.slice(base));
        li++;
      }
      while (out.length && out[out.length - 1] === '') out.pop();
      return indicator[0] === '>' ? out.join(' ') : out.join('\n');
    }
    function scalarOrMore(rest, ind, col) {
      let t = null;
      const m = TAG.exec(rest);
      if (m) { t = m[1] || m[2]; rest = rest.slice(m[0].length); col += m[0].length; }
      let v;
      if (!rest) {
        li++;
        const nx = peek();
        if (nx && nx.ind > ind) v = node(nx.ind);
        else if (nx && nx.ind === ind && isSeq(nx)) v = seq(ind);
        else v = t ? {} : null;
      } else if (rest[0] === '|' || rest[0] === '>') v = blockScalar(ind, rest);
      else if (rest[0] === '{' || rest[0] === '[') v = flowAt(li, col);
      else { li++; v = rest[0] === '"' || rest[0] === "'" ? unquote(rest) : rest.trim(); }
      return tag(v, t);
    }
    function map(ind) {
      const obj = {};
      let ln;
      while ((ln = peek()) && ln.ind === ind && !isSeq(ln)) {
        const body = ln.text.slice(ind);
        const m = KEY.exec(body);
        if (!m) throw new Error('Could not read line ' + (li + 1) + ' of the config: ' + body.trim());
        const key = unquote(m[1]);
        const rest = body.slice(m[0].length);
        obj[key] = scalarOrMore(rest, ind, ind + m[0].length);
      }
      return obj;
    }
    function seq(ind) {
      const arr = [];
      let ln;
      while ((ln = peek()) && ln.ind === ind && isSeq(ln)) {
        const after = ln.text.slice(ind + 1);
        const pad = after.search(/\S/);
        if (pad < 0) { li++; arr.push(node(ind + 1)); continue; }
        let rest = after.slice(pad), col = ind + 1 + pad, t = null;
        const m = TAG.exec(rest);
        if (m) { t = m[1] || m[2]; rest = rest.slice(m[0].length); col += m[0].length; }
        if (rest && rest[0] !== '{' && rest[0] !== '[' && rest[0] !== '"' && rest[0] !== "'" && KEY.test(rest)) {
          // "- key: value": a mapping that starts on the dash line
          lines[li] = { raw: ' '.repeat(col) + rest, text: ' '.repeat(col) + rest, ind: col };
          arr.push(tag(map(col), t));
        } else {
          arr.push(scalarOrMore((t ? '!<' + t + '> ' : '') + rest, ind, col - (t ? ('!<' + t + '> ').length : 0)));
        }
      }
      return arr;
    }
    function node(ind) {
      const ln = peek();
      if (!ln || ln.ind < ind) return null;
      if (isSeq(ln)) return seq(ln.ind);
      const body = ln.text.slice(ln.ind);
      if (body[0] === '{' || body[0] === '[') return flowAt(li, ln.ind); // "key:" then "  {}" on the next line
      if (!KEY.test(body)) { // a plain or quoted scalar on its own line(s)
        if (body[0] === '"' || body[0] === "'") { li++; return unquote(body); }
        const parts = [];
        let l2;
        while ((l2 = peek()) && l2.ind >= ln.ind && !isSeq(l2) && !KEY.test(l2.text.slice(l2.ind))) { parts.push(l2.text.trim()); li++; }
        return parts.join(' ');
      }
      return map(ln.ind);
    }
    return node(0) || {};
  }

  // ---------------------------------------------------------------- primitive ops
  function matrixOp(m16, off) {
    const m = m16 && m16.length >= 16
      ? [m16[0], m16[1], m16[2], m16[4], m16[5], m16[6], m16[8], m16[9], m16[10]].map(Number)
      : m16 && m16.length === 9 ? m16.map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const o = off ? [num(off[0], 0), num(off[1], 0), num(off[2], 0)] : [0, 0, 0];
    let mi = null;
    return op(
      (v) => { const r = m3mul(m, v); return [r[0] + o[0], r[1] + o[1], r[2] + o[2]]; },
      (v) => { mi = mi || m3inv(m); return m3mul(mi, [v[0] - o[0], v[1] - o[1], v[2] - o[2]]); },
      'M' + m.join(',') + ';' + o.join(','),
    );
  }
  function rangeOp(minIn, maxIn, minOut, maxOut, clamp) {
    const has = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(+x);
    const build = (a, b, c, d) => {
      if (has(a) && has(b)) {
        a = +a; b = +b; c = +c; d = +d;
        const s = (d - c) / (b - a);
        const unit = clamp && a === 0 && b === 1 && c === 0 && d === 1;
        return (v, ctx) => v.map((x) => {
          const y = c + (x - a) * s;
          if (!clamp || (unit && ctx && ctx.measure)) return y;
          return Math.min(Math.max(y, Math.min(c, d)), Math.max(c, d));
        });
      }
      if (has(a)) { a = +a; c = +c; return (v) => v.map((x) => (clamp ? Math.max(x, a) : x) + (c - a)); }
      if (has(b)) { b = +b; d = +d; return (v) => v.map((x) => (clamp ? Math.min(x, b) : x) + (d - b)); }
      return (v) => v.slice();
    };
    return op(build(minIn, maxIn, minOut, maxOut), build(minOut, maxOut, minIn, maxIn));
  }
  // ExponentTransform: forward y = x ^ value
  function exponentOp(g, style) {
    style = String(style || 'clamp').toLowerCase().replace(/[^a-z]/g, '');
    const pw = (x, e) => {
      if (style === 'mirror') return x < 0 ? -Math.pow(-x, e) : Math.pow(x, e);
      if (style === 'passthru') return x < 0 ? x : Math.pow(x, e);
      return Math.pow(Math.max(x, 0), e);
    };
    return op((v) => v.map((x, k) => pw(x, g[k])), (v) => v.map((x, k) => pw(x, 1 / g[k])), 'E' + g.join(',') + style);
  }
  // ExponentWithLinearTransform (moncurve): forward decodes, e.g. sRGB encoded -> linear
  function moncurveOp(gam, off, style) {
    const mirror = /mirror/i.test(String(style || ''));
    // Two edge cases where the usual formulas divide by zero: offset 0 is a plain power curve (the linear
    // part shrinks to nothing: values at or below 0 give 0), and gamma 1 is a straight line throughout.
    const P = [0, 1, 2].map((k) => {
      const g = gam[k], o = off[k];
      if (g === 1) return { g, o, line: true };
      if (!(o > 0)) return { g, o: 0, brk: 0, slope: 0, brkOut: 0 };
      const brk = o / (g - 1);
      const slope = (Math.pow((o * g) / ((g - 1) * (1 + o)), g) * (g - 1)) / o;
      return { g, o, brk, slope, brkOut: brk * slope };
    });
    const fw = (x, p) => (p.line ? (x + p.o) / (1 + p.o) : x <= p.brk ? x * p.slope : Math.pow((x + p.o) / (1 + p.o), p.g));
    const iv = (y, p) => (p.line ? y * (1 + p.o) - p.o : y <= p.brkOut ? (p.slope ? y / p.slope : 0) : (1 + p.o) * Math.pow(y, 1 / p.g) - p.o);
    const wrap = (fn) => (v) => v.map((x, k) => (mirror && x < 0 ? -fn(-x, P[k]) : fn(x, P[k])));
    return op(wrap(fw), wrap(iv), 'EL' + gam.join(',') + off.join(',') + mirror);
  }
  // LogAffine / LogCamera / Log: forward is linear -> log
  function logOp(base, gss, gso, lss, lso, brk, linSlope) {
    const lb = Math.log(base);
    const P = [0, 1, 2].map((k) => {
      const p = { gs: gss[k], go: gso[k], ls: lss[k], lo: lso[k] };
      if (brk) {
        p.brk = brk[k];
        p.lin = linSlope ? linSlope[k] : (p.gs * p.ls) / ((p.ls * p.brk + p.lo) * lb);
        p.logBrk = (p.gs * Math.log(p.ls * p.brk + p.lo)) / lb + p.go;
        p.linOff = p.logBrk - p.lin * p.brk;
      }
      return p;
    });
    const fw = (x, p) => (p.brk !== undefined && x <= p.brk ? p.lin * x + p.linOff : (p.gs * Math.log(Math.max(p.ls * x + p.lo, FLTMIN))) / lb + p.go);
    const iv = (y, p) => (p.brk !== undefined && y <= p.logBrk ? (y - p.linOff) / p.lin : (Math.pow(base, (y - p.go) / p.gs) - p.lo) / p.ls);
    return op((v) => v.map((x, k) => fw(x, P[k])), (v) => v.map((x, k) => iv(x, P[k])), 'L' + JSON.stringify([base, gss, gso, lss, lso, brk, linSlope]));
  }
  function cdlOp(slope, offset, power, sat, style) {
    const noClamp = /noclamp/i.test(String(style || ''));
    const W = [0.2126, 0.7152, 0.0722];
    const c01 = (x) => (noClamp ? x : Math.min(1, Math.max(0, x)));
    const pw = (x, e) => (noClamp ? (x < 0 ? x : Math.pow(x, e)) : Math.pow(Math.max(x, 0), e));
    const satf = (v, s) => { const l = W[0] * v[0] + W[1] * v[1] + W[2] * v[2]; return v.map((x) => l + s * (x - l)); };
    return keyed(op(
      (v) => satf(v.map((x, k) => pw(c01(x * slope[k] + offset[k]), power[k])).map(c01), sat).map(c01),
      (v) => satf(v.map(c01), 1 / sat).map(c01).map((x, k) => (pw(x, 1 / power[k]) - offset[k]) / slope[k]).map(c01),
    ), 'CDL' + [slope, offset, power, sat, noClamp].join(';'));
  }
  // GradingRGBCurve as OCIO's builtins use it: one master B-spline (control points + slopes)
  function curveOp(pts, slopes) {
    const pieces = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], m0 = slopes[i], m1 = slopes[i + 1], h = x1 - x0;
      const single = y0 + ((m0 + m1) * h) / 2;
      if (Math.abs(single - y1) <= 1e-5 * Math.max(1, Math.abs(y1))) {
        pieces.push({ x0, x1, c: y0, b: m0, a: (m1 - m0) / (2 * h) });
      } else {
        // two quadratics joined half way, matching both end slopes
        const s = ((4 * (y1 - y0)) / h - m0 - m1) / 2, xm = x0 + h / 2, ym = y0 + ((m0 + s) / 2) * (h / 2);
        pieces.push({ x0, x1: xm, c: y0, b: m0, a: (s - m0) / h });
        pieces.push({ x0: xm, x1, c: ym, b: s, a: (m1 - s) / h });
      }
    }
    const first = pts[0], last = pts[pts.length - 1], mF = slopes[0], mL = slopes[slopes.length - 1];
    const f1 = (x) => {
      if (x <= first[0]) return first[1] + mF * (x - first[0]);
      if (x >= last[0]) return last[1] + mL * (x - last[0]);
      let lo = 0, hi = pieces.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pieces[mid].x0 <= x) lo = mid; else hi = mid - 1; }
      const p = pieces[lo], t = x - p.x0;
      return p.c + t * (p.b + t * p.a);
    };
    const i1 = (y) => {
      // monotonic: bisection between the ends (flat ends map to the end point)
      if (y <= first[1]) return mF > 0 ? first[0] + (y - first[1]) / mF : first[0];
      if (y >= last[1]) return mL > 0 ? last[0] + (y - last[1]) / mL : last[0];
      let lo = first[0], hi = last[0];
      for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (f1(mid) < y) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    return op((v) => v.map(f1), (v) => v.map(i1), 'C' + JSON.stringify([pts, slopes]));
  }

  // --- named curves for the builtins OCIO stores as 1D LUTs
  const c01 = (x) => Math.min(1, Math.max(0, x));
  const mirror = (f) => (x) => (x < 0 ? -f(-x) : f(x));
  const acesccDecode = (x) => (x < (9.72 - 15) / 17.52 ? (Math.pow(2, x * 17.52 - 9.72) - Math.pow(2, -16)) * 2 : x < (Math.log2(65504) + 9.72) / 17.52 ? Math.pow(2, x * 17.52 - 9.72) : 65504);
  const appleLogDecode = (P) => {
      const R0 = -0.05641088, Rt = 0.01, c = 47.28711236, b = 0.00964052, g = 0.08550479, be = 0.69336945, Pt = c * (Rt - R0) * (Rt - R0);
      return P >= Pt ? Math.pow(2, (P - be) / g) - b : P >= 0 ? Math.sqrt(P / c) + R0 : R0;
  };
  const appleLogEncode = (R) => {
    const R0 = -0.05641088, Rt = 0.01, c = 47.28711236, b = 0.00964052, g = 0.08550479, be = 0.69336945;
    return R >= Rt ? g * Math.log2(R + b) + be : R >= R0 ? c * (R - R0) * (R - R0) : 0;
  };
  const CURVES = {
    acescc: (x) => acesccDecode(c01(x) * 1.86 - 0.36),
    appleLog: appleLogDecode,
    appleLogEnc: appleLogEncode,
    clog2: (x) => ((x = c01(x)), x < 0.092864125 ? -(Math.pow(10, (0.092864125 - x) / 0.24136077) - 1) / 87.09937546 : (Math.pow(10, (x - 0.092864125) / 0.24136077) - 1) / 87.09937546) * 0.9,
    clog3: (x) => ((x = c01(x)), x < 0.097465473 ? -(Math.pow(10, (0.12783901 - x) / 0.36726845) - 1) / 14.98325 : x <= 0.15277891 ? (x - 0.12512219) / 1.9754798 : (Math.pow(10, (x - 0.12240537) / 0.36726845) - 1) / 14.98325) * 0.9,
    pqDecode: mirror((N) => {
      const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
      const n = Math.pow(Math.max(N, 0), 1 / m2);
      return Math.pow(Math.max(n - c1, 0) / (c2 - c3 * n), 1 / m1) * 100;
    }),
    pqEncode: mirror((L) => {
      const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
      const y = Math.pow(Math.max(L, 0) / 100, m1);
      return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
    }),
    // OCIO's HLG curves take scene light scaled so 1.0 = 3x the HLG reference
    hlgEncode: mirror((x) => {
      const a = 0.17883277, b = 0.28466892, c = 0.55991073, E = x / 3;
      return E <= 1 / 12 ? Math.sqrt(3 * E) : a * Math.log(12 * E - b) + c;
    }),
    hlgDecode: mirror((x) => {
      const a = 0.17883277, b = 0.28466892, c = 0.55991073;
      return 3 * (x <= 0.5 ? (x * x) / 3 : (Math.exp((x - c) / a) + b) / 12);
    }),
    rollWhite918: (x) => rollWhite(x, 0.918, 0.5),
    rollWhite908: (x) => rollWhite(x, 0.908, 0.5),
  };
  function rollWhite(x, white, width) {
    const x0 = -1, x1 = x0 + width, y0 = -white, y1 = x1, m1 = x1 - x0;
    const a = y0 - y1 + m1, b = 2 * (y1 - y0) - m1, c = y0, t = (-x - x0) / (x1 - x0);
    if (t < 0) return -(t * b + c);
    if (t > 1) return x;
    return -((t * a + b) * t + c);
  }
  const INVERSE_CURVE = { pqDecode: 'pqEncode', pqEncode: 'pqDecode', hlgEncode: 'hlgDecode', hlgDecode: 'hlgEncode', appleLog: 'appleLogEnc' };
  function curveFnOp(name) {
    const f = CURVES[name];
    const inv = INVERSE_CURVE[name] ? CURVES[INVERSE_CURVE[name]] : null;
    const bounded = /^(acescc|clog2|clog3)$/.test(name); // curves that read a [0,1] table
    const solve = (y) => { // monotonic 1D inverse by bisection
      if (bounded) {
        if (y <= f(0)) return 0;
        if (y >= f(1)) return 1;
      }
      let lo = bounded ? 0 : -1, hi = 1;
      while (f(hi) < y && hi < 1e6) hi *= 2;
      while (f(lo) > y && lo > -1e6) lo *= 2;
      for (let k = 0; k < 100; k++) { const m = (lo + hi) / 2; if (f(m) < y) lo = m; else hi = m; }
      return (lo + hi) / 2;
    };
    return op((v) => v.map(f), (v) => v.map(inv || solve), 'CF' + name);
  }
  // which curve replaces the LUT1D in each builtin (by builtin style)
  const BUILTIN_CURVE = {
    'ACEScc_to_ACES2065-1': 'acescc',
    'APPLE_LOG_to_ACES2065-1': 'appleLog', 'CURVE - APPLE_LOG_to_LINEAR': 'appleLog',
    'CANON_CLOG2-CGAMUT_to_ACES2065-1': 'clog2', 'CURVE - CANON_CLOG2_to_LINEAR': 'clog2',
    'CANON_CLOG3-CGAMUT_to_ACES2065-1': 'clog3', 'CURVE - CANON_CLOG3_to_LINEAR': 'clog3',
    'CURVE - ST-2084_to_LINEAR': 'pqDecode', 'CURVE - LINEAR_to_ST-2084': 'pqEncode',
    'DISPLAY - CIE-XYZ-D65_to_REC.2100-PQ': 'pqEncode', 'DISPLAY - CIE-XYZ-D65_to_ST2084-P3-D65': 'pqEncode',
    'DISPLAY - CIE-XYZ-D65_to_ST2084-DCDM-D65': 'pqEncode',
    'CURVE - HLG-OETF': 'hlgEncode', 'CURVE - HLG-OETF-INVERSE': 'hlgDecode',
    'DISPLAY - CIE-XYZ-D65_to_REC.2100-HLG-1000nit': 'hlgEncode',
    'ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-CINEMA-D60sim-DCI_1.0': 'rollWhite918',
    'ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-CINEMA-D65sim-DCI_1.1': 'rollWhite908',
  };

  // ---------------------------------------------------------------- ACES 1.x fixed functions (OCIO 2.5)
  const rgbToYC = (r, g, b) => (b + g + r + 1.75 * Math.sqrt(b * (b - g) + g * (g - r) + r * (r - b))) / 3;
  const satWeight = (r, g, b) => (cmax(1e-10, Math.max(r, g, b)) - cmax(1e-10, Math.min(r, g, b))) / cmax(1e-2, Math.max(r, g, b));
  const sigmoid = (sat) => {
    const x = (sat - 0.4) * 5, sign = x < 0 ? -1 : 1, t = Math.max(0, 1 - 0.5 * sign * x);
    return (1 + sign * (1 - t * t)) * 0.5;
  };
  function glowOp(gain0, mid) {
    const run = (v, inverse) => {
      const [r, g, b] = v;
      const YC = rgbToYC(r, g, b), gain = gain0 * sigmoid(satWeight(r, g, b));
      let k;
      if (YC >= mid * 2) k = 0;
      else if (!inverse) k = YC <= (mid * 2) / 3 ? gain : gain * (mid / YC - 0.5);
      else k = YC <= ((1 + gain) * mid * 2) / 3 ? -gain / (1 + gain) : (gain * (mid / YC - 0.5)) / (gain * 0.5 - 1);
      return [r * (1 + k), g * (1 + k), b * (1 + k)];
    };
    return op((v) => run(v, false), (v) => run(v, true));
  }
  function redModOp() {
    const oneMinusScale = 1 - 0.82, pivot = 0.03, invWidth = 1.6976527263135504;
    const M = [[0.25, 0, 0, 0], [-0.75, 0.75, 0.75, 0.25], [0.75, -1.5, 0, 1], [-0.25, 0.75, -0.75, 0.25]];
    const hueWeight = (r, g, b) => {
      const hue = Math.atan2(Math.sqrt(3) * (g - b), 2 * r - (g + b));
      const kc = hue * invWidth + 2, j = Math.trunc(kc);
      if (j < 0 || j >= 4) return 0;
      const t = kc - j, c = M[j];
      return c[3] + t * (c[2] + t * (c[1] + t * c[0]));
    };
    return op(
      (v) => {
        let [r, g, b] = v;
        const fH = hueWeight(r, g, b);
        if (fH > 0) r = r + fH * satWeight(r, g, b) * (pivot - r) * oneMinusScale;
        return [r, g, b];
      },
      (v) => {
        let [r, g, b] = v;
        const fH = hueWeight(r, g, b);
        if (fH > 0) {
          const mn = g < b ? g : b;
          const qa = fH * oneMinusScale - 1, qb = r - fH * (pivot + mn) * oneMinusScale, qc = fH * pivot * mn * oneMinusScale;
          r = (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
        }
        return [r, g, b];
      },
    );
  }
  function darkToDimOp() {
    const run = (v, gamma) => {
      const Y = cmax(1e-10, 0.27222871678091454 * v[0] + 0.67408176581114831 * v[1] + 0.053689517407937051 * v[2]);
      const k = Math.pow(Y, gamma - 1);
      return [v[0] * k, v[1] * k, v[2] * k];
    };
    return op((v) => run(v, 0.9811), (v) => run(v, 1.0192640913260627));
  }
  function gamutComp13Op(p) {
    const lim = [p[0], p[1], p[2]], thr = [p[3], p[4], p[5]], power = p[6];
    const scale = lim.map((l, k) => (l - thr[k]) / Math.pow(Math.pow((1 - thr[k]) / (l - thr[k]), -power) - 1, 1 / power));
    const compress = (d, t, s) => { const nd = (d - t) / s; return t + (s * nd) / Math.pow(1 + Math.pow(nd, power), 1 / power); };
    const uncompress = (d, t, s) => {
      if (d >= t + s) return d;
      const nd = (d - t) / s, q = Math.pow(nd, power);
      return t + s * Math.pow(-(q / (q - 1)), 1 / power);
    };
    const run = (v, fn) => {
      const ach = Math.max(v[0], v[1], v[2]);
      return v.map((x, k) => {
        if (ach === 0) return 0;
        const dist = (ach - x) / Math.abs(ach);
        if (dist < thr[k]) return x;
        return ach - fn(dist, thr[k], scale[k]) * Math.abs(ach);
      });
    };
    return op((v) => run(v, compress), (v) => run(v, uncompress));
  }
  function surroundOp(gamma) {
    const run = (v, g, minLum) => {
      const Y = Math.max(minLum, Math.abs(0.2627 * v[0] + 0.678 * v[1] + 0.0593 * v[2]));
      const k = Math.pow(Y, g - 1);
      return [v[0] * k, v[1] * k, v[2] * k];
    };
    return op((v) => run(v, gamma, 1e-4), (v) => run(v, 1 / gamma, Math.pow(1e-4, gamma)));
  }

  // ---------------------------------------------------------------- ACES 2.0 output transform (OCIO 2.5)
  const ACES2 = (() => {
    const AP0 = [[0.7347, 0.2653], [0, 1], [0.0001, -0.077], [0.32168, 0.33767]];
    const AP1 = [[0.713, 0.293], [0.165, 0.83], [0.128, 0.044], [0.32168, 0.33767]];
    const CAM16 = [[0.8336, 0.1735], [2.3854, -1.4659], [0.087, -0.125], [0.333, 0.333]];
    const refLum = 100, L_A = 100, Y_b = 20, surround = [0.9, 0.59, 0.9];
    const nlOffset = 0.2713 * 100, nlScale = 4 * 100;
    const smoothCusps = 0.12, smoothM = 0.27, cuspMidBlend = 1.3, focusGainBlend = 0.3;
    const focusDistance = 1.35, focusDistanceScaling = 1.75, compressionThreshold = 0.75;
    const N = 360, UPPER = 361;

    const wrapHue = (h) => { const y = h % 360; return y < 0 ? y + 360 : y; };
    const compFwd1 = (Rc) => { const F = Math.pow(Rc, 0.42); return F / (nlOffset + F); };
    const compInv1 = (Ra) => { const R = Math.min(Ra, 0.99); return Math.pow((nlOffset * R) / (1 - R), 1 / 0.42); };
    const compFwd = (v) => (v < 0 ? -compFwd1(-v) : compFwd1(v));
    const compInv = (v) => (v < 0 ? -compInv1(-v) : compInv1(v));
    const modelGamma = () => surround[1] * (1.48 + Math.sqrt(Y_b / refLum));

    function jmhParams(prims) {
      const base = [2, 1, 1 / 20, 1, -12 / 11, 1 / 11, 1 / 9, 1 / 9, -2 / 9];
      const M16 = m3inv(npm(CAM16));
      const XYZ_w = m3mul(npm(prims), [refLum, refLum, refLum]);
      const Y_W = XYZ_w[1];
      const RGB_w = m3mul(M16, XYZ_w);
      const K = 1 / (5 * L_A + 1), K4 = K * K * K * K;
      const F_L = 0.2 * K4 * (5 * L_A) + 0.1 * Math.pow(1 - K4, 2) * Math.pow(5 * L_A, 1 / 3);
      const F_L_n = F_L / refLum, cz = modelGamma();
      const D = RGB_w.map((w) => (F_L_n * Y_W) / w);
      const RGB_AW = RGB_w.map((w, k) => compFwd(D[k] * w));
      const cr = base.map((x) => x * nlScale);
      const A_w = cr[0] * RGB_AW[0] + cr[1] * RGB_AW[1] + cr[2] * RGB_AW[2];
      const A_w_J = compFwd1(F_L);
      const toCam = m3m3(m3m3(M16, npm(prims)), [refLum, 0, 0, 0, refLum, 0, 0, 0, refLum]);
      const toCamC = m3m3([D[0], 0, 0, 0, D[1], 0, 0, 0, D[2]], toCam);
      const s = 43 * surround[2];
      const toAab = [cr[0] / A_w, cr[1] / A_w, cr[2] / A_w, cr[3] * s, cr[4] * s, cr[5] * s, cr[6] * s, cr[7] * s, cr[8] * s];
      return { toCamC, fromCamC: m3inv(toCamC), toAab, fromAab: m3inv(toAab), F_L_n, cz, inv_cz: 1 / cz, A_w_J, inv_A_w_J: 1 / A_w_J };
    }
    const RGB_to_Aab = (rgb, p) => m3mul(p.toAab, m3mul(p.toCamC, rgb).map(compFwd));
    const Aab_to_JMh = (A, p) => {
      if (A[0] <= 0) return [0, 0, 0];
      return [100 * Math.pow(A[0], p.cz), Math.sqrt(A[1] * A[1] + A[2] * A[2]), wrapHue((180 * Math.atan2(A[2], A[1])) / Math.PI)];
    };
    const RGB_to_JMh = (rgb, p) => Aab_to_JMh(RGB_to_Aab(rgb, p), p);
    const JMh_to_Aab = (JMh, c, s, p) => [Math.pow(JMh[0] / 100, p.inv_cz), JMh[1] * c, JMh[1] * s];
    const Aab_to_RGB = (A, p) => m3mul(p.fromCamC, m3mul(p.fromAab, A).map(compInv));
    const JMh_to_RGB = (JMh, p) => { const h = (Math.PI * JMh[2]) / 180; return Aab_to_RGB(JMh_to_Aab(JMh, Math.cos(h), Math.sin(h), p), p); };
    const A_to_Y = (A, p) => compInv1(p.A_w_J * A) / p.F_L_n;
    const Y_to_J_abs = (Y, p) => 100 * Math.pow(compFwd1(Y * p.F_L_n) * p.inv_A_w_J, p.cz);
    const Y_to_J = (Y, p) => (Y < 0 ? -Y_to_J_abs(-Y, p) : Y_to_J_abs(Y, p));
    const J_to_Y = (J, p) => A_to_Y(Math.pow(J / 100, p.inv_cz), p);

    function toneParams(peak) {
      const n = peak, n_r = 100, g = 1.15, c = 0.18, c_d = 10.013, w_g = 0.14, t_1 = 0.04, rMin = 128, rMax = 896;
      const r_hit = rMin + (rMax - rMin) * (Math.log(n / n_r) / Math.log(10000 / 100));
      const m_0 = n / n_r, m_1 = 0.5 * (m_0 + Math.sqrt(m_0 * (m_0 + 4 * t_1)));
      const u = Math.pow(r_hit / m_1 / (r_hit / m_1 + 1), g), m = m_1 / u;
      const w_i = Math.log(n / 100) / Math.log(2), c_t = (c_d / n_r) * (1 + w_i * w_g);
      const g_ip = 0.5 * (c_t + Math.sqrt(c_t * (c_t + 4 * t_1)));
      const g_ipp2 = -(m_1 * Math.pow(g_ip / m, 1 / g)) / (Math.pow(g_ip / m, 1 / g) - 1);
      const w_2 = c / g_ipp2, s_2 = w_2 * m_1 * refLum, u_2 = Math.pow(r_hit / m_1 / (r_hit / m_1 + w_2), g), m_2 = m_1 / u_2;
      return { n, n_r, g, t_1, c_t, s_2, u_2, m_2, forward_limit: 8 * r_hit, inverse_limit: n / (u_2 * n_r), log_peak: Math.log10(n / n_r) };
    }
    const tonescaleY = (Y, t, inverse) => {
      if (inverse) {
        const Z = cmax(0, cmin(t.inverse_limit, Y / refLum));
        const f = (Z + Math.sqrt(Z * (4 * t.t_1 + Z))) / 2;
        return t.s_2 / (Math.pow(t.m_2 / f, 1 / t.g) - 1);
      }
      const f = t.m_2 * Math.pow(Y / (Y + t.s_2), t.g);
      return cmax(0, (f * f) / (f + t.t_1)) * t.n_r;
    };
    const toeFwd = (x, limit, k1in, k2in) => {
      if (x > limit) return x;
      const k2 = Math.max(k2in, 0.001), k1 = Math.sqrt(k1in * k1in + k2 * k2), k3 = (limit + k1) / (limit + k2);
      const mb = k3 * x - k1, mac = k2 * k3 * x;
      return 0.5 * (mb + Math.sqrt(mb * mb + 4 * mac));
    };
    const toeInv = (x, limit, k1in, k2in) => {
      if (x > limit) return x;
      const k2 = Math.max(k2in, 0.001), k1 = Math.sqrt(k1in * k1in + k2 * k2), k3 = (limit + k1) / (limit + k2);
      return (x * x + k1 * x) / (k3 * (x + k2));
    };
    const chromaNorm = (c, s, scale) => {
      const c2 = 2 * c * c - 1, s2 = 2 * c * s, c3 = 4 * c * c * c - 3 * c, s3 = 3 * s - 4 * s * s * s;
      return (11.34072 * c + 16.46899 * c2 + 7.8838 * c3 + 14.66441 * s + -6.37224 * s2 + 9.19364 * s3 + 77.12896) * scale;
    };
    function chromaFwd(JMh, J_ts, Mnorm, r, pc) {
      const J = JMh[0], M = JMh[1];
      let Mc = M;
      if (M !== 0) {
        const nJ = J_ts / r.limit_J_max, snJ = Math.max(0, 1 - nJ);
        const limit = (Math.pow(nJ, r.model_gamma_inv) * r.reachMaxM) / Mnorm;
        Mc = (M * Math.pow(J_ts / J, r.model_gamma_inv)) / Mnorm;
        Mc = limit - toeFwd(limit - Mc, limit - 0.001, snJ * pc.sat, Math.sqrt(nJ * nJ + pc.sat_thr));
        Mc = toeFwd(Mc, limit, nJ * pc.compr, snJ) * Mnorm;
      }
      return [J_ts, Mc, JMh[2]];
    }
    function chromaInv(JMh, J, Mnorm, r, pc) {
      const J_ts = JMh[0], Mc = JMh[1];
      let M = Mc;
      if (Mc !== 0) {
        const nJ = J_ts / r.limit_J_max, snJ = Math.max(0, 1 - nJ);
        const limit = (Math.pow(nJ, r.model_gamma_inv) * r.reachMaxM) / Mnorm;
        M = toeInv(Mc / Mnorm, limit, nJ * pc.compr, snJ);
        M = limit - toeInv(limit - M, limit - 0.001, snJ * pc.sat, Math.sqrt(nJ * nJ + pc.sat_thr));
        M = M * Mnorm * Math.pow(J_ts / J, -r.model_gamma_inv);
      }
      return [J, M, JMh[2]];
    }
    const cornerRGB = (c) => [((c + 1) % 6) < 3 ? 1 : 0, ((c + 5) % 6) < 3 ? 1 : 0, ((c + 3) % 6) < 3 ? 1 : 0];
    const focusGain = (J, thr, limitJ, dist) => {
      let gain = limitJ * dist;
      if (J > thr) { let adj = Math.log10((limitJ - thr) / Math.max(0.0001, limitJ - J)); adj = adj * adj + 1; gain *= adj; }
      return gain;
    };
    const solveJIntersect = (J, M, focusJ, maxJ, slopeGain) => {
      const Ms = M / slopeGain, a = Ms / focusJ;
      if (J < focusJ) { const b = 1 - Ms, c = -J; return (-2 * c) / (b + Math.sqrt(b * b - 4 * a * c)); }
      const b = -(1 + Ms + maxJ * a), c = maxJ * Ms + J;
      return (-2 * c) / (b - Math.sqrt(b * b - 4 * a * c));
    };
    const sminScaled = (a, b, ref) => { const s = smoothCusps * ref, h = Math.max(s - Math.abs(a - b), 0) / s; return Math.min(a, b) - h * h * h * s * (1 / 6); };
    const vectorSlope = (Ji, focusJ, limitJ, slopeGain) => ((Ji < focusJ ? Ji : limitJ - Ji) * (Ji - focusJ)) / (focusJ * slopeGain);
    const lineBoundaryM = (Jaxis, slope, invGamma, Jmax, Mmax, Jref) => {
      const shifted = Jref * Math.pow(Jaxis / Jref, invGamma);
      return (shifted * Mmax) / (Jmax - slope * Mmax);
    };
    const boundaryIntersection = (cusp, Jmax, gTopInv, gBotInv, JiSource, slope, JiCusp) => {
      const lower = lineBoundaryM(JiSource, slope, gBotInv, cusp[0], cusp[1], JiCusp);
      const upper = lineBoundaryM(Jmax - JiSource, -slope, gTopInv, Jmax - cusp[0], cusp[1], Jmax - JiCusp);
      return sminScaled(lower, upper, cusp[1]);
    };
    const remapM = (M, gamutM, reachM, invert) => {
      const proportion = Math.max(gamutM / reachM, compressionThreshold), threshold = proportion * gamutM;
      if (M <= threshold || proportion >= 1) return M;
      const mOff = M - threshold, gOff = gamutM - threshold, rOff = reachM - threshold;
      const scale = rOff / (rOff / gOff - 1), nd = mOff / scale;
      if (invert) return threshold + (nd >= 1 ? scale : scale * -(nd / (nd - 1)));
      return threshold + (scale * nd) / (1 + nd);
    };
    const focusJof = (cuspJ, midJ, limitJ) => lerp(cuspJ, midJ, Math.min(1, cuspMidBlend - cuspJ / limitJ));

    function make(params) {
      const peak = params[0];
      const lim = [[params[1], params[2]], [params[3], params[4]], [params[5], params[6]], [params[7], params[8]]];
      const pIn = jmhParams(AP0), pOut = jmhParams(lim), reach = jmhParams(AP1);
      const t = toneParams(peak);
      const limit_J_max = Y_to_J(peak, pIn), model_gamma_inv = 1 / modelGamma();
      // reach table: M at limit_J_max where AP1 goes negative, per whole degree
      const reachTable = new Array(UPPER + 1).fill(0);
      for (let i = 0; i < N; i++) {
        const hue = i;
        let low = 0, high = 50, outside = false;
        while (!outside && high < 1300) {
          const rgb = JMh_to_RGB([limit_J_max, high, hue], reach);
          outside = rgb[0] < 0 || rgb[1] < 0 || rgb[2] < 0;
          if (!outside) { low = high; high += 50; }
        }
        while (high - low > 1e-2) {
          const m = (high + low) / 2, rgb = JMh_to_RGB([limit_J_max, m, hue], reach);
          if (rgb[0] < 0 || rgb[1] < 0 || rgb[2] < 0) high = m; else low = m;
        }
        reachTable[i + 1] = high;
      }
      reachTable[0] = reachTable[N];
      reachTable[UPPER] = reachTable[1];
      const reachMAt = (h) => { const base = Math.trunc(h), f = h - base; return lerp(reachTable[base + 1], reachTable[base + 2], f); };
      const pc = {
        compr: 2.4 + 2.4 * 3.3 * t.log_peak,
        sat: Math.max(0.2, 1.3 - 1.3 * 0.69 * t.log_peak),
        sat_thr: 0.5 / t.n,
        scale: Math.pow(0.03379 * peak, 0.30596) - 0.45135,
      };
      const mid_J = Y_to_J(t.c_t * refLum, pIn);
      const focus_dist = focusDistance + focusDistance * focusDistanceScaling * t.log_peak;
      const lowerGammaInv = 1 / (1.14 + 0.07 * t.log_peak);

      // --- hue table and cusp table, sampled to hit the gamut corners exactly
      const rotate = (rgbs, jmhs) => {
        let minI = 0;
        for (let i = 0; i < 6; i++) if (jmhs[i][2] < jmhs[minI][2]) minI = i;
        const R = new Array(8), J = new Array(8);
        for (let i = 0; i < 6; i++) { R[i + 1] = rgbs && rgbs[(i + minI) % 6]; J[i + 1] = jmhs[(i + minI) % 6].slice(); }
        R[0] = R[6]; R[7] = R[1];
        J[0] = J[6].slice(); J[7] = J[1].slice();
        J[0][2] -= 360; J[7][2] += 360;
        return [R, J];
      };
      // reach corners
      const limitA = Math.pow(limit_J_max / 100, reach.inv_cz);
      const reachJ = [];
      for (let i = 0; i < 6; i++) {
        const v = cornerRGB(i);
        let lower = 0, upper = t.forward_limit;
        while (upper - lower > 1e-3) {
          const test = (lower + upper) / 2, A = RGB_to_Aab(v.map((x) => x * test), reach)[0];
          if (A < limitA) lower = test; else upper = test;
          if (A === limitA) break;
        }
        reachJ.push(RGB_to_JMh(v.map((x) => x * upper), reach));
      }
      const reachJMh = rotate(null, reachJ)[1];
      // limiting (display) cusp corners
      const limRGB0 = [], limJ0 = [];
      for (let i = 0; i < 6; i++) { const v = cornerRGB(i).map((x) => (x * peak) / refLum); limRGB0.push(v); limJ0.push(RGB_to_JMh(v, pOut)); }
      const [limRGB, limJMh] = rotate(limRGB0, limJ0);
      // merge the two sorted hue lists
      const sorted = [];
      let ri = 1, di = 1;
      while (ri < 7 || di < 7) {
        const rh = reachJMh[ri][2], dh = limJMh[di][2];
        if (rh === dh) { sorted.push(rh); ri++; di++; } else if (rh < dh) { sorted.push(rh); ri++; } else { sorted.push(dh); di++; }
      }
      const unique = sorted.length;
      const hueTable = new Array(UPPER + 1).fill(0);
      const counts = new Array(14).fill(0);
      let lastIdx = -1, minIndex = sorted[0] === 0 ? 0 : 1;
      for (let h = 0; h < unique; h++) {
        let nominal = Math.min(Math.max(Math.round(sorted[h]), minIndex), N - 1);
        if (lastIdx === nominal) {
          if (h > 1 && counts[h - 2] !== counts[h - 1] - 1) counts[h - 1] = counts[h - 1] - 1;
          else nominal = nominal + 1;
        }
        counts[h] = Math.min(nominal, N - 1);
        lastIdx = minIndex = nominal;
      }
      const fill = (samples, lower, upper, base) => { const d = (upper - lower) / samples; for (let i = 0; i < samples; i++) hueTable[base + i] = lower + i * d; };
      let total = 0, ii = 0;
      fill(counts[0], 0, sorted[0], total + 1);
      total += counts[0];
      for (ii = 1; ii < unique; ii++) { const sm = counts[ii] - counts[ii - 1]; fill(sm, sorted[ii - 1], sorted[ii], total + 1); total += sm; }
      fill(N - total, sorted[ii - 1], 360, total + 1);
      hueTable[0] = hueTable[N] - 360;
      hueTable[UPPER] = hueTable[1] + 360;
      // cusp of the limiting gamut for each table hue
      const cusp = new Array(UPPER + 1);
      const prev = [0, 0];
      for (let i = 1; i < UPPER; i++) {
        const hue = hueTable[i];
        let upperC = 1;
        for (let k = 1; k < 8; k++) if (limJMh[k][2] > hue) { upperC = k; break; }
        const lowerC = upperC - 1;
        let JM;
        if (limJMh[lowerC][2] === hue) JM = [limJMh[lowerC][0], limJMh[lowerC][1]];
        else {
          const a = limRGB[lowerC], b = limRGB[upperC];
          let lo = upperC === prev[0] ? prev[1] : 0, hi = 1, st;
          while (hi - lo > 1e-7) {
            st = (lo + hi) / 2;
            const J = RGB_to_JMh([lerp(a[0], b[0], st), lerp(a[1], b[1], st), lerp(a[2], b[2], st)], pOut);
            if (J[2] < limJMh[lowerC][2]) hi = st;
            else if (J[2] >= limJMh[upperC][2]) lo = st;
            else if (J[2] > hue) hi = st;
            else lo = st;
          }
          st = (lo + hi) / 2;
          const J = RGB_to_JMh([lerp(a[0], b[0], st), lerp(a[1], b[1], st), lerp(a[2], b[2], st)], pOut);
          prev[0] = upperC; prev[1] = st;
          JM = [J[0], J[1]];
        }
        cusp[i] = [JM[0], JM[1] * (1 + smoothM * smoothCusps), hue];
      }
      cusp[0] = [cusp[N][0], cusp[N][1], hueTable[0]];
      cusp[UPPER] = [cusp[1][0], cusp[1][1], hueTable[UPPER]];
      const searchRange = [0, 1];
      for (let i = 1; i < UPPER; i++) {
        const d = i - (1 + Math.trunc(cusp[i][2]));
        searchRange[0] = Math.min(searchRange[0], d);
        searchRange[1] = Math.max(searchRange[1], d + 1);
      }
      // upper hull gamma per hue
      const lumLimit = peak / refLum;
      for (let i = 1; i < UPPER; i++) {
        const hue = hueTable[i], cJM = [cusp[i][0], cusp[i][1]];
        const thrA = lerp(cJM[0], limit_J_max, focusGainBlend), fJ = focusJof(cJM[0], mid_J, limit_J_max);
        const tests = [0.01, 0.1, 0.5, 0.8, 0.99].map((pos) => {
          const testJ = lerp(cJM[0], limit_J_max, pos);
          const sg = focusGain(testJ, thrA, limit_J_max, focus_dist);
          const Jis = solveJIntersect(testJ, cJM[1], fJ, limit_J_max, sg);
          return { Jis, slope: vectorSlope(Jis, fJ, limit_J_max, sg), Jic: solveJIntersect(cJM[0], cJM[1], fJ, limit_J_max, sg) };
        });
        const fits = (gamma) => {
          const gInv = 1 / gamma;
          for (const d of tests) {
            const M = boundaryIntersection(cJM, limit_J_max, gInv, lowerGammaInv, d.Jis, d.slope, d.Jic);
            const rgb = JMh_to_RGB([d.Jis + d.slope * M, M, hue], pOut);
            if (!(rgb[0] > lumLimit || rgb[1] > lumLimit || rgb[2] > lumLimit)) return false;
          }
          return true;
        };
        let low = 0, high = 0.4, found = false;
        while (!found && high < 5) { if (!fits(high)) { low = high; high += 0.4; } else found = true; }
        while (high - low > 1e-5) { const g = (high + low) / 2; if (fits(g)) high = g; else low = g; }
        cusp[i][2] = 1 / high;
      }
      cusp[0][2] = cusp[N][2];
      cusp[UPPER][2] = cusp[1][2];

      const hueParams = (hue) => {
        let i = 1 + Math.trunc(hue);
        let lo = Math.max(0, i + searchRange[0]), hi = Math.min(UPPER, i + searchRange[1]);
        while (lo + 1 < hi) { if (hue > hueTable[i]) lo = i; else hi = i; i = (lo + hi) >> 1; }
        hi = Math.max(1, hi);
        const w = (hue - hueTable[hi - 1]) / (hueTable[hi] - hueTable[hi - 1]);
        const c = [lerp(cusp[hi - 1][0], cusp[hi][0], w), lerp(cusp[hi - 1][1], cusp[hi][1], w), lerp(cusp[hi - 1][2], cusp[hi][2], w)];
        return { JMcusp: [c[0], c[1]], gTopInv: c[2], focusJ: focusJof(c[0], mid_J, limit_J_max), thr: lerp(c[0], limit_J_max, focusGainBlend) };
      };
      const compressGamut = (JMh, Jx, r, hp, invert) => {
        const [J, M, h] = JMh;
        const sg = focusGain(Jx, hp.thr, r.limit_J_max, focus_dist);
        const Jis = solveJIntersect(J, M, hp.focusJ, r.limit_J_max, sg);
        const slope = vectorSlope(Jis, hp.focusJ, r.limit_J_max, sg);
        const Jic = solveJIntersect(hp.JMcusp[0], hp.JMcusp[1], hp.focusJ, r.limit_J_max, sg);
        const gM = boundaryIntersection(hp.JMcusp, r.limit_J_max, hp.gTopInv, lowerGammaInv, Jis, slope, Jic);
        if (gM <= 0) return [J, 0, h];
        const rM = lineBoundaryM(Jis, slope, r.model_gamma_inv, r.limit_J_max, r.reachMaxM, r.limit_J_max);
        const Mr = remapM(M, gM, rM, invert);
        return [Jis + Mr * slope, Mr, h];
      };
      const gamutFwd = (JMh, r) => {
        if (JMh[0] <= 0) return [0, 0, JMh[2]];
        if (JMh[1] <= 0 || JMh[0] > r.limit_J_max) return [JMh[0], 0, JMh[2]];
        return compressGamut(JMh, JMh[0], r, hueParams(JMh[2]), false);
      };
      const gamutInv = (JMh, r) => {
        if (JMh[0] <= 0) return [0, 0, JMh[2]];
        if (JMh[1] <= 0 || JMh[0] > r.limit_J_max) return [JMh[0], 0, JMh[2]];
        const hp = hueParams(JMh[2]);
        let Jx = JMh[0];
        if (Jx > hp.thr) Jx = compressGamut(JMh, Jx, r, hp, true)[0];
        return compressGamut(JMh, Jx, r, hp, true);
      };
      const resolved = (h) => ({ limit_J_max, model_gamma_inv, reachMaxM: reachMAt(h) });
      const fwd = (rgb) => {
        const Aab = RGB_to_Aab(rgb, pIn), JMh = Aab_to_JMh(Aab, pIn);
        const r = resolved(JMh[2]), hr = (Math.PI * JMh[2]) / 180, c = Math.cos(hr), s = Math.sin(hr);
        const Mnorm = chromaNorm(c, s, pc.scale);
        const Yin = A_to_Y(Aab[0], pIn), Yout = tonescaleY(Yin, t, false);
        let Jts = Y_to_J_abs(Yout, pIn);
        if (Aab[0] < 0 || Object.is(Aab[0], -0)) Jts = -Jts;
        const tm = chromaFwd(JMh, Jts, Mnorm, r, pc);
        const cm = gamutFwd(tm, r);
        return Aab_to_RGB(JMh_to_Aab(cm, c, s, pOut), pOut);
      };
      const inv = (rgb) => {
        const cm = RGB_to_JMh(rgb, pOut);
        const r = resolved(cm[2]), hr = (Math.PI * cm[2]) / 180, c = Math.cos(hr), s = Math.sin(hr);
        const Mnorm = chromaNorm(c, s, pc.scale);
        const tm = gamutInv(cm, r);
        const Jabs = Math.abs(tm[0]);
        let J = Y_to_J_abs(tonescaleY(J_to_Y(Jabs, pIn), t, true), pIn);
        if (tm[0] < 0) J = -J;
        const JMh = chromaInv(tm, J, Mnorm, r, pc);
        return Aab_to_RGB(JMh_to_Aab(JMh, c, s, pIn), pIn);
      };
      return op(fwd, inv);
    }
    const cache = new Map();
    return (params) => {
      const key = params.join(',');
      if (!cache.has(key)) cache.set(key, make(params.map(Number)));
      return cache.get(key);
    };
  })();

  function fixedFunctionOp(style, params) {
    const s = String(style).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return keyed(fixedFunctionOp0(s, style, params), 'FF' + s + (params || []).join(','));
  }
  function fixedFunctionOp0(s, style, params) {
    if (s === 'ACESREDMOD10') return redModOp();
    if (s === 'ACESGLOW10') return glowOp(0.05, 0.08);
    if (s === 'ACESGLOW03') return glowOp(0.075, 0.1);
    if (s === 'ACESDARKTODIM10') return darkToDimOp();
    if (s === 'ACESGAMUTCOMP13') return gamutComp13Op((params || []).map(Number));
    if (s === 'ACESOUTPUTTRANSFORM20' || s === 'ACES2OUTPUTTRANSFORM') return ACES2(params || []);
    if (s === 'REC2100SURROUND') return surroundOp(num(params && params[0], 0.78));
    throw new Unsupported('It uses the fixed function ' + style + ', which ASTROLABE can’t calculate yet.');
  }

  // ---------------------------------------------------------------- builtin transforms
  function builtinOps(style) {
    const key = Object.keys(BUILTINS).find((k) => k.toLowerCase() === String(style).trim().toLowerCase());
    if (!key) throw new Unsupported('It uses the builtin transform "' + style + '", which ASTROLABE can’t calculate yet.');
    const ops = [];
    for (const o of BUILTINS[key]) {
      let x;
      switch (o[0]) {
        case 'M': x = matrixOp(o[2], o[3]); break;
        case 'R': x = rangeOp(o[2][0], o[2][1], o[2][2], o[2][3], o[3] === 0); break;
        case 'L': x = logOp(o[2], [1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0]); break;
        case 'LA': x = logOp(o[2], o[3], o[4], o[5], o[6]); break;
        case 'LC': x = logOp(o[2], o[3], o[4], o[5], o[6], o[7], o[8]); break;
        case 'E': x = exponentOp(o[2], o[3]); break;
        case 'EL': x = moncurveOp(o[2], o[3], o[4]); break;
        case 'FF': x = fixedFunctionOp(o[2], o[3]); break;
        case 'CURVE': x = curveOp(o[2], o[3]); break;
        case 'LUT1D':
          if (!BUILTIN_CURVE[key]) throw new Unsupported('It uses the builtin transform "' + key + '", which ASTROLABE can’t calculate yet.');
          x = curveFnOp(BUILTIN_CURVE[key]);
          break;
        default: throw new Unsupported('It uses a builtin step (' + o[0] + ') ASTROLABE can’t calculate yet.');
      }
      ops.push(o[1] ? invOp(x) : x);
    }
    return ops;
  }

  // ---------------------------------------------------------------- LUT files
  function lut1dOp(tables, dmin, dmax) {
    // tables: 3 arrays of samples over [dmin, dmax]
    const n = tables[0].length;
    const fwd1 = (x, k) => {
      const t = ((x - dmin[k]) / (dmax[k] - dmin[k])) * (n - 1);
      if (!(t > 0)) return tables[k][0];
      if (t >= n - 1) return tables[k][n - 1];
      const i = Math.floor(t), f = t - i;
      return tables[k][i] + f * (tables[k][i + 1] - tables[k][i]);
    };
    const inv1 = (y, k) => {
      const T = tables[k], up = T[n - 1] >= T[0];
      const lo0 = up ? T[0] : T[n - 1], hi0 = up ? T[n - 1] : T[0];
      if (y <= lo0) return up ? dmin[k] : dmax[k];
      if (y >= hi0) return up ? dmax[k] : dmin[k];
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((T[m] < y) === up) lo = m; else hi = m; }
      const d = T[hi] - T[lo], f = d ? (y - T[lo]) / d : 0;
      return dmin[k] + ((lo + f) / (n - 1)) * (dmax[k] - dmin[k]);
    };
    const o = op((v) => v.map(fwd1), (v) => v.map(inv1));
    const tmin = tables.map((T) => Math.min(T[0], T[n - 1])), tmax = tables.map((T) => Math.max(T[0], T[n - 1]));
    const clampTo = (lo, hi) => op((v) => v.map((x, k) => Math.min(Math.max(x, lo[k]), hi[k])));
    o.pair = (invFirst) => (invFirst ? clampTo(tmin, tmax) : clampTo(dmin, dmax));
    return o;
  }
  // data: Float64Array of n^3 * 3, index ((b * n + g) * n + r) * 3 (red fastest)
  function lut3dOp(n, data, dmin, dmax, interp) {
    const tetra = /tetra|best/i.test(String(interp || ''));
    const at = (r, g, b, c) => data[((b * n + g) * n + r) * 3 + c];
    const fwd = (v) => {
      const p = v.map((x, k) => {
        const t = ((x - dmin[k]) / (dmax[k] - dmin[k])) * (n - 1);
        return Number.isFinite(t) ? Math.min(Math.max(t, 0), n - 1) : 0;
      });
      const i = p.map((x) => Math.min(Math.floor(x), n - 2)), f = p.map((x, k) => x - i[k]);
      const [r0, g0, b0] = i, [fr, fg, fb] = f, r1 = r0 + 1, g1 = g0 + 1, b1 = b0 + 1;
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        if (!tetra) {
          const c00 = lerp(at(r0, g0, b0, c), at(r1, g0, b0, c), fr), c10 = lerp(at(r0, g1, b0, c), at(r1, g1, b0, c), fr);
          const c01 = lerp(at(r0, g0, b1, c), at(r1, g0, b1, c), fr), c11 = lerp(at(r0, g1, b1, c), at(r1, g1, b1, c), fr);
          out[c] = lerp(lerp(c00, c10, fg), lerp(c01, c11, fg), fb);
        } else {
          const v000 = at(r0, g0, b0, c), v111 = at(r1, g1, b1, c);
          if (fr > fg) {
            if (fg > fb) out[c] = (1 - fr) * v000 + (fr - fg) * at(r1, g0, b0, c) + (fg - fb) * at(r1, g1, b0, c) + fb * v111;
            else if (fr > fb) out[c] = (1 - fr) * v000 + (fr - fb) * at(r1, g0, b0, c) + (fb - fg) * at(r1, g0, b1, c) + fg * v111;
            else out[c] = (1 - fb) * v000 + (fb - fr) * at(r0, g0, b1, c) + (fr - fg) * at(r1, g0, b1, c) + fg * v111;
          } else {
            if (fb > fg) out[c] = (1 - fb) * v000 + (fb - fg) * at(r0, g0, b1, c) + (fg - fr) * at(r0, g1, b1, c) + fr * v111;
            else if (fb > fr) out[c] = (1 - fg) * v000 + (fg - fb) * at(r0, g1, b0, c) + (fb - fr) * at(r0, g1, b1, c) + fr * v111;
            else out[c] = (1 - fg) * v000 + (fg - fr) * at(r0, g1, b0, c) + (fr - fb) * at(r1, g1, b0, c) + fb * v111;
          }
        }
      }
      return out;
    };
    const nodes = n * n * n;
    // inverse: start from the grid points whose outputs are closest (several, as a LUT can fold back
    // near the gamut edge), solve inside the table from each, keep the best. A colour the table can't
    // make has no true inverse: the best is only a guess, so it sets ctx.outsideLut for the caller to say so.
    const K = 8;
    const inv = (y, ctx) => {
      const bestI = new Array(K).fill(-1), bestD = new Array(K).fill(Infinity);
      for (let i = 0; i < nodes; i++) {
        const a = data[i * 3] - y[0], b = data[i * 3 + 1] - y[1], c = data[i * 3 + 2] - y[2];
        const d = a * a + b * b + c * c;
        if (d < bestD[K - 1]) {
          let j = K - 1;
          while (j > 0 && bestD[j - 1] > d) { bestD[j] = bestD[j - 1]; bestI[j] = bestI[j - 1]; j--; }
          bestD[j] = d; bestI[j] = i;
        }
      }
      let out = null, outErr = Infinity;
      for (const idx of bestI) {
        if (idx < 0) continue;
        const r = idx % n, g = Math.floor(idx / n) % n, b = Math.floor(idx / (n * n));
        const x0 = [r, g, b].map((q, k) => dmin[k] + (q / (n - 1)) * (dmax[k] - dmin[k]));
        const x = newton(fwd, y, x0, 60, 1e-12, dmin, dmax);
        const f = fwd(x), e = Math.max(Math.abs(f[0] - y[0]), Math.abs(f[1] - y[1]), Math.abs(f[2] - y[2]));
        if (e < outErr) { out = x; outErr = e; }
        if (e < 1e-9) break;
      }
      if (ctx && outErr > 1e-4) ctx.outsideLut = true;
      return out;
    };
    const o = op(fwd, inv);
    o.pair = (invFirst) => (invFirst ? null : op((v) => v.map((x, k) => Math.min(Math.max(x, dmin[k]), dmax[k]))));
    return o;
  }
  const numbersIn = (s) => s.trim().split(/\s+/).filter(Boolean).map(Number);
  function readLutFile(path, text, interp) {
    const ext = (path.match(/\.([^.\/\\]+)$/) || [])[1];
    const e = (ext || '').toLowerCase();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (e === 'spi1d') {
      let from = [0, 1], comps = 1, n = 0, inData = false;
      const vals = [];
      for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        if (inData) { if (l.startsWith('}')) break; vals.push(numbersIn(l)); continue; }
        if (/^From/i.test(l)) from = numbersIn(l.slice(4));
        else if (/^Length/i.test(l)) n = parseInt(l.slice(6), 10);
        else if (/^Components/i.test(l)) comps = parseInt(l.slice(10), 10);
        else if (l.startsWith('{')) inData = true;
      }
      const T = [[], [], []];
      for (const v of vals.slice(0, n || vals.length)) for (let k = 0; k < 3; k++) T[k].push(comps === 1 ? v[0] : v[Math.min(k, v.length - 1)]);
      return [lut1dOp(T, [from[0], from[0], from[0]], [from[1], from[1], from[1]])];
    }
    if (e === 'spimtx') {
      const v = numbersIn(text);
      return [matrixOp([v[0], v[1], v[2], 0, v[4], v[5], v[6], 0, v[8], v[9], v[10], 0, 0, 0, 0, 1], [v[3] / 65535, v[7] / 65535, v[11] / 65535])];
    }
    if (e === 'spi3d') {
      const body = lines.filter((l) => l.trim());
      const n = numbersIn(body[2])[0];
      const data = new Float64Array(n * n * n * 3);
      for (let i = 3; i < body.length; i++) {
        const v = numbersIn(body[i]);
        if (v.length < 6) continue;
        const idx = ((v[2] * n + v[1]) * n + v[0]) * 3;
        data[idx] = v[3]; data[idx + 1] = v[4]; data[idx + 2] = v[5];
      }
      return [lut3dOp(n, data, [0, 0, 0], [1, 1, 1], interp)];
    }
    if (e === 'cube') {
      let n1 = 0, n3 = 0, dmin = [0, 0, 0], dmax = [1, 1, 1], r1 = null, r3 = null;
      const rows = [];
      for (const raw of lines) {
        const l = raw.replace(/#.*/, '').trim();
        if (!l) continue;
        const kw = l.split(/\s+/)[0].toUpperCase();
        if (kw === 'TITLE') continue;
        if (kw === 'LUT_1D_SIZE') n1 = parseInt(l.split(/\s+/)[1], 10);
        else if (kw === 'LUT_3D_SIZE') n3 = parseInt(l.split(/\s+/)[1], 10);
        else if (kw === 'DOMAIN_MIN') dmin = numbersIn(l.slice(10));
        else if (kw === 'DOMAIN_MAX') dmax = numbersIn(l.slice(10));
        else if (kw === 'LUT_1D_INPUT_RANGE') r1 = numbersIn(l.slice(18));
        else if (kw === 'LUT_3D_INPUT_RANGE') r3 = numbersIn(l.slice(18));
        else if (/^[-+.\d]/.test(l)) rows.push(numbersIn(l));
      }
      const ops = [];
      let at = 0;
      if (n1) {
        const T = [[], [], []];
        for (let i = 0; i < n1; i++) for (let k = 0; k < 3; k++) T[k].push(rows[i][k]);
        at = n1;
        const lo = r1 ? [r1[0], r1[0], r1[0]] : dmin, hi = r1 ? [r1[1], r1[1], r1[1]] : dmax;
        ops.push(lut1dOp(T, lo, hi));
      }
      if (n3) {
        const data = new Float64Array(n3 * n3 * n3 * 3);
        for (let i = 0; i < n3 * n3 * n3; i++) { const v = rows[at + i]; data[i * 3] = v[0]; data[i * 3 + 1] = v[1]; data[i * 3 + 2] = v[2]; }
        const lo = r3 ? [r3[0], r3[0], r3[0]] : n1 ? [0, 0, 0] : dmin, hi = r3 ? [r3[1], r3[1], r3[1]] : n1 ? [1, 1, 1] : dmax;
        ops.push(lut3dOp(n3, data, lo, hi, interp));
      }
      return ops;
    }
    if (e === '3dl') {
      const rows = lines.map((l) => l.replace(/#.*/, '').trim()).filter((l) => /^[-\d]/.test(l)).map(numbersIn);
      const mesh = rows[0];
      const n = mesh.length;
      const body = rows.slice(1).filter((r) => r.length === 3);
      let mx = 0;
      for (const r of body) mx = Math.max(mx, r[0], r[1], r[2]);
      const outMax = Math.pow(2, Math.ceil(Math.log2(mx + 1))) - 1;
      const data = new Float64Array(n * n * n * 3);
      // .3dl lists blue fastest
      let i = 0;
      for (let r = 0; r < n; r++) for (let g = 0; g < n; g++) for (let b = 0; b < n; b++, i++) {
        const v = body[i], idx = ((b * n + g) * n + r) * 3;
        data[idx] = v[0] / outMax; data[idx + 1] = v[1] / outMax; data[idx + 2] = v[2] / outMax;
      }
      const inMax = Math.pow(2, Math.ceil(Math.log2(mesh[n - 1] + 1))) - 1;
      return [lut3dOp(n, data, [0, 0, 0], [mesh[n - 1] / inMax, mesh[n - 1] / inMax, mesh[n - 1] / inMax], interp)];
    }
    throw new Unsupported('It uses a .' + (ext || '?') + ' LUT file (' + path.split('/').pop().split(String.fromCharCode(92)).pop() + '), which ASTROLABE can’t read yet.');
  }

  // ---------------------------------------------------------------- config
  const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(',')).map((x) => String(x && x.value !== undefined ? x.value : x).trim()).filter(Boolean);
  const joinPath = (dir, p) => {
    if (/^([a-z]:)?[\\/]/i.test(p) || /^\\\\/.test(p)) return p.replace(/\\/g, '/');
    return (dir ? dir.replace(/[\\/]+$/, '') + '/' : '') + p.replace(/\\/g, '/');
  };
  const normPath = (p) => {
    const parts = [];
    const lead = (p.match(/^([a-z]:\/|\/\/|\/)/i) || [''])[0];
    for (const seg of p.slice(lead.length).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(seg);
    }
    return lead + parts.join('/');
  };

  const SCENE_REF = '__scene_reference__';
  const invertOps = (ops) => ops.slice().reverse().map(invOp);
  // the display and view an "inverted view" colour space undoes, if it is one
  function invertedView(node) {
    const walk = (t, inv) => {
      if (!t || typeof t !== 'object') return null;
      const i = isInverse(t.direction) !== inv;
      if (t.$tag === 'DisplayViewTransform') return i ? { display: String(t.display), view: String(t.view) } : null;
      if (t.$tag === 'GroupTransform') { for (const c of t.children || []) { const r = walk(c, i); if (r) return r; } }
      return null;
    };
    return walk(node, false);
  }
  class Config {
    constructor(doc, info) {
      this.doc = doc;
      this.path = info.path || '';
      this.dir = this.path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
      this.files = info.files || new Map(); // resolved path -> text (null: missing)
      this.env = info.env || {};
      this.version = num(doc.ocio_profile_version, 1);
      this.name = String(doc.name || '').trim() || this.path.split(/[\\/]/).pop();
      this.description = String(doc.description || '').trim();
      this.roles = {};
      for (const [k, v] of Object.entries(doc.roles || {})) this.roles[lc(k)] = String(v);
      this.vars = {};
      for (const [k, v] of Object.entries(doc.environment || {})) this.vars[k] = v == null ? '' : String(v);
      for (const [k, v] of Object.entries(this.env)) if (v !== null && v !== undefined) this.vars[k] = v;
      // search path: a list (v2) or a ':' separated string (v1; drive letters stay together)
      let sp = doc.search_path;
      if (Array.isArray(sp)) sp = sp.map(String);
      else {
        sp = String(sp || '').split(':');
        const merged = [];
        for (let i = 0; i < sp.length; i++) {
          if (/^[a-z]$/i.test(sp[i]) && i + 1 < sp.length) { merged.push(sp[i] + ':' + sp[i + 1]); i++; } else merged.push(sp[i]);
        }
        sp = merged;
      }
      this.searchPaths = sp.map((s) => s.trim()).filter(Boolean);
      if (!this.searchPaths.length) this.searchPaths = ['.'];
      this.spaces = [];
      this.byName = new Map();
      const addCS = (node, ref) => {
        if (!node || typeof node !== 'object') return;
        const cs = {
          name: String(node.name || '').trim(),
          family: String(node.family || '').trim(),
          description: String(node.description || '').trim(),
          encoding: lc(node.encoding),
          isdata: isTrue(node.isdata),
          aliases: asList(node.aliases),
          categories: asList(node.categories),
          ref,
          to: node.to_scene_reference || node.to_reference || node.to_display_reference || null,
          from: node.from_scene_reference || node.from_reference || node.from_display_reference || null,
        };
        if (!cs.name) return;
        this.spaces.push(cs);
        this.byName.set(lc(cs.name), cs);
        for (const a of cs.aliases) if (!this.byName.has(lc(a))) this.byName.set(lc(a), cs);
      };
      for (const n of doc.colorspaces || []) addCS(n, 'scene');
      this.byName.set(SCENE_REF.toLowerCase(), { name: SCENE_REF, family: '', description: '', encoding: 'scene-linear', isdata: false, aliases: [], categories: [], ref: 'scene', to: null, from: null });
      for (const n of doc.display_colorspaces || []) addCS(n, 'display');
      this.inactive = new Set(asList(doc.inactive_colorspaces).map(lc));
      this.viewTransforms = new Map();
      for (const n of doc.view_transforms || []) {
        if (!n || !n.name) continue;
        this.viewTransforms.set(lc(n.name), {
          name: String(n.name),
          ref: n.from_display_reference || n.to_display_reference ? 'display' : 'scene',
          from: n.from_scene_reference || n.from_display_reference || null,
          to: n.to_scene_reference || n.to_display_reference || null,
        });
      }
      this.defaultVT = doc.default_view_transform ? this.viewTransforms.get(lc(doc.default_view_transform)) : null;
      if (!this.defaultVT) this.defaultVT = [...this.viewTransforms.values()].find((v) => v.ref === 'scene') || null;
      this.looks = new Map();
      for (const n of doc.looks || []) if (n && n.name) this.looks.set(lc(n.name), n);
      // displays and views
      const shared = new Map();
      for (const v of doc.shared_views || []) if (v && v.name) shared.set(lc(v.name), v);
      const viewOf = (v, display) => ({
        name: String(v.name),
        colorspace: v.colorspace ? String(v.colorspace) : null,
        viewTransform: v.view_transform ? String(v.view_transform) : null,
        displayColorspace: v.display_colorspace ? (String(v.display_colorspace) === '<USE_DISPLAY_NAME>' ? display : String(v.display_colorspace)) : null,
        looks: v.looks ? String(v.looks) : '',
      });
      this.displays = [];
      for (const [dname, list] of Object.entries(doc.displays || {})) {
        const views = [];
        for (const item of Array.isArray(list) ? list : []) {
          if (Array.isArray(item)) { // !<Views> [names of shared views]
            for (const nm of item) { const sv = shared.get(lc(nm && nm.value !== undefined ? nm.value : nm)); if (sv) views.push(viewOf(sv, dname)); }
          } else if (item && item.name) views.push(viewOf(item, dname));
        }
        this.displays.push({ name: dname, views });
      }
      const ad = asList(doc.active_displays), av = asList(doc.active_views);
      if (ad.length) {
        const order = ad.map(lc);
        this.displays = this.displays.filter((d) => order.includes(lc(d.name))).sort((a, b) => order.indexOf(lc(a.name)) - order.indexOf(lc(b.name)));
      }
      if (av.length) {
        const order = av.map(lc);
        for (const d of this.displays) {
          const keep = d.views.filter((v) => order.includes(lc(v.name))).sort((a, b) => order.indexOf(lc(a.name)) - order.indexOf(lc(b.name)));
          if (keep.length) d.views = keep;
        }
      }
    }

    getCS(name) {
      const k = lc(name && name.value !== undefined ? name.value : name);
      if (this.byName.has(k)) return this.byName.get(k);
      if (this.roles[k] !== undefined && lc(this.roles[k]) !== k) return this.getCS(this.roles[k]);
      throw new Unsupported('The colour space "' + name + '" isn’t in the config.');
    }
    expand(s) {
      return String(s).replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
        const k = a || b;
        return this.vars[k] !== undefined ? this.vars[k] : m;
      });
    }
    // file lookup: absolute, else each search path (relative to the config's folder)
    candidates(src) {
      const s = this.expand(src);
      if (/^([a-z]:)?[\\/]/i.test(s)) return [normPath(s.replace(/\\/g, '/'))];
      return this.searchPaths.map((p) => normPath(joinPath(joinPath(this.dir, this.expand(p)), s)));
    }
    fileOps(node, dirInv) {
      const src = String(node.src || '');
      for (const c of this.candidates(src)) {
        if (!this.files.has(c)) throw new NeedFile(c);
        const text = this.files.get(c);
        if (text == null) continue;
        let ops = this.lutCache && this.lutCache.get(c + '|' + node.interpolation);
        if (!ops) {
          ops = readLutFile(c, text, node.interpolation).map((o, k) => keyed(o, 'F' + k + c + '|' + node.interpolation));
          (this.lutCache = this.lutCache || new Map()).set(c + '|' + node.interpolation, ops);
        }
        return dirInv ? ops.slice().reverse().map(invOp) : ops.slice();
      }
      throw new Unsupported('The LUT file "' + src + '" isn’t next to the config.');
    }

    // a transform node from the config -> ops in the order they run
    ops(t, inverse, depth = 0) {
      if (!t) return [];
      if (depth > 40) throw new Unsupported('Its transforms nest too deep (a loop in the config?).');
      if (Array.isArray(t) && !t.$tag) return this.ops({ $tag: 'GroupTransform', children: t }, inverse, depth + 1);
      const inv = isInverse(t.direction) !== !!inverse;
      const flip = (ops) => (inv ? ops.slice().reverse().map(invOp) : ops);
      switch (t.$tag) {
        case 'GroupTransform': {
          let list = [];
          for (const c of t.children || []) list = list.concat(this.ops(c, false, depth + 1));
          return inv ? list.slice().reverse().map(invOp) : list;
        }
        case 'MatrixTransform': return flip([matrixOp(t.matrix ? t.matrix.map(Number) : null, t.offset)]);
        case 'ExponentTransform': return flip([exponentOp(tri(t.value, 1), t.style || t.negative_style)]);
        case 'ExponentWithLinearTransform': return flip([moncurveOp(tri(t.gamma, 1), tri(t.offset, 0), t.style || t.negative_style)]);
        case 'LogTransform': return flip([logOp(num(t.base, 2), [1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0])]);
        case 'LogAffineTransform':
          return flip([logOp(num(t.base, 2), tri(t.log_side_slope, 1), tri(t.log_side_offset, 0), tri(t.lin_side_slope, 1), tri(t.lin_side_offset, 0))]);
        case 'LogCameraTransform':
          return flip([logOp(num(t.base, 2), tri(t.log_side_slope, 1), tri(t.log_side_offset, 0), tri(t.lin_side_slope, 1), tri(t.lin_side_offset, 0), tri(t.lin_side_break, 0), t.linear_slope !== undefined ? tri(t.linear_slope, 1) : null)]);
        case 'RangeTransform':
          return flip([rangeOp(t.min_in_value, t.max_in_value, t.min_out_value, t.max_out_value, !/noclamp/i.test(String(t.style || '')))]);
        case 'CDLTransform': return flip([cdlOp(tri(t.slope, 1), tri(t.offset, 0), tri(t.power, 1), num(t.sat !== undefined ? t.sat : t.saturation, 1), t.style)]);
        case 'FixedFunctionTransform': return flip([fixedFunctionOp(t.style, Array.isArray(t.params) ? t.params.map(Number) : [])]);
        case 'BuiltinTransform': return flip(builtinOps(t.style));
        case 'AllocationTransform': {
          const vars = (t.vars || [0, 1]).map(Number);
          const ops = [];
          if (/lg2/i.test(String(t.allocation || ''))) {
            if (vars.length > 2) ops.push(matrixOp(null, [vars[2], vars[2], vars[2]]));
            ops.push(logOp(2, [1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0]));
          }
          ops.push(rangeOp(vars[0], vars[1], 0, 1, false));
          return flip(ops);
        }
        case 'FileTransform': return this.fileOps(t, inv);
        case 'ColorSpaceTransform': {
          const ops = this.cstOps(t.src, t.dst, depth + 1, t.data_bypass);
          return inv ? ops.slice().reverse().map(invOp) : ops;
        }
        case 'DisplayViewTransform': {
          const ops = this.dvtOps(t.src, t.display, t.view, depth + 1, isTrue(t.looks_bypass));
          return inv ? ops.slice().reverse().map(invOp) : ops;
        }
        case 'LookTransform': {
          const ops = this.looksOps(t.src, t.looks, depth + 1, t.dst);
          return inv ? ops.slice().reverse().map(invOp) : ops;
        }
        default: throw new Unsupported('It uses a ' + (t.$tag || 'transform of an unknown kind') + ', which ASTROLABE can’t calculate yet.');
      }
    }

    // colour space -> its reference space (scene or display)
    toRef(cs, depth) {
      if (cs.to) return this.ops(cs.to, false, depth);
      if (cs.from) return this.ops(cs.from, true, depth);
      return [];
    }
    fromRef(cs, depth) {
      if (cs.from) return this.ops(cs.from, false, depth);
      if (cs.to) return this.ops(cs.to, true, depth);
      return [];
    }
    // scene reference <-> display reference, through the default view transform
    sceneToDisplay(depth) {
      const vt = this.defaultVT;
      if (!vt) throw new Unsupported('The config has no view transform to link scene and display colour spaces.');
      return vt.from ? this.ops(vt.from, false, depth) : this.ops(vt.to, true, depth);
    }
    cstOps(srcName, dstName, depth = 0, dataBypass) {
      const src = this.getCS(srcName), dst = this.getCS(dstName);
      if (src === dst) return [];
      if ((src.isdata || dst.isdata) && dataBypass !== false && !/^false$/i.test(String(dataBypass))) return [];
      let ops = this.toRef(src, depth + 1);
      if (src.ref !== dst.ref) {
        const bridge = this.sceneToDisplay(depth + 1);
        ops = ops.concat(src.ref === 'scene' ? bridge : bridge.slice().reverse().map(invOp));
      }
      return ops.concat(this.fromRef(dst, depth + 1));
    }
    findView(displayName, viewName) {
      const d = this.displays.find((x) => lc(x.name) === lc(displayName));
      if (!d) throw new Unsupported('The display "' + displayName + '" isn’t in the config.');
      const v = d.views.find((x) => lc(x.name) === lc(viewName));
      if (!v) throw new Unsupported('The view "' + viewName + '" isn’t in the display "' + displayName + '".');
      return v;
    }
    // apply looks ("+a, -b"): each in its own process space. Returns ops and the space you end in.
    looksOps(srcName, looks, depth, dstName) {
      let cur = srcName, ops = [];
      for (const item of String(looks || '').split(/[,:]/).map((s) => s.trim()).filter(Boolean)) {
        const minus = item[0] === '-';
        const nm = item.replace(/^[+-]/, '');
        const look = this.looks.get(lc(nm));
        if (!look) throw new Unsupported('The look "' + nm + '" isn’t in the config.');
        const ps = look.process_space || cur;
        ops = ops.concat(this.cstOps(cur, ps, depth + 1));
        if (minus) ops = ops.concat(look.inverse_transform ? this.ops(look.inverse_transform, false, depth + 1) : this.ops(look.transform, true, depth + 1));
        else ops = ops.concat(look.transform ? this.ops(look.transform, false, depth + 1) : this.ops(look.inverse_transform, true, depth + 1));
        cur = ps;
      }
      if (dstName) ops = ops.concat(this.cstOps(cur, dstName, depth + 1));
      ops.endSpace = cur;
      return ops;
    }
    dvtOps(srcName, displayName, viewName, depth = 0, looksBypass) {
      const view = this.findView(displayName, viewName);
      const src = this.getCS(srcName);
      if (src.isdata) return [];
      let ops = [], cur = srcName;
      if (view.looks && !looksBypass) {
        const lk = this.looksOps(srcName, view.looks, depth + 1);
        ops = lk; cur = lk.endSpace;
      }
      if (view.colorspace && !view.viewTransform) return ops.concat(this.cstOps(cur, view.colorspace, depth + 1));
      const vt = this.viewTransforms.get(lc(view.viewTransform));
      if (!vt) throw new Unsupported('The view transform "' + view.viewTransform + '" isn’t in the config.');
      const dcs = this.getCS(view.displayColorspace || displayName);
      const curCS = this.getCS(cur);
      // bring the colour to the reference the view transform starts from
      let toRef = this.toRef(curCS, depth + 1);
      if (curCS.ref !== vt.ref) {
        const bridge = this.sceneToDisplay(depth + 1);
        toRef = toRef.concat(curCS.ref === 'scene' ? bridge : bridge.slice().reverse().map(invOp));
      }
      const vtOps = vt.from ? this.ops(vt.from, false, depth + 1) : this.ops(vt.to, true, depth + 1);
      return ops.concat(toRef, vtOps, this.fromRef(dcs, depth + 1));
    }
  }

  // the files and environment variables a config refers to are fetched as they are needed
  async function build(cfg, io, fn) {
    for (let tries = 0; tries < 400; tries++) {
      try { return fn(); } catch (e) {
        if (!(e instanceof NeedFile)) throw e;
        let text = null;
        try { text = await io.readText(e.path); } catch (err) { text = null; }
        cfg.files.set(e.path, text == null ? null : String(text));
      }
    }
    throw new Unsupported('The config needs too many files.');
  }

  async function load(text, io = {}) {
    const doc = parseYAML(text);
    if (!doc || typeof doc !== 'object' || !(doc.colorspaces || doc.displays)) throw new Error('This file does not look like an OCIO config (no colour spaces or displays).');
    const names = new Set();
    String(text).replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => { names.add(a || b); return m; });
    const env = {};
    if (io.getEnv) for (const n of names) { try { const v = await io.getEnv(n); if (v) env[n] = v; } catch (e) {} }
    const cfg = new Config(doc, { path: io.path || '', env });
    cfg.io = io;
    return cfg;
  }

  // compose ops into one function
  const chain = (ops0) => chainRun(simplify(ops0));
  const chainRun = (ops) => (v, ctx) => { let x = v.slice(0, 3); for (const o of ops) x = o.f(x, ctx); return x; };
  const chainInv = (ops) => (v, ctx) => { let x = v.slice(0, 3); for (let k = ops.length - 1; k >= 0; k--) x = (ops[k].i || invOp(ops[k]).f)(x, ctx); return x; };

  // A ready-to-use processor: forward(x), inverse(y) (exact where it can be, then refined), plus
  // "clips" (would the forward result fall outside the final range?).
  function processor(ops0) {
    const ops = simplify(ops0);
    const fwd = chainRun(ops);
    const back = chainInv(ops);
    return {
      forward: (v) => fwd(v),
      raw: (v) => fwd(v, { measure: true }),
      // true when the forward result went through a 3D LUT backwards for a colour that LUT can't make
      outsideLut: (v) => { const ctx = {}; fwd(v, ctx); return !!ctx.outsideLut; },
      inverse(y) {
        let x0;
        try { x0 = back(y); } catch (e) { x0 = null; }
        if (!x0 || !x0.every(Number.isFinite)) x0 = y.slice();
        return newton((v) => fwd(v), y, x0, 30, 1e-12);
      },
      count: ops.length,
    };
  }

  return { parseYAML, load, build, processor, Config, Unsupported, chain, simplify, invertOps, invertedView, SCENE_REF, builtinOps, fixedFunctionOp, readLutFile, newton, ACES2 };
})();
if (typeof module !== 'undefined') module.exports = OCIOEngine;
