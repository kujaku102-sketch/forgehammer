#!/usr/bin/env node
// (a) of a round: where does the student lose? node loop/analyze.mjs <config.json> <round>
// Reads the evaluation of the student of the last round (round-<n-1>/eval, or config.round0 for the first round) and the records of this round (the teacher's
// answers to the decisions of that student: sk = what the student played, k = what the teacher chose) and writes round-<n>/analysis.md and analysis.json.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readOre } from '../src/ore.mjs';

const [configPath, roundArg] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const round = Number(roundArg);
const dir = path.join(config.work, `round-${round}`);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const wilson = (w, n) => { if (!n) return [0, 0]; const z = 1.96; const p = w / n; const d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [c - h, c + h]; };
const cell = (c) => (c && c.n ? `${pct((c.w + c.d / 2) / c.n)} (${c.w}-${c.l}, n=${c.n})` : '-');
const out = [];

// 1. the evaluation of the student of the last round
const evalDirs = round === 1 ? { 'vs simple': config.round0.vsSimple, 'vs lookahead': config.round0.vsLookahead }
  : { 'vs simple': path.join(config.work, `round-${round - 1}`, 'eval', 'vs-simple'), 'vs lookahead': path.join(config.work, `round-${round - 1}`, 'eval', 'vs-lookahead') };
out.push(`# round ${round}: where the student of round ${round - 1} loses\n`);
const analysis = { evals: {}, shadow: {} };
for (const [label, evalDir] of Object.entries(evalDirs)) {
  const file = path.join(evalDir, 'arena.json');
  if (!existsSync(file)) { out.push(`(${label}: no arena.json in ${evalDir})`); continue; }
  const a = JSON.parse(readFileSync(file, 'utf8'));
  const o = a.overall; const [lo, hi] = wilson(o.w + o.d / 2, o.n);
  analysis.evals[label] = { win: (o.w + o.d / 2) / o.n, lo, hi, n: o.n, byDeck: a.byDeckA, byOrder: a.byOrder };
  out.push(`## ${label}: ${pct((o.w + o.d / 2) / o.n)} (95% ${pct(lo)}..${pct(hi)}, ${o.w}-${o.l}${o.d ? `-${o.d}` : ''}, n=${o.n})`);
  out.push(`by turn order: first ${cell(a.byOrder.first)}; second ${cell(a.byOrder.second)}`);
  out.push('| student deck | result | | opponent deck | result for the student |');
  out.push('|---|---|---|---|---|');
  const decks = Object.keys(a.byDeckA);
  for (const d of decks) out.push(`| ${d.replace('start-', '')} | ${cell(a.byDeckA[d])} | | ${d.replace('start-', '')} | ${cell(a.byDeckB[d])} |`);
  out.push('');
}

// 2. what the teacher would have done on the decisions of that student
const oreDirs = ['vsla', 'vssimple'].map((k) => path.join(dir, 'ore', k)).filter((d) => existsSync(d) && readdirSync(d).length > 0);
if (oreDirs.length > 0) {
  const ore = readOre(oreDirs);
  const names = ore.header.featureNames;
  const typeOf = (cand) => { for (const [i] of cand) if (names[i].startsWith('type_')) return names[i].slice(5); return 'other'; };
  const finished = ore.decisions.filter((d) => d.match.status === 'finished' && d.k !== null && d.sk !== undefined && d.sk !== null && d.c.length >= 2 && d.c[d.k] && d.c[d.sk]);
  const won = (d) => d.match.outcome?.kind === 'win' && d.match.outcome.winnerSeat === d.seat;
  const lost = (d) => d.match.outcome?.kind === 'win' && d.match.outcome.winnerSeat !== d.seat;
  const stats = new Map(); const confusion = new Map(); let n = 0; let agree = 0; let nWon = 0; let nLost = 0;
  const phase = (turn) => (turn <= 4 ? 'turn 1-4' : turn <= 8 ? 'turn 5-8' : 'turn 9+');
  const byPhase = new Map();
  for (const d of finished) {
    const t = typeOf(d.c[d.k]); const s = typeOf(d.c[d.sk]); const same = d.k === d.sk;
    n += 1; if (same) agree += 1; if (won(d)) nWon += 1; if (lost(d)) nLost += 1;
    const e = stats.get(t) ?? { n: 0, same: 0, nWon: 0, diffWon: 0, nLost: 0, diffLost: 0 };
    e.n += 1; if (same) e.same += 1; if (won(d)) { e.nWon += 1; if (!same) e.diffWon += 1; } if (lost(d)) { e.nLost += 1; if (!same) e.diffLost += 1; }
    stats.set(t, e);
    if (!same) confusion.set(`${t} -> ${s}`, (confusion.get(`${t} -> ${s}`) ?? 0) + 1);
    const p = byPhase.get(phase(d.turn)) ?? { n: 0, same: 0 }; p.n += 1; if (same) p.same += 1; byPhase.set(phase(d.turn), p);
  }
  analysis.shadow = { decisions: n, agree: agree / Math.max(n, 1), matches: ore.matches.size, byType: Object.fromEntries(stats) };
  out.push(`## the teacher on the student's decisions: ${pct(agree / Math.max(n, 1))} the same move (${agree}/${n} decisions with a choice, ${ore.matches.size} matches, ${nWon} decisions in won matches, ${nLost} in lost)`);
  out.push('by the phase of the match: ' + [...byPhase.entries()].sort().map(([k, v]) => `${k} ${pct(v.same / v.n)} (n=${v.n})`).join(', '));
  out.push('');
  out.push('| teacher chose | decisions | same move | differs in won matches | differs in lost matches | excess of differing in lost matches |');
  out.push('|---|---|---|---|---|---|');
  const rows = [...stats.entries()].map(([t, e]) => {
    const dw = e.nWon ? e.diffWon / e.nWon : 0; const dl = e.nLost ? e.diffLost / e.nLost : 0;
    return { t, e, dw, dl, excess: (dl - dw) * e.nLost };
  }).sort((x, y) => y.excess - x.excess);
  for (const r of rows) out.push(`| ${r.t} | ${r.e.n} | ${pct(r.e.same / r.e.n)} | ${pct(r.dw)} (n=${r.e.nWon}) | ${pct(r.dl)} (n=${r.e.nLost}) | ${r.excess.toFixed(1)} |`);
  out.push('');
  out.push('most common differences (teacher -> student): ' + [...confusion.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join('; '));
  out.push('');
  out.push('"excess": how many more differing decisions the lost matches have than they would if they differed as often as the won matches. The ones at the top are the moves whose differences go with losing (a hint, not a proof: a lost match differs more for many reasons).');
} else out.push('(no records of this round yet)');
writeFileSync(path.join(dir, 'analysis.md'), out.join('\n') + '\n');
writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(analysis, null, 1));
console.log(`wrote ${path.join(dir, 'analysis.md')}`);
