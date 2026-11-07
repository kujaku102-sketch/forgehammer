// The hammer: from the teacher's decisions to one weight vector w, so that the candidate with the highest z = w·φ(s,a) is the one the teacher chose.
//
//   method softmax   weighted softmax cross-entropy over the candidates of a decision (target: the chosen one, the teacher's own scores, or a mix)
//   method pairwise  the chosen candidate against each other candidate (logistic on the difference of their scores)
//   method ridge     weighted ridge regression, "chosen = 1, not chosen = 0": the old hammer's idea, kept as the thing to beat
//
// Every decision has a weight: exp(A/β) with A the advantage (the result of the match for that seat, less what the state made likely).
import { rng, score } from './data.mjs';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// ---- advantage ---------------------------------------------------------------------------------------------------------------------
// value model: P(win) from the state features, logistic regression (the state vector has no bias, one is added here)
export function fitValueModel(ds, rows, { epochs = 40, lr = 0.05, l2 = 1e-3, seed = 1 } = {}) {
  const S = ds.S; const u = new Float64Array(S + 1);
  const m1 = new Float64Array(S + 1); const m2 = new Float64Array(S + 1);
  const random = rng(seed); const order = [...rows];
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let b = 0; b < order.length; b += 128) {
      const grad = new Float64Array(S + 1);
      const batch = order.slice(b, b + 128);
      for (const i of batch) {
        let z = u[S]; for (let j = 0; j < S; j += 1) z += u[j] * ds.state[i * S + j];
        const y = (ds.result[i] + 1) / 2;
        const g = sigmoid(z) - y;
        for (let j = 0; j < S; j += 1) grad[j] += g * ds.state[i * S + j];
        grad[S] += g;
      }
      step += 1;
      for (let j = 0; j <= S; j += 1) {
        const gj = grad[j] / batch.length + (j < S ? l2 * u[j] : 0);
        m1[j] = 0.9 * m1[j] + 0.1 * gj; m2[j] = 0.999 * m2[j] + 0.001 * gj * gj;
        u[j] -= lr * (m1[j] / (1 - 0.9 ** step)) / (Math.sqrt(m2[j] / (1 - 0.999 ** step)) + 1e-8);
      }
    }
  }
  return u;
}

export const valueOf = (ds, u, i) => { let z = u[ds.S]; for (let j = 0; j < ds.S; j += 1) z += u[j] * ds.state[i * ds.S + j]; return 2 * sigmoid(z) - 1; };

// sets ds.weight for every decision. mode: 'value' (A = result - V(s)), 'result' (A = result), 'none' (all 1).
// The weights are scaled so that their mean over `rows` is 1.
export function setWeights(ds, rows, { mode = 'value', beta = 1, clip = [0.05, 20], valueModel = null } = {}) {
  let sum = 0;
  for (const i of rows) {
    let a = 0;
    if (mode === 'result') a = ds.result[i];
    else if (mode === 'value') a = ds.result[i] - valueOf(ds, valueModel, i);
    const w = mode === 'none' ? 1 : Math.min(clip[1], Math.max(clip[0], Math.exp(a / beta)));
    ds.weight[i] = w; sum += w;
  }
  const scale = rows.length / Math.max(sum, 1e-9);
  for (const i of rows) ds.weight[i] *= scale;
}

// ---- learning ----------------------------------------------------------------------------------------------------------------------
// target for decision i: a distribution over its candidates
function teacherDistribution(ds, i, tau, fill) {
  const lo = ds.cOff[i]; const hi = ds.cOff[i + 1]; const q = new Float64Array(hi - lo);
  let any = false; let max = -Infinity;
  for (let m = lo; m < hi; m += 1) { const t = ds.tVal[m]; if (!Number.isNaN(t)) { any = true; max = Math.max(max, t / tau); } }
  if (!any) return null;
  let sum = 0;
  for (let m = lo; m < hi; m += 1) { const t = Number.isNaN(ds.tVal[m]) ? fill : ds.tVal[m]; q[m - lo] = Math.exp(t / tau - max); sum += q[m - lo]; }
  for (let k = 0; k < q.length; k += 1) q[k] /= sum;
  return q;
}

