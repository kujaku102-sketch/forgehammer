// Crossing: a linear scorer over the candidates of a decision cannot use the state of the board at all (what is the same for every candidate cancels in the softmax),
// except through the few features that are already products of the two. This adds the products: for a few candidate features (rows) and every state feature
// (columns), a new feature "row*col" = candidate[row] * state[col]. The weights are learned for them like for any other, and the forged CPU computes the same products.
//
//   crossSpec(featureNames, stateNames, preset) -> { preset, rows: [names], cols: [names] }       (names, so a build with the same names reads it the same way)
//   applyCross(ds, spec, featureNames, stateNames) -> a dataset of the same decisions whose candidates have the products added after the F first features
//   index of row a, column b:  F + a * C + b
const EXTRA_ROWS = ['afford', 'cost_frac', 'is_ob', 'is_sp', 'lethal', 'kills', 'dies', 'dest_front', 'tgt_foe'];
export const PRESETS = {
  types: (featureNames) => featureNames.filter((n) => n.startsWith('type_')),
  'types+': (featureNames) => [...featureNames.filter((n) => n.startsWith('type_')), ...EXTRA_ROWS.filter((n) => featureNames.includes(n))],
  // + what the card's text does (fx_*, not the ones for the front or back: those are products already)
  fx: (featureNames) => [...PRESETS['types+'](featureNames), ...featureNames.filter((n) => n.startsWith('fx_') && !n.endsWith('_front') && !n.endsWith('_back'))]
};

export function crossSpec(featureNames, stateNames, preset = 'types+') {
  if (!PRESETS[preset]) throw new Error(`cross preset ${preset}? one of ${Object.keys(PRESETS).join(', ')}`);
  return { preset, rows: PRESETS[preset](featureNames), cols: [...stateNames] };
}

export const crossNames = (spec) => spec.rows.flatMap((r) => spec.cols.map((c) => `${r}*${c}`));

export function applyCross(ds, spec, featureNames, stateNames) {
  const F = featureNames.length; const S = ds.S;
  const rowOf = new Map(spec.rows.map((name, a) => [featureNames.indexOf(name), a]));
  const colIdx = spec.cols.map((name) => stateNames.indexOf(name));
  if (colIdx.some((j) => j < 0) || [...rowOf.keys()].some((j) => j < 0)) throw new Error('the cross spec has a name this data does not');
  const C = colIdx.length;
  const count = (emit) => {
    let m = 0;
    for (let i = 0; i < ds.n; i += 1) {
      for (let c = ds.cOff[i]; c < ds.cOff[i + 1]; c += 1, m += 1) {
        emit(m, 0, 0, true);
        for (let p = ds.nzOff[c]; p < ds.nzOff[c + 1]; p += 1) {
          emit(m, ds.nzIdx[p], ds.nzVal[p], false);
          const a = rowOf.get(ds.nzIdx[p]);
          if (a === undefined) continue;
          for (let b = 0; b < C; b += 1) { const s = ds.state[i * S + colIdx[b]]; if (s !== 0) emit(m, F + a * C + b, ds.nzVal[p] * s, false); }
        }
      }
    }
  };
  let nnz = 0; count((m, idx, val, start) => { if (!start) nnz += 1; });
  const nzOff = new Int32Array(ds.M + 1); const nzIdx = new Int32Array(nnz); const nzVal = new Float32Array(nnz);
  let q = 0; count((m, idx, val, start) => { if (start) nzOff[m] = q; else { nzIdx[q] = idx; nzVal[q] = val; q += 1; } });
  nzOff[ds.M] = q;
  return { ...ds, F: F + spec.rows.length * C, nzOff, nzIdx, nzVal };
}
