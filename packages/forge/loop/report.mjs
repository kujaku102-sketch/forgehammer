#!/usr/bin/env node
// The report of a round: what was changed, and how far the yardstick moved (95% ranges, and whether the difference is more than the range). node loop/report.mjs <config.json> <round>
// Writes <work>/周-<round>.md and says whether a stopping mark is reached (against lookahead above 50%, or two rounds in a row that moved only within the range).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [configPath, roundArg] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const round = Number(roundArg);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const pts = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`;
const wilson = (w, n) => { const z = 1.96; const p = w / n; const d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [c - h, c + h]; };
const readArena = (dir) => { const file = path.join(dir, 'arena.json'); if (!existsSync(file)) return null; const a = JSON.parse(readFileSync(file, 'utf8')); const w = a.overall.w + a.overall.d / 2; const n = a.overall.n; const p = w / n; const [lo, hi] = wilson(w, n); return { p, lo, hi, n, a, anomalies: a.anomalies, status: a.status, decisions: a.decisions }; };
const evalOf = (n) => (n === 0 ? { simple: readArena(config.round0.vsSimple), la: readArena(config.round0.vsLookahead) }
  : { simple: readArena(path.join(config.work, `round-${n}`, 'eval', 'vs-simple')), la: readArena(path.join(config.work, `round-${n}`, 'eval', 'vs-lookahead')) });
const diff = (now, before) => { const d = now.p - before.p; const se = Math.sqrt(now.p * (1 - now.p) / now.n + before.p * (1 - before.p) / before.n); return { d, half: 1.96 * se, significant: Math.abs(d) > 1.96 * se }; };
const dir = path.join(config.work, `round-${round}`);
const plan = existsSync(path.join(dir, 'plan.json')) ? JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8')) : { hammer: [], note: '(no plan.json)' };
const now = evalOf(round); const before = evalOf(round - 1); const base = evalOf(0);
const lines = [`# round ${round}`, '', `**changed**: ${plan.note}`, `hammer arguments: \`${plan.hammer.join(' ')}\``, ''];
lines.push('| yardstick | now | 95% range | last round | change (95% range of the difference) | since round 0 |', '|---|---|---|---|---|---|');
const verdict = {};
for (const [key, label] of [['simple', 'against simple (swap, seeds ' + config.eval.vsSimple + ')'], ['la', 'against lookahead (swap, seeds ' + config.eval.vsLookahead + ')']]) {
  const x = now[key]; const y = before[key]; const z = base[key];
  if (!x) { lines.push(`| ${label} | (not measured) | | | | |`); continue; }
  const d1 = y ? diff(x, y) : null; const d0 = z ? diff(x, z) : null;
  verdict[key] = { p: x.p, d1 };
  lines.push(`| ${label} | **${pct(x.p)}** | ${pct(x.lo)}..${pct(x.hi)} (n=${x.n}) | ${y ? pct(y.p) : '-'} | ${d1 ? `${pts(d1.d)} points (±${(100 * d1.half).toFixed(1)})${d1.significant ? ' **more than the range**' : ' within the range'}` : '-'} | ${d0 ? `${pts(d0.d)} (±${(100 * d0.half).toFixed(1)})` : '-'} |`);
}
lines.push('');
for (const [key, label] of [['simple', 'against simple'], ['la', 'against lookahead']]) {
  const x = now[key]; if (!x) continue;
  lines.push(`${label}: statuses ${JSON.stringify(x.status)}, anomalies ${x.anomalies}, ${x.a.decisions ? `decisions of the CPU decided itself ${x.a.decisions.own}/${x.a.decisions.own + x.a.decisions.baseline} (the rest left to the game's CPU)` : ''}`);
}
const analysisFile = path.join(dir, 'analysis.md');
if (existsSync(analysisFile)) lines.push('', `analysis of the student that played this round's records: ${analysisFile}`);
// stopping marks
const marks = [];
if (now.la && now.la.p > 0.5) marks.push('against lookahead is above 50%: stop and report');
const prevVerdict = round > 1 ? (() => { const f = path.join(config.work, `周-${round - 1}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; })() : null;
const stalled = (v) => v && (!v.simple?.d1?.significant && !v.la?.d1?.significant);
if (stalled(verdict) && stalled(prevVerdict)) marks.push('two rounds in a row moved only within the range: stop and report');
lines.push('', marks.length ? `**stopping mark**: ${marks.join('; ')}` : 'no stopping mark yet');
writeFileSync(path.join(config.work, `周-${round}.md`), lines.join('\n') + '\n');
writeFileSync(path.join(config.work, `周-${round}.json`), JSON.stringify({ simple: verdict.simple && { p: verdict.simple.p, d1: verdict.simple.d1 }, la: verdict.la && { p: verdict.la.p, d1: verdict.la.d1 }, marks }));
console.log(lines.join('\n'));
