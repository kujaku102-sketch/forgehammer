#!/usr/bin/env node
// forge info <ore...>                              what the records hold
// forge hammer <ore...> --out weights.json [options]   learn one weight vector
// forge smith weights.json --out <file.mjs> --name <name>   write the CPU module
// forge ore merge <ore...> --out <dir> [--expect jobs.txt]  put records together (checks headers, hashes, duplicates, and what a table expects)
// forge audit build <text-logs...> --out <dir> [--marks marks.jsonl]   a static report (open index.html) to read the decisions and mark them (adopt / reject / hold)
// forge audit apply <marks.jsonl...> --text <text-logs...> --out marks.jsonl   check the exported marks against the logs and put them together
// forge bundle pack <dir> --kind ore|weights|eval|report [--round n] [--meta meta.json] | forge bundle verify <dir>   a stage's result as a bundle with hashes
//
// hammer options (defaults in brackets):
//   --method softmax|pairwise|ridge|staged [softmax]   (staged: score the legal actions first, then the options of the best one: two weight vectors)   --target chosen|teacher|mix [chosen]   --mix 0.5 --tau 2 --fill 0.01
//   --why all|own|<list>      which decisions are learned from: the teacher's own moves only, or those it left to the game's CPU too [all]
//   --sources lookahead:1.0,llm:0.5   how much each source of decisions counts (the "src" of a decision; none written = lookahead); 0 leaves a source out
//   --audit marks.jsonl --audit-mode drop-rejected|only-adopted|weight   what the marks of an audit do: leave out the rejected / keep only the adopted / adopted count double, rejected not at all
//   --advantage value|result|none [value]   --beta 1   (how a decision is weighted by how the match went)
//   --epochs 40 --lr 0.05 --l2 1e-4 --seed 1 --val 0.2 (the part of the matches kept apart)   --only-types (learn from the move kind alone: the floor to beat)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readOre } from '../src/ore.mjs';
import { buildDataset, entryView, optionView, splitByMatch } from '../src/data.mjs';
import { breakdown, evaluate, evaluateStaged, fitValueModel, setWeights, train, trainStaged, typeOf } from '../src/hammer.mjs';
import { forgeModule } from '../src/smith.mjs';
import { applyCross, crossSpec } from '../src/cross.mjs';
import { mergeOre, readExpected } from '../src/ore-merge.mjs';
import { packBundle, verifyBundle } from '../src/bundle.mjs';
import { applyMarks, buildAudit, loadMarks } from '../src/audit.mjs';