export function train(ds, rows, options = {}) {
  const { method = 'softmax', target = 'chosen', mix = 0.5, tau = 2, fill = 0.01, epochs = 40, lr = 0.05, l2 = 1e-4, batch = 64, seed = 1, mask = null, valRows = [], log = () => {} } = options;
  const F = ds.F;
  if (method === 'ridge') return ridge(ds, rows, { l2: options.ridgeL2 ?? 1e-2, mask });
  const w = new Float64Array(F); const m1 = new Float64Array(F); const m2 = new Float64Array(F);
  const random = rng(seed); const order = [...rows];
  const useRows = target === 'chosen' ? order : order.filter((i) => teacherDistribution(ds, i, tau, fill) !== null);
  const used = target === 'chosen' ? order : useRows;
  let best = { loss: Infinity, w: Float64Array.from(w), epoch: 0 };
  let step = 0;
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    for (let i = used.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [used[i], used[j]] = [used[j], used[i]]; }
    for (let b = 0; b < used.length; b += batch) {
      const grad = new Float64Array(F);
      const rowsInBatch = used.slice(b, b + batch);
      for (const i of rowsInBatch) {
        const lo = ds.cOff[i]; const K = ds.cOff[i + 1] - lo; const k = ds.chosen[i]; const wt = ds.weight[i];
        const z = new Float64Array(K); let zmax = -Infinity;
        for (let c = 0; c < K; c += 1) { z[c] = score(ds, w, lo + c); if (z[c] > zmax) zmax = z[c]; }
        if (method === 'pairwise') {
          for (let c = 0; c < K; c += 1) {
            if (c === k) continue;
            const g = wt * sigmoid(z[c] - z[k]) / (K - 1);       // d/dz_c of log(1+exp(z_c - z_k))
            for (let p = ds.nzOff[lo + c]; p < ds.nzOff[lo + c + 1]; p += 1) grad[ds.nzIdx[p]] += g * ds.nzVal[p];
            for (let p = ds.nzOff[lo + k]; p < ds.nzOff[lo + k + 1]; p += 1) grad[ds.nzIdx[p]] -= g * ds.nzVal[p];
          }
          continue;
        }
        let sum = 0; const p = new Float64Array(K);
        for (let c = 0; c < K; c += 1) { p[c] = Math.exp(z[c] - zmax); sum += p[c]; }
        const q = target === 'chosen' ? null : teacherDistribution(ds, i, tau, fill);
        for (let c = 0; c < K; c += 1) {
          p[c] /= sum;
          const y = target === 'chosen' ? (c === k ? 1 : 0) : target === 'teacher' ? q[c] : (1 - mix) * (c === k ? 1 : 0) + mix * (q ? q[c] : (c === k ? 1 : 0));
          const g = wt * (p[c] - y);
          if (g === 0) continue;
          for (let pp = ds.nzOff[lo + c]; pp < ds.nzOff[lo + c + 1]; pp += 1) grad[ds.nzIdx[pp]] += g * ds.nzVal[pp];
        }
      }
      step += 1;
      for (let j = 0; j < F; j += 1) {
        if (mask && !mask[j]) { w[j] = 0; continue; }
        const gj = grad[j] / rowsInBatch.length + l2 * w[j];
        m1[j] = 0.9 * m1[j] + 0.1 * gj; m2[j] = 0.999 * m2[j] + 0.001 * gj * gj;
        w[j] -= lr * (m1[j] / (1 - 0.9 ** step)) / (Math.sqrt(m2[j] / (1 - 0.999 ** step)) + 1e-8);
      }
    }
    const check = valRows.length > 0 ? valRows : rows;
    const e = evaluate(ds, w, check);
    log(`epoch ${epoch}: ${valRows.length > 0 ? 'val' : 'train'} nll ${e.nll.toFixed(4)} top1 ${(100 * e.top1).toFixed(1)}%`);
    if (e.nll < best.loss) best = { loss: e.nll, w: Float64Array.from(w), epoch };
  }
  return { w: best.w, bestEpoch: best.epoch, method };
}

// weighted ridge regression of "chosen = 1, otherwise 0" on φ, with the decisions' weights; solved in the normal equations (F x F)
function ridge(ds, rows, { l2, mask }) {
  const F = ds.F; const A = Array.from({ length: F }, () => new Float64Array(F)); const b = new Float64Array(F);
  for (const i of rows) {
    const lo = ds.cOff[i]; const K = ds.cOff[i + 1] - lo; const wt = ds.weight[i];
    for (let c = 0; c < K; c += 1) {
      const y = c === ds.chosen[i] ? 1 : 0;
      const s = ds.nzOff[lo + c]; const e = ds.nzOff[lo + c + 1];
      for (let p = s; p < e; p += 1) {
        const a = ds.nzIdx[p]; const va = ds.nzVal[p];
        b[a] += wt * va * y;
        for (let q = s; q < e; q += 1) A[a][ds.nzIdx[q]] += wt * va * ds.nzVal[q];
      }
    }
  }
  for (let j = 0; j < F; j += 1) A[j][j] += l2 * rows.length / 100;
  const w = solve(A, b);
  if (mask) for (let j = 0; j < F; j += 1) if (!mask[j]) w[j] = 0;
  return { w, bestEpoch: 0, method: 'ridge' };
}

function solve(A, b) {
  const n = b.length; const M = A.map((row, i) => Float64Array.from([...row, b[i]]));
  for (let col = 0; col < n; col += 1) {
    let piv = col; for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = Math.abs(M[col][col]) < 1e-12 ? 1e-12 : M[col][col];
    for (let j = col; j <= n; j += 1) M[col][j] /= d;
    for (let r = 0; r < n; r += 1) if (r !== col) { const f = M[r][col]; if (f !== 0) for (let j = col; j <= n; j += 1) M[r][j] -= f * M[col][j]; }
  }
  return Float64Array.from(M.map((row) => row[n]));
}

