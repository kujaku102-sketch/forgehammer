#!/usr/bin/env node
// One round of the improvement loop (a student CPU that learns from a teacher, DAgger style):
//
//   node loop/round.mjs <config.json> <round> record       the student of the last round plays; the teacher looks at its decisions and answers are recorded (c);
//                                                         the student is analysed (a): loop/analyze.mjs -> round-<n>/analysis.md
//   (here the changes for the round are decided and written into round-<n>/plan.json: hammer arguments and a note on what was changed)  (b)
//   node loop/round.mjs <config.json> <round> train-eval   learn again from every record so far (d), make the CPU, measure it with the same yardstick, write the report
//
// Everything outside the repositories: the work folder of the config. The game and its rules are in the config (commit, variant), so a new rule is a new config and a new
// first round (the old records are of the old rule and are not mixed in; the header of every record says under which rules it was made).
//
// config.json:
//   { "szb": "<SZbattlefield>", "forge": "<forgehammer/packages/forge>", "work": "<work folder>",
//     "game": { "commit": "...", "variant": null, "source": "<game repository or url>", "clones": "<where checkouts go>" },
//     "baseOre": ["<records already made under these rules>", ...],
//     "student0": { "name": "loop0", "weights": "<weights.json of round 0>" },
//     "teacher": "lookahead", "workers": 5,
//     "record": { "firstSeed": 106, "seedsPerRound": 5 },
//     "eval": { "vsSimple": "1-10", "vsLookahead": "1-5" } }
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

const [configPath, roundArg, phase] = process.argv.slice(2);
if (!configPath || !roundArg || !['record', 'train-eval'].includes(phase)) { console.error('usage: round.mjs <config.json> <round> record|train-eval'); process.exit(2); }
const { config } = loadConfig({ argv: ['--config', configPath] });   // src/config.mjs: the settings of this machine (command line > FORGE_* > file > defaults)
const round = Number(roundArg);
const dir = path.join(config.work, `round-${round}`);
mkdirSync(dir, { recursive: true });
const seeds = (spec) => { const [a, b] = String(spec).split('-').map(Number); return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i).join(','); };
const log = (text) => console.log(`[round ${round} ${new Date().toTimeString().slice(0, 8)}] ${text}`);
const run = (command, args, opts = {}) => {
  log(`${path.basename(command)} ${args.slice(0, 6).join(' ')} ...`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status})`);
};
const gameEnv = { SZB_WORK: config.game.clones, GAME_SOURCE: config.game.source };
const szbRun = (args) => run(process.execPath, [path.join(config.szb, 'src/run.mjs'), ...args, '--commit', config.game.commit, ...(config.game.variant ? ['--variant', config.game.variant] : []), '--workers', String(config.workers ?? 5), '--max-matches', '1500'], { cwd: config.szb, env: gameEnv });
const forge = (args) => run(process.execPath, [path.join(config.forge, 'bin/forge.mjs'), ...args]);
const weightsOf = (n) => (n === 0 ? config.student0.weights : path.join(config.work, `round-${n}`, 'w.json'));
const nameOf = (n) => (n === 0 ? config.student0.name : `loop${n}`);
const cpuFile = (n) => path.join(config.szb, 'cpus', `forged-${nameOf(n)}.mjs`);
const oreDirsUpTo = (n) => [...config.baseOre, ...Array.from({ length: n }, (_, i) => i + 1).flatMap((r) => ['vsla', 'vssimple'].map((k) => path.join(config.work, `round-${r}`, 'ore', k))).filter(existsSync)];

if (phase === 'record') {
  // the student of the last round (round - 1) plays, the teacher answers every decision of it
  const student = nameOf(round - 1);
  if (!existsSync(cpuFile(round - 1))) forge(['smith', weightsOf(round - 1), '--out', cpuFile(round - 1), '--name', student]);
  const first = config.record.firstSeed + (round - 1) * config.record.seedsPerRound;
  const recordSeeds = seeds(`${first}-${first + config.record.seedsPerRound - 1}`);
  for (const [kind, opponent] of [['vsla', 'lookahead'], ['vssimple', 'simple']]) {
    if (existsSync(path.join(dir, 'ore', kind))) { log(`record ${kind} already there`); continue; }
    szbRun(['--a', `cpus/forged-${student}.mjs`, '--b', opponent, '--swap', '--seeds', recordSeeds, '--shadow', config.teacher, '--record', path.join(dir, 'ore', kind), '--out', path.join(dir, `record-${kind}`)]);
  }
  run(process.execPath, [path.join(config.forge, 'loop/analyze.mjs'), configPath, String(round)]);
  log(`recorded and analysed: ${path.join(dir, 'analysis.md')}. Write ${path.join(dir, 'plan.json')} ({ "hammer": [...], "note": "..." }) and run train-eval.`);
} else {
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const ore = oreDirsUpTo(round);
  if (!existsSync(weightsOf(round))) forge(['hammer', ...ore, '--out', weightsOf(round), '--quiet', ...plan.hammer]);
  forge(['smith', weightsOf(round), '--out', cpuFile(round), '--name', nameOf(round)]);
  const cpu = `cpus/forged-${nameOf(round)}.mjs`;
  for (const [kind, opponent, spec] of [['vs-simple', 'simple', config.eval.vsSimple], ['vs-lookahead', 'lookahead', config.eval.vsLookahead]]) {
    const out = path.join(dir, 'eval', kind);
    if (!existsSync(path.join(out, 'raw.jsonl'))) szbRun(['--a', cpu, '--b', opponent, '--swap', '--seeds', seeds(spec), '--out', out]);
    run(process.execPath, [path.join(config.szb, 'src/arena.mjs'), out]);
  }
  run(process.execPath, [path.join(config.forge, 'loop/report.mjs'), configPath, String(round)]);
  log(`done: ${path.join(config.work, `周-${round}.md`)}`);
}