const [command, ...rest] = process.argv.slice(2);
const isGroup = (command === 'ore' || command === 'bundle' || command === 'audit');
const positional = []; const args = {};
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) { const key = rest[i].slice(2); args[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else positional.push(rest[i]);
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;

function describe(ore) {
  const byWhy = {}; const finished = [...ore.matches.values()].filter((m) => m.status === 'finished').length;
  for (const d of ore.decisions) byWhy[d.why] = (byWhy[d.why] ?? 0) + 1;
  console.log(`files ${ore.files.length}; matches ${ore.matches.size} (${finished} finished); decisions ${ore.decisions.length}; dropped ${JSON.stringify(ore.dropped)}`);
  console.log(`features v${ore.header.featureVersion}: ${ore.header.featureNames.length} candidate, ${ore.header.stateNames.length} state; game ${ore.header.game?.commit?.slice(0, 7)}; cpus ${JSON.stringify(ore.header.cpus)}`);
  console.log(`why: ${JSON.stringify(byWhy)}`);
}

if (isGroup) {
  const [sub, ...more] = rest; const parsed = { pos: [], args: {} };
  for (let i = 0; i < more.length; i += 1) { if (more[i].startsWith('--')) { const key = more[i].slice(2); parsed.args[key] = more[i + 1] && !more[i + 1].startsWith('--') ? more[++i] : true; } else parsed.pos.push(more[i]); }
  if (command === 'ore' && sub === 'merge') {
    if (typeof parsed.args.out !== 'string') throw new Error('--out <dir>');
    const result = mergeOre(parsed.pos, parsed.args.out, { expect: typeof parsed.args.expect === 'string' ? readExpected(parsed.args.expect) : null });
    console.log(`merged ${result.matches} matches (${result.decisions} decisions) into ${result.file}; dropped ${JSON.stringify(result.dropped)}`);
    if (result.missing.length || result.extra.length) { console.log(`missing from the table: ${result.missing.length} (${result.missing.slice(0, 5).join(', ')}); not in the table: ${result.extra.length}`); process.exit(1); }
  } else if (command === 'audit' && sub === 'build') {
    if (typeof parsed.args.out !== 'string') throw new Error('--out <dir>');
    const result = buildAudit(parsed.pos, parsed.args.out, { marks: typeof parsed.args.marks === 'string' ? loadMarks(parsed.args.marks) : null });
    console.log(`audit report: ${result.matches} matches, ${result.decisions} decisions -> ${path.join(parsed.args.out, 'index.html')}`);
  } else if (command === 'audit' && sub === 'apply') {
    if (typeof parsed.args.out !== 'string' || typeof parsed.args.text !== 'string') throw new Error('--text <text-logs> --out marks.jsonl');
    const n = applyMarks(parsed.pos, [parsed.args.text], parsed.args.out);
    console.log(`${n} marks written to ${parsed.args.out}`);
  } else if (command === 'bundle' && sub === 'pack') {
    const dirName = parsed.pos[0]; const meta = typeof parsed.args.meta === 'string' ? JSON.parse(readFileSync(parsed.args.meta, 'utf8')) : {};
    const manifest = packBundle(dirName, { ...meta, kind: parsed.args.kind, round: parsed.args.round !== undefined ? Number(parsed.args.round) : meta.round });
    console.log(`bundle ${manifest.kind} ${manifest.id.slice(0, 12)}: ${Object.keys(manifest.files).length} files`);
  } else if (command === 'bundle' && sub === 'verify') {
    const result = verifyBundle(parsed.pos[0]);
    console.log(result.ok ? `bundle ok (${result.manifest.kind} ${result.manifest.id.slice(0, 12)}, ${Object.keys(result.manifest.files).length} files)` : `bundle NOT ok:\n  ${result.problems.join('\n  ')}`);
    process.exit(result.ok ? 0 : 1);
  } else console.log('forge ore merge ... | forge bundle pack|verify ...');
} else if (command === 'info') {
  describe(readOre(positional));
} else if (command === 'hammer') {
  if (typeof args.out !== 'string') throw new Error('--out weights.json');
  const ore = readOre(positional); describe(ore);
  let finishedOnly = ore.decisions.filter((d) => d.match.status === 'finished');
  const sourceWeights = typeof args.sources === 'string' ? Object.fromEntries(args.sources.split(',').map((x) => { const [k, v] = x.split(':'); return [k, Number(v)]; })) : null;
  if (sourceWeights) finishedOnly = finishedOnly.filter((d) => (sourceWeights[d.src ?? 'lookahead'] ?? 1) > 0);
  if (typeof args.audit === 'string') {
    const marks = loadMarks(args.audit); const mode = args['audit-mode'] ?? 'drop-rejected';
    const status = (d) => marks.get(`${d.job}|${d.seat}|${d.rev}`)?.status;
    const before = finishedOnly.length;
    if (mode === 'drop-rejected' || mode === 'weight') finishedOnly = finishedOnly.filter((d) => status(d) !== 'reject');
    else if (mode === 'only-adopted') finishedOnly = finishedOnly.filter((d) => status(d) === 'adopt');
    console.log(`audit (${mode}): ${marks.size} marks, ${before - finishedOnly.length} decisions left out`);
    if (mode === 'weight') for (const d of finishedOnly) d.auditWeight = status(d) === 'adopt' ? 2 : 1;
  }
  if (sourceWeights) for (const d of finishedOnly) d.sourceWeight = sourceWeights[d.src ?? 'lookahead'] ?? 1;
  let ds = buildDataset(finishedOnly, ore.header, { why: args.why ?? 'all' });
  let cross = null;
  if (typeof args.cross === 'string') {
    if ((args.method ?? 'softmax') === 'staged') throw new Error('--cross is for the flat CPU');
    cross = crossSpec(ore.header.featureNames, ore.header.stateNames, args.cross);
    ds = applyCross(ds, cross, ore.header.featureNames, ore.header.stateNames);
    console.log(`cross ${cross.preset}: ${cross.rows.length} candidate features x ${cross.cols.length} state features = ${cross.rows.length * cross.cols.length} more, ${ds.F} in all`);
  }
  const { train: trainRows, val: valRows } = splitByMatch(ds, Number(args.val ?? 0.2), Number(args.seed ?? 1));
  console.log(`learning from ${ds.n} decisions with at least 2 candidates (${ds.M} candidates): ${trainRows.length} to learn, ${valRows.length} kept apart (whole matches)`);
  const advantage = args.advantage ?? 'value';
  const valueModel = advantage === 'value' ? fitValueModel(ds, trainRows, { seed: Number(args.seed ?? 1) }) : null;
  setWeights(ds, trainRows, { mode: advantage, beta: Number(args.beta ?? 1), valueModel });
  const names = ore.header.featureNames;
  const mask = args['only-types'] ? names.map((n) => n.startsWith('type_')) : null;
  const options = {
    method: args.method ?? 'softmax', target: args.target ?? 'chosen', mix: Number(args.mix ?? 0.5), tau: Number(args.tau ?? 2), fill: Number(args.fill ?? 0.01),
    epochs: Number(args.epochs ?? 40), lr: Number(args.lr ?? 0.05), l2: Number(args.l2 ?? 1e-4), seed: Number(args.seed ?? 1), mask, valRows, log: args.quiet ? () => {} : console.log
  };
  const started = Date.now();
  if (options.method === 'staged') {
    const eView = entryView(ds); const oView = optionView(ds);
    const staged = trainStaged(ds, trainRows, { ...options, method: 'softmax' }, eView, oView, valRows);
    const joint = evaluateStaged(ds, eView, oView, staged.entry.w, staged.option.w, valRows);
    const jointTrain = evaluateStaged(ds, eView, oView, staged.entry.w, staged.option.w, trainRows);
    console.log(`\nstaged, advantage ${advantage}, why ${args.why ?? 'all'}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(`  kept apart: entry top-1 ${pct(joint.entryTop1)} (n ${joint.n}); option top-1 ${pct(joint.optionTop1)} (n ${joint.optionN}, the teacher's entry given); both ${pct(joint.jointTop1)}`);
    console.log(`  learn: entry ${pct(jointTrain.entryTop1)}; option ${pct(jointTrain.optionTop1)}; both ${pct(jointTrain.jointTop1)}`);
    const outStaged = { kind: 'forge-weights', schema: 1, featureVersion: ore.header.featureVersion, featureNames: names, w: [], w_entry: Array.from(staged.entry.w), w_option: Array.from(staged.option.w),
      meta: { method: 'staged', target: 'chosen', why: args.why ?? 'all', advantage, beta: Number(args.beta ?? 1), epochs: options.epochs, lr: options.lr, l2: options.l2, seed: options.seed,
        dataset: { decisions: ds.n, matches: new Set(ds.jobs).size, teacher: JSON.stringify(ore.header.cpus), game: ore.header.game?.commit ?? null, rules: ore.header.rules ?? null },
        validation: { n: joint.n, top1: joint.jointTop1, entryTop1: joint.entryTop1, optionTop1: joint.optionTop1 }, createdAt: new Date().toISOString() } };
    writeFileSync(args.out, `${JSON.stringify(outStaged, null, 1)}\n`);
    console.log(`weights written to ${args.out}`);
    process.exit(0);
  }
  const trained = train(ds, trainRows, options);
  const trainEval = evaluate(ds, trained.w, trainRows); const valEval = evaluate(ds, trained.w, valRows);
  console.log(`\n${options.method}${options.method === 'softmax' ? `/${options.target}` : ''}, advantage ${advantage}, why ${args.why ?? 'all'}${mask ? ', move kind only' : ''}; best epoch ${trained.bestEpoch}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`  learn: top-1 ${pct(trainEval.top1)}  top-3 ${pct(trainEval.top3)}  mean rank ${trainEval.meanRank.toFixed(2)}  (chance top-1 ${pct(trainEval.chanceTop1)})`);
  console.log(`  kept apart: top-1 ${pct(valEval.top1)}  top-3 ${pct(valEval.top3)}  mean rank ${valEval.meanRank.toFixed(2)}  nll ${valEval.nll.toFixed(3)}  (chance top-1 ${pct(valEval.chanceTop1)}; n ${valEval.n})`);
  const split = (label, rows) => breakdown(ds, names, trained.w, rows, label).map((g) => `${g.label}: ${pct(g.top1)} (n ${g.n}, chance ${pct(g.chance)})`).join('\n    ');
  console.log(`  kept apart, by why the teacher chose it:\n    ${split((i) => `${ds.whys[i]}${ds.baselineChosen[i] ? ' (left to the game CPU)' : ''}`, valRows)}`);
  console.log(`  kept apart, by the kind of move chosen:\n    ${split((i) => typeOf(ds, names, ds.cOff[i] + ds.chosen[i]), valRows)}`);
  const out = {
    kind: 'forge-weights', schema: 1, featureVersion: ore.header.featureVersion, featureNames: names, w: Array.from(trained.w), ...(cross ? { cross } : {}),
    meta: {
      method: options.method, target: options.target, why: args.why ?? 'all', advantage, beta: Number(args.beta ?? 1), epochs: options.epochs, lr: options.lr, l2: options.l2, seed: options.seed,
      dataset: { decisions: ds.n, matches: new Set(ds.jobs).size, teacher: JSON.stringify(ore.header.cpus), game: ore.header.game?.commit ?? null },
      validation: { n: valEval.n, top1: valEval.top1, top3: valEval.top3, meanRank: valEval.meanRank, nll: valEval.nll, chanceTop1: valEval.chanceTop1 },
      createdAt: new Date().toISOString()
    }
  };
  writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`weights written to ${args.out}`);
} else if (command === 'smith') {
  const weights = JSON.parse(readFileSync(positional[0], 'utf8'));
  if (typeof args.out !== 'string' || typeof args.name !== 'string') throw new Error('--out <file.mjs> --name <name>');
  writeFileSync(args.out, forgeModule(weights, { name: args.name }));
  console.log(`CPU module written to ${args.out} (id forged:${args.name})`);
} else {
  console.log('forge info <ore...> | forge hammer <ore...> --out weights.json [options] | forge smith weights.json --out file.mjs --name name');
}
