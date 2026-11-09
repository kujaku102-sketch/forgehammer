#!/usr/bin/env node
// forge info <ore...>                              what the records hold
// forge hammer <ore...> --out weights.json [options]   learn one weight vector
// forge smith weights.json --out <file.mjs> --name <name> [--topk k=3,reader=deep|one,samples=2,own=3,opp=3]   write the CPU module
// forge ore merge <ore...> --out <dir> [--expect jobs.txt]  put records together (checks headers, hashes, duplicates, and what a table expects)
// forge audit export-md <text-logs...> --out file.md [--title t] [--all] [--only llm] [--max N]   the disagreements as one markdown file to write the marks into (phone or PC)
// forge audit import-md <file.md...> --out marks.jsonl [--by 名前]            read the written-in file back into marks (loosely; sections it cannot read are listed, exit code 3)
// forge audit build <text-logs...> --out <dir> [--marks marks.jsonl] [--open-diff]   a static report (open index.html) to read the decisions and mark them (adopt / reject / hold)
// forge audit apply <marks.jsonl...> --text <text-logs...> --out marks.jsonl   check the exported marks against the logs and put them together
// forge bundle pack <dir> --kind ore|weights|eval|report [--round n] [--meta meta.json] | forge bundle verify <dir>   a stage's result as a bundle with hashes
//
// hammer options (defaults in brackets):
//   --method softmax|pairwise|ridge|staged [softmax]   (staged: score the legal actions first, then the options of the best one: two weight vectors)   --target chosen|teacher|mix [chosen]   --mix 0.5 --tau 2 --fill 0.01
//   --why all|own|<list>      which decisions are learned from: the teacher's own moves only, or those it left to the game's CPU too [all]
//   --sources lookahead:1.0,llm:0.5   how much each source of decisions counts (the "src" of a decision; none written = lookahead); 0 leaves a source out
//   --audit marks.jsonl --audit-mode llm-marks [--audit-weights adopt=3,correct=4,rule=6,teacher=2]   what a person said about the language model's moves decides those records (see the code)
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
import { evaluateMlp, mlpWeights, trainMlp } from '../src/mlp.mjs';
import { mergeOre, readExpected } from '../src/ore-merge.mjs';
import { packBundle, verifyBundle } from '../src/bundle.mjs';
import { applyMarks, buildAudit, loadMarks } from '../src/audit.mjs';
import { exportMd, importMd, writeMarks } from '../src/auditmd.mjs';

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
    const result = buildAudit(parsed.pos, parsed.args.out, { marks: typeof parsed.args.marks === 'string' ? loadMarks(parsed.args.marks) : null, open: parsed.args['open-diff'] ? { all: true, diff: true } : null });
    console.log(`audit report: ${result.matches} matches, ${result.decisions} decisions -> ${path.join(parsed.args.out, 'index.html')}`);
  } else if (command === 'audit' && sub === 'export-md') {
    if (typeof parsed.args.out !== 'string') throw new Error('--out file.md');
    const result = exportMd(parsed.pos, parsed.args.out, { title: typeof parsed.args.title === 'string' ? parsed.args.title : 'audit', all: Boolean(parsed.args.all), only: typeof parsed.args.only === 'string' ? parsed.args.only : null, max: parsed.args.max ? Number(parsed.args.max) : Infinity });
    console.log(`markdown: ${result.sections} sections of ${result.decisions} decisions -> ${parsed.args.out}`);
  } else if (command === 'audit' && sub === 'import-md') {
    if (typeof parsed.args.out !== 'string') throw new Error('--out marks.jsonl');
    const result = importMd(parsed.pos, { by: typeof parsed.args.by === 'string' ? parsed.args.by : '文豪' });
    writeMarks(result.marks, parsed.args.out);
    console.log(`${result.sections} sections: ${result.marks.length} marks written to ${parsed.args.out}, ${result.blank} left blank, ${result.unreadable.length} could not be read`);
    for (const u of result.unreadable) console.log(`  unreadable: ${path.basename(u.file)} line ${u.line} ${u.heading}: ${u.reason}`);
    if (result.unreadable.length) process.exitCode = 3;
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
  // --audit marks.jsonl --audit-mode llm-marks: what a person said about the language model's moves (the marks of 'forge audit import-md') decides these records.
  //   adopt                 the model's move is taken: its record is kept with a heavy weight; the looking-ahead teacher's record of the same decision is left out
  //   reject + correct N    neither: the right move N (the number in the prompt) becomes the record's move, heavy; the teacher's record of the same decision is left out
  //   reject                the teacher's move is taken: the model's record is left out; the teacher's record of the same decision gets a weight
  // a note that names a line of the rules (":266") counts for more. --audit-weights adopt=3,correct=4,rule=6,teacher=2
  const pinned = new Set();
  if (typeof args.audit === 'string' && args['audit-mode'] === 'llm-marks') {
    const marks = loadMarks(args.audit);
    const w = { adopt: 3, correct: 4, rule: 6, teacher: 2, ...(typeof args['audit-weights'] === 'string' ? Object.fromEntries(args['audit-weights'].split(',').map((x) => { const [k, v] = x.split('='); return [k, Number(v)]; })) : {}) };
    const idOf = (d) => `${d.job}|${d.seat}|${d.rev}`;
    const isLlm = (d) => String(d.src ?? '').startsWith('llm');
    const rule = (m) => /:\d{2,4}/.test(m?.note ?? '');
    const left = []; const stats = { adopt: 0, correct: 0, rejectModel: 0, teacherKept: 0, teacherOut: 0, outOfRange: 0 };
    for (const d of finishedOnly) {
      const m = marks.get(idOf(d));
      if (!m) { left.push(d); continue; }
      const heavy = rule(m);
      if (m.status === 'adopt') {
        if (isLlm(d)) { d.pinned = heavy ? w.rule : w.adopt; stats.adopt += 1; left.push(d); } else stats.teacherOut += 1;
      } else if (m.status === 'reject' && Number.isInteger(m.correct)) {
        if (isLlm(d)) {
          if (m.correct >= 1 && m.correct <= d.c.length) { d.k = m.correct - 1; d.pinned = heavy ? w.rule : w.correct; stats.correct += 1; left.push(d); } else stats.outOfRange += 1;
        } else stats.teacherOut += 1;
      } else if (m.status === 'reject') {
        if (isLlm(d)) stats.rejectModel += 1; else { d.pinned = heavy ? w.rule : w.teacher; stats.teacherKept += 1; left.push(d); }
      } else left.push(d);                       // hold: nothing changes
    }
    finishedOnly = left;
    for (const d of finishedOnly) if (d.pinned !== undefined) pinned.add(d);
    console.log(`audit (llm-marks): ${marks.size} marks; adopted model records ${stats.adopt}, corrected ${stats.correct} (${stats.outOfRange} numbers out of range), model records left out ${stats.rejectModel}, teacher records kept ${stats.teacherKept} / left out ${stats.teacherOut}; weights ${JSON.stringify(w)}`);
  }
  const sourceWeights = typeof args.sources === 'string' ? Object.fromEntries(args.sources.split(',').map((x) => { const [k, v] = x.split(':'); return [k, Number(v)]; })) : null;
  if (sourceWeights) finishedOnly = finishedOnly.filter((d) => d.pinned !== undefined || (sourceWeights[d.src ?? 'lookahead'] ?? 1) > 0);
  if (typeof args.audit === 'string' && args['audit-mode'] !== 'llm-marks') {
    const marks = loadMarks(args.audit); const mode = args['audit-mode'] ?? 'drop-rejected';
    const status = (d) => marks.get(`${d.job}|${d.seat}|${d.rev}`)?.status;
    const before = finishedOnly.length;
    if (mode === 'drop-rejected' || mode === 'weight') finishedOnly = finishedOnly.filter((d) => status(d) !== 'reject');
    else if (mode === 'only-adopted') finishedOnly = finishedOnly.filter((d) => status(d) === 'adopt');
    console.log(`audit (${mode}): ${marks.size} marks, ${before - finishedOnly.length} decisions left out`);
    if (mode === 'weight') for (const d of finishedOnly) d.auditWeight = status(d) === 'adopt' ? 2 : 1;
  }
  if (sourceWeights) for (const d of finishedOnly) d.sourceWeight = sourceWeights[d.src ?? 'lookahead'] ?? 1;
  for (const d of finishedOnly) if (d.pinned !== undefined) d.sourceWeight = d.pinned;
  let ds = buildDataset(finishedOnly, ore.header, { why: args.why ?? 'all' });
  // The dataset is flat typed arrays now; the parsed decisions (every candidate a list of [index, value] pairs: 3 GB and more for 1.5 million candidates) are not needed again.
  // Let go of them before learning starts: with them kept, a round of 3,500 matches ran out of the node heap (about 3.4 GB) in the training (loop-round run 42678798741).
  finishedOnly = []; pinned.clear(); ore.decisions = [];
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
  if (options.method === 'mlp') {
    // a small network: z = v . relu(W1 . phi + U1 . s + b1) + lin . phi  (src/mlp.mjs); --hidden 32 --lr 0.01
    const hidden = Number(args.hidden ?? 32); const mlpLr = Number(args.lr ?? 0.01);
    // --residual: the linear scorer is learned first (as always) and held fixed; the network learns only the correction, with a stronger l2 (--mlp-l2, 1e-3): the linear part stays the main part,
    // and it is a CPU by itself (--linear-out) for what carries over to cards that do not exist yet
    let linear = null;
    if (args.residual) {
      linear = train(ds, trainRows, { ...options, method: 'softmax', target: 'chosen' });
      const linVal = evaluate(ds, linear.w, valRows);
      console.log(`linear part alone (kept apart): top-1 ${pct(linVal.top1)}  top-3 ${pct(linVal.top3)}  nll ${linVal.nll.toFixed(3)}`);
      if (typeof args['linear-out'] === 'string') writeFileSync(args['linear-out'], `${JSON.stringify({ kind: 'forge-weights', schema: 1, featureVersion: ore.header.featureVersion, featureNames: names, w: Array.from(linear.w), meta: { method: 'softmax', target: 'chosen', why: args.why ?? 'all', advantage, epochs: options.epochs, lr: options.lr, l2: options.l2, seed: options.seed, validation: { n: linVal.n, top1: linVal.top1, top3: linVal.top3, nll: linVal.nll }, createdAt: new Date().toISOString() } }, null, 1)}\n`);
    }
    const trainedNet = trainMlp(ds, trainRows, { hidden, epochs: options.epochs, lr: mlpLr, l2: args.residual ? Number(args['mlp-l2'] ?? 1e-3) : options.l2, seed: options.seed, valRows, log: options.log, base: linear ? linear.w : null, freezeLin: Boolean(args.residual) });
    const trainEvalNet = evaluateMlp(ds, trainedNet.net, trainRows); const valEvalNet = evaluateMlp(ds, trainedNet.net, valRows, { names });
    console.log(`\nmlp (hidden ${hidden}), advantage ${advantage}, why ${args.why ?? 'all'}; best epoch ${trainedNet.bestEpoch}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(`  learn: top-1 ${pct(trainEvalNet.top1)}  top-3 ${pct(trainEvalNet.top3)}`);
    console.log(`  kept apart: top-1 ${pct(valEvalNet.top1)}  top-3 ${pct(valEvalNet.top3)}  nll ${valEvalNet.nll.toFixed(3)}  (n ${valEvalNet.n})`);
    console.log('  kept apart, by the kind of move chosen:\n    ' + Object.entries(valEvalNet.byType).sort((a, b) => b[1].n - a[1].n).map(([t, g]) => `${t}: ${pct(g.top1)} (n ${g.n})`).join('\n    '));
    const outNet = { kind: 'forge-weights', schema: 1, featureVersion: ore.header.featureVersion, featureNames: names, w: [], mlp: mlpWeights(trainedNet.net),
      meta: { method: args.residual ? 'mlp-residual' : 'mlp', hidden, why: args.why ?? 'all', advantage, beta: Number(args.beta ?? 1), epochs: options.epochs, lr: mlpLr, l2: options.l2, seed: options.seed,
        dataset: { decisions: ds.n, matches: new Set(ds.jobs).size, teacher: JSON.stringify(ore.header.cpus), game: ore.header.game?.commit ?? null },
        validation: { n: valEvalNet.n, top1: valEvalNet.top1, top3: valEvalNet.top3, nll: valEvalNet.nll }, createdAt: new Date().toISOString() } };
    writeFileSync(args.out, `${JSON.stringify(outNet)}\n`);
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
  // --topk k=3,reader=deep,samples=2: a reader looks at the best few moves by score (SZbattlefield cpus/topk-core.mjs); the CPU then needs the sim
  const topk = typeof args.topk === 'string' ? Object.fromEntries(args.topk.split(',').map((x) => { const [key, value] = x.split('='); return [key, Number.isFinite(Number(value)) ? Number(value) : value]; })) : null;
  writeFileSync(args.out, forgeModule(weights, { name: args.name, topk }));
  console.log(`CPU module written to ${args.out} (id forged:${args.name})`);
} else {
  console.log('forge info <ore...> | forge hammer <ore...> --out weights.json [options] | forge smith weights.json --out file.mjs --name name');
}
