// The smith: weights.json -> a CPU module for SZbattlefield (cpus/forged-<name>.mjs). The file is small: the weights, the names of the
// features they were learned for, and a call to cpus/learned/policy.mjs, which builds the features with the same function the ore was made
// with and plays the candidate with the highest score. A build whose features are not the ones in the file refuses to load it.
import { createHash } from 'node:crypto';

const fmt = (x) => (Number.isFinite(x) ? String(Number(x.toPrecision(9))) : '0');

export function forgeModule(weights, { name }) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('the name may have letters, digits, - and _ only');
  const body = JSON.stringify({ featureVersion: weights.featureVersion, featureNames: weights.featureNames, w: weights.w.map(fmt) });
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const lines = [];
  lines.push(`// Forged by forgehammer (packages/forge): a one-weight-vector CPU. Do not edit; forge it again.`);
  lines.push(`// weights ${digest}; learned from ${weights.meta?.dataset?.decisions ?? '?'} decisions of ${weights.meta?.dataset?.teacher ?? '?'}; ${weights.meta?.method ?? '?'}, target ${weights.meta?.target ?? '?'}, why ${weights.meta?.why ?? '?'}.`);
  lines.push(`// validation (whole matches kept apart): top-1 ${weights.meta?.validation?.top1 !== undefined ? (100 * weights.meta.validation.top1).toFixed(1) + '%' : '?'} on ${weights.meta?.validation?.n ?? '?'} decisions.`);
  lines.push(`import { learnedCpu } from './learned/policy.mjs';`);
  lines.push('');
  lines.push(`export default learnedCpu({`);
  lines.push(`  id: 'forged:${name}',`);
  lines.push(`  featureVersion: ${weights.featureVersion},`);
  lines.push(`  featureNames: ${JSON.stringify(weights.featureNames)},`);
  lines.push(`  weights: [${weights.w.map(fmt).join(', ')}],`);
  lines.push(`  meta: ${JSON.stringify({ digest, ...(weights.meta ?? {}) })}`);
  lines.push(`});`);
  return `${lines.join('\n')}\n`;
}