// ---- the two stages ------------------------------------------------------------------------------------------------------------------
// Learns the entry scorer and the option scorer separately (each is the softmax above on its own view of the data) and reports how often each is right, and how often both are
// (the teacher's whole move found: its entry, and its option within it).
export function trainStaged(ds, trainRows, options, entryOf, optionOf, valRows) {
  const keep = (rows, eligible) => { const set = new Set(eligible); return rows.filter((i) => set.has(i)); };
  const entry = train(entryOf.view, keep(trainRows, entryOf.rows), { ...options, valRows: keep(valRows, entryOf.rows) });
  const option = train(optionOf.view, keep(trainRows, optionOf.rows), { ...options, valRows: keep(valRows, optionOf.rows) });
  return { entry, option };
}

// joint accuracy on the decisions of `rows` (every decision with a known entry): the best entry is the teacher's, and, when that entry has options to choose among, the best option is too
export function evaluateStaged(ds, entryOf, optionOf, wEntry, wOption, rows) {
  let n = 0; let entryHit = 0; let both = 0; let optionN = 0; let optionHit = 0;
  const optionRows = new Set(optionOf.rows);
  for (const i of rows) {
    if (ds.ek[i] < 0 || ds.eOff[i + 1] - ds.eOff[i] < 1) continue;
    n += 1;
    const lo = ds.eOff[i]; const K = ds.eOff[i + 1] - lo; let best = 0; let bz = -Infinity;
    for (let c = 0; c < K; c += 1) { const z = score(entryOf.view, wEntry, lo + c); if (z > bz) { bz = z; best = c; } }
    const hitEntry = best === ds.ek[i]; if (hitEntry) entryHit += 1;
    if (optionRows.has(i)) {
      optionN += 1;
      const olo = optionOf.view.cOff[i]; const OK = optionOf.view.cOff[i + 1] - olo; let ob = 0; let oz = -Infinity;
      for (let c = 0; c < OK; c += 1) { const z = score(optionOf.view, wOption, olo + c); if (z > oz) { oz = z; ob = c; } }
      const hitOption = ob === optionOf.view.chosen[i]; if (hitOption) optionHit += 1;
      if (hitEntry && hitOption) both += 1;
    } else if (hitEntry) both += 1;
  }
  return { n, entryTop1: entryHit / Math.max(n, 1), optionN, optionTop1: optionHit / Math.max(optionN, 1), jointTop1: both / Math.max(n, 1) };
}

// ---- measuring ---------------------------------------------------------------------------------------------------------------------
export function evaluate(ds, w, rows) {
  let nll = 0; let top1 = 0; let top3 = 0; let rank = 0; let chance = 0;
  for (const i of rows) {
    const lo = ds.cOff[i]; const K = ds.cOff[i + 1] - lo; const k = ds.chosen[i];
    const z = new Float64Array(K); let zmax = -Infinity;
    for (let c = 0; c < K; c += 1) { z[c] = score(ds, w, lo + c); if (z[c] > zmax) zmax = z[c]; }
    let sum = 0; for (let c = 0; c < K; c += 1) sum += Math.exp(z[c] - zmax);
    nll += -(z[k] - zmax - Math.log(sum));
    let above = 0; for (let c = 0; c < K; c += 1) if (c !== k && z[c] >= z[k]) above += 1;   // a tie counts against the chosen one
    if (above === 0) top1 += 1; if (above < 3) top3 += 1; rank += above + 1; chance += 1 / K;
  }
  const n = Math.max(rows.length, 1);
  return { n: rows.length, nll: nll / n, top1: top1 / n, top3: top3 / n, meanRank: rank / n, chanceTop1: chance / n };
}

// the kind of move of candidate m, from the type_* features it has
export function typeOf(ds, names, m) {
  for (let p = ds.nzOff[m]; p < ds.nzOff[m + 1]; p += 1) { const name = names[ds.nzIdx[p]]; if (name.startsWith('type_')) return name.slice(5); }
  return 'other';
}

// top-1 split by a label of each decision (why the teacher chose it, the kind of move chosen)
export function breakdown(ds, names, w, rows, labelOf) {
  const groups = new Map();
  for (const i of rows) {
    const label = labelOf(i);
    const g = groups.get(label) ?? { n: 0, hit: 0, chance: 0 };
    const lo = ds.cOff[i]; const K = ds.cOff[i + 1] - lo; const k = ds.chosen[i];
    let above = 0; const zk = score(ds, w, lo + k);
    for (let c = 0; c < K; c += 1) if (c !== k && score(ds, w, lo + c) >= zk) above += 1;
    g.n += 1; g.hit += above === 0 ? 1 : 0; g.chance += 1 / K; groups.set(label, g);
  }
  return [...groups.entries()].sort((a, b) => b[1].n - a[1].n).map(([label, g]) => ({ label, n: g.n, top1: g.hit / g.n, chance: g.chance / g.n }));
}
