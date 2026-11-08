// A small network for the score of a candidate (the linear scorer cannot express what a deep look-ahead finds):
//
//   z(candidate, state) = base . phi + v . relu(W1 . phi + U1 . s + b1) + lin . phi
//
// `base` (optional) is a linear scorer learned first and held fixed: the network then only learns what the linear scorer misses (a correction), with its own weights kept small (l2);
// the linear part alone is a CPU by itself, and the part that carries over to cards that do not exist yet (it reads what a card does, not which card it is).
// phi is the candidate's features (sparse), s the board's (dense, the same for every candidate of the decision), H hidden units. The candidate with the highest z is the move,
// learned the way the linear one is: softmax over the candidates of a decision, weighted by the decision's weight. The `lin . phi` term keeps what the linear scorer already had.
//
//   trainMlp(ds, rows, { hidden, epochs, lr, l2, batch, seed, valRows, log }) -> { net, bestEpoch }
//   evaluateMlp(ds, net, rows, { names }) -> { n, nll, top1, top3, byType? }
//   mlpWeights(net) -> a plain object to write into weights.json (the CPU of `forge smith` reads it);   scoreCandidate(net, base, phi) is the forward pass the CPU uses.
import { typeOf } from './hammer.mjs';

const mulberry32 = (seed) => () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), seed | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export function initNet(F, S, H, seed = 1) {
  const random = mulberry32(seed);
  const fill = (n, scale) => Float64Array.from({ length: n }, () => (random() * 2 - 1) * scale);
  return { F, S, H, baseW: null, W1: fill(F * H, Math.sqrt(6 / (F + H))), U1: fill(S * H, Math.sqrt(6 / (S + H)) * 0.5), b1: new Float64Array(H), v: fill(H, 0.1), lin: new Float64Array(F) };
}

// the part of the hidden layer that is the same for every candidate of a decision
export function baseOf(net, state, offset = 0) {
  const { S, H, U1, b1 } = net; const base = Float64Array.from(b1);
  for (let j = 0; j < S; j += 1) { const s = state[offset + j]; if (s === 0) continue; for (let h = 0; h < H; h += 1) base[h] += s * U1[j * H + h]; }
  return base;
}

// sparse candidate: (idx[], val[]) in the dataset layout; returns z and fills `act` (the hidden activations before relu) when it is given
export function scoreSparse(net, base, idx, val, from, to, act) {
  const { H, W1, v, lin, baseW } = net; let z = 0;
  const a = act ?? new Float64Array(H); a.set(base);
  for (let p = from; p < to; p += 1) { const f = idx[p]; const x = val[p]; z += lin[f] * x; if (baseW) z += baseW[f] * x; const row = f * H; for (let h = 0; h < H; h += 1) a[h] += x * W1[row + h]; }
  for (let h = 0; h < H; h += 1) if (a[h] > 0) z += v[h] * a[h];
  return z;
}

// dense candidate (the CPU's form): phi is an array of F numbers
export function scoreCandidate(net, base, phi) {
  const { F, H, W1, v, lin, baseW } = net; let z = 0; const a = Float64Array.from(base);
  for (let f = 0; f < F; f += 1) { const x = phi[f]; if (x === 0) continue; z += lin[f] * x; if (baseW) z += baseW[f] * x; const row = f * H; for (let h = 0; h < H; h += 1) a[h] += x * W1[row + h]; }
  for (let h = 0; h < H; h += 1) if (a[h] > 0) z += v[h] * a[h];
  return z;
}

export function evaluateMlp(ds, net, rows, { names = null } = {}) {
  let nll = 0; let top1 = 0; let top3 = 0; const byType = new Map();
  for (const i of rows) {
    const lo = ds.cOff[i]; const K = ds.cOff[i + 1] - lo; const k = ds.chosen[i];
    const base = baseOf(net, ds.state, i * ds.S);
    const z = new Float64Array(K); let zmax = -Infinity;
    for (let c = 0; c < K; c += 1) { z[c] = scoreSparse(net, base, ds.nzIdx, ds.nzVal, ds.nzOff[lo + c], ds.nzOff[lo + c + 1], null); if (z[c] > zmax) zmax = z[c]; }
    let sum = 0; for (let c = 0; c < K; c += 1) sum += Math.exp(z[c] - zmax);
    nll += -(z[k] - zmax - Math.log(sum));
    let above = 0; for (let c = 0; c < K; c += 1) if (c !== k && z[c] >= z[k]) above += 1;
    if (above === 0) top1 += 1; if (above < 3) top3 += 1;
    if (names) { const t = typeOf(ds, names, lo + k); const g = byType.get(t) ?? { n: 0, hit: 0 }; g.n += 1; if (above === 0) g.hit += 1; byType.set(t, g); }
  }
  const n = Math.max(rows.length, 1);
  return { n: rows.length, nll: nll / n, top1: top1 / n, top3: top3 / n, ...(names ? { byType: Object.fromEntries([...byType.entries()].map(([t, g]) => [t, { n: g.n, top1: g.hit / g.n }])) } : {}) };
}

