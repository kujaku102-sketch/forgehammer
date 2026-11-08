#!/usr/bin/env node
// Which few matches get a language model's eyes: a pick of 20-50 matches out of the ~1000 a round played with CPUs only.
//
//   node loop/select.mjs <ore dir>... --out jobs.txt [--report select.md] [--config select.json] [--n 40]
//
// The records (SZbattlefield --record --shadow <teacher>) hold, for every decision of the student, what the teacher chose (k) and what the student played (sk), and the match line
// with its result. A match is described by: did the student lose, how often it differed from the teacher, which deck the student had, and how many of its decisions the teacher
// could not rate by its own look-ahead (moves the sim has no call for: spells and effects). The pick is made by quotas, from the settings:
//   { "n": 40, "mix": { "lost": 0.4, "disagree": 0.3, "weakDeck": 0.2, "unsupported": 0.1 }, "weakDecks": ["start-red", "start-blue", "start-black"], "minDecisions": 10, "seed": 1 }
//     lost         matches the student lost (the ones with the most differences first)
//     disagree     matches with the highest share of decisions where student and teacher differ
//     weakDeck     matches where the student played one of weakDecks (lost ones first)
//     unsupported  matches with the highest share of decisions the teacher could not rate itself
// A match is taken once; a quota that cannot be filled is filled from the other lists in turn. Writes the job ids (one a line) for `run.mjs --jobs-file`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readOre } from '../src/ore.mjs';

const argv = process.argv.slice(2); const dirs = []; const opt = {};
for (let i = 0; i < argv.length; i += 1) { if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i += 1; } else dirs.push(argv[i]); }
if (dirs.length === 0 || !opt.out) { console.error('usage: select.mjs <ore dir>... --out jobs.txt [--report select.md] [--config select.json] [--n 40]'); process.exit(2); }
const config = { n: 40, mix: { lost: 0.4, disagree: 0.3, weakDeck: 0.2, unsupported: 0.1 }, weakDecks: ['start-red', 'start-blue', 'start-black'], minDecisions: 10, seed: 1, ...(opt.config ? JSON.parse(readFileSync(opt.config, 'utf8')) : {}) };
if (opt.n) config.n = Number(opt.n);

const ore = readOre(dirs);
const byJob = new Map();
for (const d of ore.decisions) {
  const row = byJob.get(d.job) ?? { job: d.job, match: d.match, seat: d.seat, n: 0, differ: 0, compared: 0, unsupported: 0 };
  row.n += 1;
  if (d.sk !== undefined && d.sk !== null && d.k !== null) { row.compared += 1; if (d.sk !== d.k) row.differ += 1; }
  if (/:baseline$|:unmapped$|^no-supported-move/.test(String(d.why))) row.unsupported += 1;
  byJob.set(d.job, row);
}
const pool = [...byJob.values()].filter((r) => r.n >= config.minDecisions && r.match.status === 'finished').map((r) => {
  const winner = r.match.outcome?.kind === 'win' ? r.match.outcome.winnerSeat : null;
  return { ...r, lost: winner !== null && winner !== r.seat, deck: r.match.decks?.[r.seat] ?? '?', disagreeShare: r.compared > 0 ? r.differ / r.compared : 0, unsupportedShare: r.unsupported / r.n,
    tie: createHash('sha256').update(`${config.seed}|${r.job}`).digest('hex') };
});
const order = (cmp) => [...pool].sort((a, b) => cmp(a, b) || a.tie.localeCompare(b.tie));
const lists = {
  lost: order((a, b) => Number(b.lost) - Number(a.lost) || b.disagreeShare - a.disagreeShare).filter((r) => r.lost),
  disagree: order((a, b) => b.disagreeShare - a.disagreeShare),
  weakDeck: order((a, b) => Number(b.lost) - Number(a.lost) || b.disagreeShare - a.disagreeShare).filter((r) => config.weakDecks.includes(r.deck)),
  unsupported: order((a, b) => b.unsupportedShare - a.unsupportedShare)
};
const picked = new Map();
const take = (name, count) => { for (const r of lists[name]) { if (count <= 0) break; if (!picked.has(r.job)) { picked.set(r.job, { ...r, because: name }); count -= 1; } } return count; };
const names = Object.keys(config.mix);
const quotas = Object.fromEntries(names.map((name) => [name, Math.round(config.n * config.mix[name])]));
let short = 0;
for (const name of names) short += take(name, quotas[name]);
for (const name of names) { if (short <= 0) break; short = take(name, short); }
const chosen = [...picked.values()];
writeFileSync(opt.out, `${chosen.map((r) => r.job).join('\n')}\n`, 'utf8');

const pct = (x) => `${(100 * x).toFixed(0)}%`;
const lines = [`# select: ${chosen.length} of ${pool.length} matches (${ore.decisions.length} decisions)`, '',
  `settings: ${JSON.stringify({ n: config.n, mix: config.mix, weakDecks: config.weakDecks })}`, '',
  `the pool: the student lost ${pool.filter((r) => r.lost).length}; differs from the teacher in ${pct(pool.reduce((s, r) => s + r.differ, 0) / Math.max(1, pool.reduce((s, r) => s + r.compared, 0)))} of the decisions it could be compared on; the teacher could not rate ${pct(pool.reduce((s, r) => s + r.unsupported, 0) / Math.max(1, pool.reduce((s, r) => s + r.n, 0)))} of them itself`, '',
  '| why picked | match | student deck | lost | decisions | differ | unsupported |', '|---|---|---|---|---|---|---|',
  ...chosen.map((r) => `| ${r.because} | ${r.job} | ${r.deck} | ${r.lost ? 'yes' : 'no'} | ${r.n} | ${pct(r.disagreeShare)} | ${pct(r.unsupportedShare)} |`)];
if (opt.report) writeFileSync(opt.report, `${lines.join('\n')}\n`, 'utf8');
console.log(lines.slice(0, 4).join('\n'));
console.log(`${chosen.length} matches -> ${opt.out}` + Object.entries(chosen.reduce((m, r) => ({ ...m, [r.because]: (m[r.because] ?? 0) + 1 }), {})).map(([k, v]) => ` ${k}:${v}`).join(''));
