#!/usr/bin/env node
// Playing one round's matches in several places at once (this machine, GitHub Actions, Colab), and putting the results together.
//
//   node loop/dist.mjs plan    <dist.json>                       who plays which shards, and what to start in each place
//   node loop/dist.mjs collect <dist.json> <root>... --out <dir>  put the results found under the roots together (raw with merge.mjs, records with `forge ore merge`)
//
// dist.json:
//   { "sites": { "local": 2, "actions": 4, "colab": 2 },        shards for each place, in this order: local gets 1..2, actions 3..6, colab 7..8 (the table is cut into 8 shards)
//     "szb": "<SZbattlefield checkout>", "game": { "commit": "<full sha>", "node": "24.19.0" },
//     "tables": [ { "name": "vs-simple", "a": "cpus/forged-loop1.mjs", "b": "simple", "seeds": "301,302,303,304,305", "swap": true, "shadow": "lookahead", "record": true, "decks": "start-red,ctl-1" (optional: start deck ids and/or decks/<name>.json of SZbattlefield), "simPrior": "seen" (optional: where a CPU that looks ahead draws the other side's hidden cards from; default real) }, ... ] }
//
// Every place writes the same layout:   <root>/<table name>/shard-<i>-of-<N>/{raw.jsonl,env.json,config.json}   and, when it records,   <root>/<table name>/ore/ore-*.jsonl.gz
// `collect` reads all roots (a place's folder, a downloaded artifact, a Drive folder) and refuses what merge.mjs refuses: another environment (node, game commit, CPU versions, rules),
// matches in two results that differ, a table that is not the same. It says which shards are missing and in which place they were assigned, and prints what to start to play them somewhere else:
// a shard can be played again anywhere (the same shard is the same matches, and a shard that is partly played continues from its raw.jsonl).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, configPath, ...rest] = process.argv.slice(2);
if (!['plan', 'collect'].includes(mode) || !configPath) { console.error('usage: dist.mjs plan|collect <dist.json> [<root>... --out dir]'); process.exit(2); }
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const here = path.dirname(fileURLToPath(import.meta.url));
const forgeBin = path.join(here, '../bin/forge.mjs');

const sites = Object.entries(cfg.sites);
const total = sites.reduce((s, [, n]) => s + n, 0);
const assign = {}; let next = 1;
for (const [site, n] of sites) { assign[site] = Array.from({ length: n }, () => next++); }
const siteOf = (shard) => sites.find(([site]) => assign[site].includes(shard))?.[0];

// a persona (cpus/personas/<name>.json, "persona": "control" in the table) is given to the CPUs that look ahead (lookahead, deep) named in the table, the shadow teacher too; "style": true counts how each seat played
const specOf = (t, cpu) => (t.persona && ['lookahead', 'deep'].includes(cpu) ? `${cpu}?persona=${t.persona}` : cpu);
const tableArgs = (t) => [`--a "${specOf(t, t.a)}"`, `--b "${specOf(t, t.b)}"`, `--seeds ${t.seeds}`, ...(t.swap ? ['--swap'] : []), ...(t.shadow ? [`--shadow "${specOf(t, t.shadow)}"`] : []), ...(t.style ? ['--style'] : []), ...(t.decks ? [`--decks ${t.decks}`] : []), ...(t.simPrior === 'seen' ? ['--sim-prior seen'] : [])];