export function trainMlp(ds, rows, { hidden = 32, epochs = 30, lr = 0.01, l2 = 1e-4, batch = 64, seed = 1, valRows = [], log = () => {}, base = null, freezeLin = false } = {}) {
  const net = initNet(ds.F, ds.S, hidden, seed);
  if (base) net.baseW = Float64Array.from(base);
  const { F, S, H } = net;
  const params = { W1: net.W1, U1: net.U1, b1: net.b1, v: net.v, lin: net.lin };
  const names = Object.keys(params);
  const grad = Object.fromEntries(names.map((n) => [n, new Float64Array(params[n].length)]));
  const m1 = Object.fromEntries(names.map((n) => [n, new Float64Array(params[n].length)]));
  const m2 = Object.fromEntries(names.map((n) => [n, new Float64Array(params[n].length)]));
  const random = mulberry32(seed + 7); const order = [...rows];
  const act = new Float64Array(H); const dh = new Float64Array(H); const gbase = new Float64Array(H);
  let best = { loss: Infinity, copy: null, epoch: 0 }; let step = 0;
  const snapshot = () => Object.fromEntries(names.map((n) => [n, Float64Array.from(params[n])]));
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let b = 0; b < order.length; b += batch) {
      for (const n of names) grad[n].fill(0);
      const slice = order.slice(b, b + batch);
      for (const i of slice) {
        const lo = ds.cOff[i]; const K = ds.cOff[i + 1] - lo; const k = ds.chosen[i]; const wt = ds.weight[i];
        const base = baseOf(net, ds.state, i * S);
        const z = new Float64Array(K); let zmax = -Infinity;
        for (let c = 0; c < K; c += 1) { z[c] = scoreSparse(net, base, ds.nzIdx, ds.nzVal, ds.nzOff[lo + c], ds.nzOff[lo + c + 1], null); if (z[c] > zmax) zmax = z[c]; }
        let sum = 0; for (let c = 0; c < K; c += 1) { z[c] = Math.exp(z[c] - zmax); sum += z[c]; }
        gbase.fill(0);
        for (let c = 0; c < K; c += 1) {
          const dz = wt * (z[c] / sum - (c === k ? 1 : 0));
          if (dz === 0) continue;
          const from = ds.nzOff[lo + c]; const to = ds.nzOff[lo + c + 1];
          scoreSparse(net, base, ds.nzIdx, ds.nzVal, from, to, act);       // act = the hidden pre-activations of this candidate
          for (let h = 0; h < H; h += 1) { const on = act[h] > 0; dh[h] = on ? dz * net.v[h] : 0; if (on) grad.v[h] += dz * act[h]; gbase[h] += dh[h]; }
          for (let p = from; p < to; p += 1) { const f = ds.nzIdx[p]; const x = ds.nzVal[p]; grad.lin[f] += dz * x; const row = f * H; for (let h = 0; h < H; h += 1) grad.W1[row + h] += x * dh[h]; }
        }
        for (let h = 0; h < H; h += 1) grad.b1[h] += gbase[h];
        for (let j = 0; j < S; j += 1) { const s = ds.state[i * S + j]; if (s === 0) continue; const row = j * H; for (let h = 0; h < H; h += 1) grad.U1[row + h] += s * gbase[h]; }
      }
      step += 1;
      const c1 = 1 - 0.9 ** step; const c2 = 1 - 0.999 ** step;
      for (const n of names) {
        if (freezeLin && n === 'lin') continue;
        const P = params[n]; const G = grad[n]; const A = m1[n]; const B = m2[n];
        for (let q = 0; q < P.length; q += 1) {
          const g = G[q] / slice.length + (n === 'b1' ? 0 : l2 * P[q]);
          A[q] = 0.9 * A[q] + 0.1 * g; B[q] = 0.999 * B[q] + 0.001 * g * g;
          P[q] -= lr * (A[q] / c1) / (Math.sqrt(B[q] / c2) + 1e-8);
        }
      }
    }
    const check = valRows.length > 0 ? valRows : rows;
    const e = evaluateMlp(ds, net, check);
    log(`epoch ${epoch}: ${valRows.length > 0 ? 'val' : 'train'} nll ${e.nll.toFixed(4)} top1 ${(100 * e.top1).toFixed(1)}%`);
    if (e.nll < best.loss) best = { loss: e.nll, copy: snapshot(), epoch };
  }
  for (const n of names) params[n].set(best.copy[n]);
  return { net, bestEpoch: best.epoch };
}

const round = (x) => Math.round(x * 1e6) / 1e6;
export const mlpWeights = (net) => ({ F: net.F, S: net.S, H: net.H, ...(net.baseW ? { base: Array.from(net.baseW, round) } : {}), W1: Array.from(net.W1, round), U1: Array.from(net.U1, round), b1: Array.from(net.b1, round), v: Array.from(net.v, round), lin: Array.from(net.lin, round) });
export const netFromWeights = (w) => ({ F: w.F, S: w.S, H: w.H, baseW: w.base ? Float64Array.from(w.base) : null, W1: Float64Array.from(w.W1), U1: Float64Array.from(w.U1), b1: Float64Array.from(w.b1), v: Float64Array.from(w.v), lin: Float64Array.from(w.lin) });
