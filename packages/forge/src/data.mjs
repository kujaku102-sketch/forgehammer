// From the parsed decisions to flat typed arrays that the learners walk through: a decision is a run of candidates, a candidate a run of
// (feature index, value) pairs. The number of candidates is different from decision to decision; nothing here assumes a fixed one.

export const whyOf = (why) => String(why).split(':')[0];          // "own" | "no-gain" | "no-supported-move"
export const viaBaseline = (why) => String(why).endsWith(':baseline');

// filter: { why: 'own' | 'all' | [list of why], minCands: 2 }
export function buildDataset(decisions, header, { why = 'all', minCands = 2 } = {}) {
  const allowed = why === 'all' ? null : new Set(Array.isArray(why) ? why : String(why).split(','));
  const kept = decisions.filter((d) => d.k !== null && d.c.length >= minCands && (allowed === null || allowed.has(whyOf(d.why))));
  const n = kept.length;
  const S = header.stateNames.length; const F = header.featureNames.length;
  const cOff = new Int32Array(n + 1);
  let M = 0; let nnz = 0;
  for (let i = 0; i < n; i += 1) { cOff[i] = M; M += kept[i].c.length; for (const c of kept[i].c) nnz += c.length; }
  cOff[n] = M;
  const nzOff = new Int32Array(M + 1); const nzIdx = new Int32Array(nnz); const nzVal = new Float32Array(nnz);
  const tVal = new Float32Array(M).fill(NaN);
  const state = new Float32Array(n * S);
  const chosen = new Int32Array(n);
  const result = new Float32Array(n);
  const jobs = new Array(n); const whys = new Array(n); const baselineChosen = new Uint8Array(n);
  let m = 0; let p = 0;
  for (let i = 0; i < n; i += 1) {
    const d = kept[i];
    jobs[i] = d.job; whys[i] = whyOf(d.why); chosen[i] = d.k; baselineChosen[i] = viaBaseline(d.why) ? 1 : 0;
    for (let j = 0; j < S; j += 1) state[i * S + j] = d.s[j];
    const winner = d.match.outcome?.kind === 'win' ? d.match.outcome.winnerSeat : null;
    result[i] = winner === null ? 0 : winner === d.seat ? 1 : -1;
    for (let c = 0; c < d.c.length; c += 1, m += 1) {
      nzOff[m] = p;
      for (const [idx, val] of d.c[c]) { nzIdx[p] = idx; nzVal[p] = val; p += 1; }
      const t = d.t[c]; if (t !== null && t !== undefined) tVal[m] = t;
    }
  }
  nzOff[M] = p;
  const ds = { n, M, S, F, cOff, nzOff, nzIdx, nzVal, tVal, state, chosen, result, jobs, whys, baselineChosen, weight: new Float32Array(n).fill(1) };
  // the entries (the legal actions before their options are known) and which entry each candidate comes from, when the records have them
  if (kept.length > 0 && Array.isArray(kept[0].e)) {
    const eOff = new Int32Array(n + 1); let EM = 0; let enz = 0;
    for (let i = 0; i < n; i += 1) { eOff[i] = EM; EM += kept[i].e.length; for (const e of kept[i].e) enz += e.length; }
    eOff[n] = EM;
    const enzOff = new Int32Array(EM + 1); const enzIdx = new Int32Array(enz); const enzVal = new Float32Array(enz);
    const ek = new Int32Array(n).fill(-1); const eo = new Int32Array(M);
    let em = 0; let ep = 0; let cm = 0;
    for (let i = 0; i < n; i += 1) {
      ek[i] = kept[i].ek ?? -1;
      for (const e of kept[i].e) { enzOff[em] = ep; for (const [idx, val] of e) { enzIdx[ep] = idx; enzVal[ep] = val; ep += 1; } em += 1; }
      for (const o of kept[i].eo) { eo[cm] = o; cm += 1; }
    }
    enzOff[EM] = ep;
    Object.assign(ds, { EM, eOff, enzOff, enzIdx, enzVal, ek, eo });
  }
  return ds;
}

// The entry stage as a dataset of its own: the candidates of a decision are its entries, the chosen one the teacher's entry. Rows: the decisions with a known entry and at least 2 entries.
export function entryView(ds) {
  const view = { ...ds, M: ds.EM, cOff: ds.eOff, nzOff: ds.enzOff, nzIdx: ds.enzIdx, nzVal: ds.enzVal, chosen: ds.ek, tVal: new Float32Array(ds.EM).fill(NaN) };
  const rows = []; for (let i = 0; i < ds.n; i += 1) if (ds.ek[i] >= 0 && ds.eOff[i + 1] - ds.eOff[i] >= 2) rows.push(i);
  return { view, rows };
}

// The option stage: the candidates of a decision are the candidates that come from the teacher's entry. Rows: the decisions where that entry has at least 2 candidates and the teacher's candidate is one of them.
export function optionView(ds) {
  const cOff = new Int32Array(ds.n + 1); const idxList = []; const chosen = new Int32Array(ds.n).fill(-1); const rows = [];
  for (let i = 0; i < ds.n; i += 1) {
    cOff[i] = idxList.length;
    if (ds.ek[i] < 0) continue;
    const group = [];
    for (let m = ds.cOff[i]; m < ds.cOff[i + 1]; m += 1) if (ds.eo[m] === ds.ek[i]) group.push(m);
    const k = group.indexOf(ds.cOff[i] + ds.chosen[i]);
    if (group.length >= 2 && k >= 0) { idxList.push(...group); chosen[i] = k; rows.push(i); }
  }
  cOff[ds.n] = idxList.length;
  const M = idxList.length; const nzOff = new Int32Array(M + 1); let nnz = 0;
  for (const m of idxList) nnz += ds.nzOff[m + 1] - ds.nzOff[m];
  const nzIdx = new Int32Array(nnz); const nzVal = new Float32Array(nnz); let p = 0;
  idxList.forEach((m, j) => { nzOff[j] = p; for (let q = ds.nzOff[m]; q < ds.nzOff[m + 1]; q += 1) { nzIdx[p] = ds.nzIdx[q]; nzVal[p] = ds.nzVal[q]; p += 1; } });
  nzOff[M] = p;
  return { view: { ...ds, M, cOff, nzOff, nzIdx, nzVal, chosen, tVal: new Float32Array(M).fill(NaN) }, rows };
}

// Candidate score z = w·φ for candidate m.
export function score(ds, w, m) {
  let z = 0;
  for (let p = ds.nzOff[m]; p < ds.nzOff[m + 1]; p += 1) z += w[ds.nzIdx[p]] * ds.nzVal[p];
  return z;
}

// A small seeded generator (mulberry32) so a run can be repeated.
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Which decisions are for validation: whole matches, chosen by a hash of the match id, so that no match is on both sides.
export function splitByMatch(ds, valFraction = 0.2, seed = 1) {
  const side = (job) => { let h = 2166136261 ^ seed; for (let i = 0; i < job.length; i += 1) h = Math.imul(h ^ job.charCodeAt(i), 16777619); return ((h >>> 0) % 1000) / 1000 < valFraction; };
  const train = []; const val = [];
  for (let i = 0; i < ds.n; i += 1) (side(ds.jobs[i]) ? val : train).push(i);
  return { train, val };
}