function plan() {
  console.log(`# ${total} shards: ${sites.map(([site, n]) => `${site} ${n} (${assign[site].join(',')})`).join(', ')}`);
  console.log(`# every place: node ${cfg.game.node}, game ${cfg.game.commit}, the same CPU files and rules\n`);
  for (const [site, shards] of Object.entries(assign)) {
    if (shards.length === 0) continue;
    console.log(`## ${site}: shards ${shards.join(', ')} of ${total}`);
    if (site === 'local') {
      for (const t of cfg.tables) for (const i of shards) {
        console.log(`node src/run.mjs ${tableArgs(t).join(' ')} --shard ${i}/${total} --commit ${cfg.game.commit} --max-matches 1500 ${t.record ? `--record <root>/${t.name}/ore ` : ''}--out <root>/${t.name}/shard-${i}-of-${total}`);
      }
    } else if (site === 'actions') {
      console.log('(workflow play-shards.yml, one start for each table; the CPU file goes in as cpu_gz_b64 with its sha256)');
      for (const t of cfg.tables) console.log(`gh workflow run play-shards.yml -f game_commit=${cfg.game.commit} -f table=${t.name} -f cpu_a="${specOf(t, t.a)}" -f cpu_b="${specOf(t, t.b)}" -f seeds=${t.seeds} -f swap=${Boolean(t.swap)} -f shadow=${t.shadow ? specOf(t, t.shadow) : ''} -f record=${Boolean(t.record)} -f style=${Boolean(t.style)} -f decks=${t.decks ?? ''} -f sim_prior=${t.simPrior === 'seen' ? 'seen' : 'real'} -f shard_total=${total} -f shards=${shards.join(',')}`);
    } else if (site === 'colab') {
      console.log('(notebooks/szb_shard.ipynb: set these in the first cell, run the cells; the same cell again continues a stopped shard)');
      for (const t of cfg.tables) console.log(`NAME="${t.name}"  CPU_A="${t.a}" CPU_B="${t.b}" PERSONA="${t.persona ?? ''}" DECKS="${t.decks ?? ''}" STYLE=${t.style ? 'True' : 'False'} SIM_PRIOR="${t.simPrior === 'seen' ? 'seen' : 'real'}" SEEDS="${t.seeds}" SWAP=${t.swap ? 'True' : 'False'} SHARDS=[${shards.join(', ')}] TOTAL=${total} SHADOW="${t.shadow ?? ''}" RECORD=${t.record ? 'True' : 'False'}`);
    }
    console.log('');
  }
}

function collect() {
  const outIndex = rest.indexOf('--out');
  if (outIndex < 0) { console.error('--out <dir>'); process.exit(2); }
  const out = path.resolve(rest[outIndex + 1]);
  const roots = rest.filter((token, index) => index !== outIndex && index !== outIndex + 1).map((r) => path.resolve(r));
  mkdirSync(out, { recursive: true });
  let bad = false;
  for (const t of cfg.tables) {
    const runs = []; const ores = [];
    for (const root of roots) {
      const dir = path.join(root, t.name);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) if (/^shard-\d+-of-\d+$/.test(name) && existsSync(path.join(dir, name, 'raw.jsonl'))) runs.push(path.join(dir, name));
      if (existsSync(path.join(dir, 'ore'))) ores.push(path.join(dir, 'ore'));
    }
    console.log(`\n== ${t.name}: ${runs.length} shard folders, ${ores.length} record folders`);
    if (runs.length === 0) { bad = true; console.log('nothing found'); continue; }
    const merged = spawnSync(process.execPath, [path.join(cfg.szb, 'src/merge.mjs'), '--out', path.join(out, t.name), ...runs], { encoding: 'utf8' });
    process.stdout.write(merged.stdout.split('\n').slice(0, 12).join('\n') + '\n');
    if (merged.stderr) process.stdout.write(merged.stderr);
    if (merged.status !== 0) {
      bad = true;
      const reportFile = path.join(out, t.name, 'merge-report.json');
      if (existsSync(reportFile)) {
        const report = JSON.parse(readFileSync(reportFile, 'utf8'));
        const missingShards = new Set(Object.keys(report.missingByShard ?? {}).map((key) => Number(key.split('/')[0])));
        if (missingShards.size > 0) {
          console.log(`missing shards: ${[...missingShards].map((i) => `${i} (assigned to ${siteOf(Number(i))})`).join(', ')}`);
          console.log(`play them again anywhere: the same command with --shard <i>/${total} (see "plan"); a partly played shard continues from its raw.jsonl`);
        }
      }
    }
    if (t.style && merged.status === 0) {
      const report = spawnSync(process.execPath, [path.join(cfg.szb, 'src/style-report.mjs'), path.join(out, t.name)], { encoding: 'utf8' });
      if (report.status === 0) { process.stdout.write(`\nhow the CPUs played:\n${report.stdout}`); writeFileSync(path.join(out, t.name, 'style.md'), report.stdout); }
    }
    if (t.record && ores.length > 0) {
      const mergedOre = spawnSync(process.execPath, [forgeBin, 'ore', 'merge', ...ores, '--out', path.join(out, t.name, 'ore')], { encoding: 'utf8' });
      process.stdout.write(mergedOre.stdout + (mergedOre.stderr ?? ''));
      if (mergedOre.status !== 0) bad = true;
    }
  }
  console.log(bad ? '\nNOT complete (see above)' : '\nall tables complete');
  process.exit(bad ? 1 : 0);
}

(mode === 'plan' ? plan : collect)();
