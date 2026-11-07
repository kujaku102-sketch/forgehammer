// Reading ore: the decisions a teacher CPU made, written by SZbattlefield (docs/ORE-FORMAT.md). Checks as it reads:
// a block of decisions counts only if its closing "match" line is there, the count is right and the hash agrees; anything else is dropped
// and counted, never half-used.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants, gunzipSync } from 'node:zlib';
import path from 'node:path';

const gunzip = (buffer) => {
  try { return gunzipSync(buffer).toString('utf8'); }
  catch {
    // a file that was cut in the middle of its last member: what was complete before it is still read
    return gunzipSync(buffer, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
  }
};

export function oreFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (statSync(input).isDirectory()) for (const name of readdirSync(input).sort()) { if (/^ore-.*\.jsonl\.gz$/.test(name)) files.push(path.join(input, name)); }
    else files.push(input);
  }
  return files;
}

// Returns { header, decisions: [...], matches: Map(job -> match line), dropped: { blocks, lines, reasons } }.
// Every decision line is kept as parsed; `d.match` is its match line.
export function readOre(inputs, { keepRaw = false } = {}) {
  const files = oreFiles(inputs);
  if (files.length === 0) throw new Error(`no ore-*.jsonl.gz in ${inputs.join(', ')}`);
  let header = null;
  const decisions = []; const matches = new Map();
  const dropped = { blocks: 0, lines: 0, reasons: {} };
  const drop = (reason, lines) => { dropped.blocks += 1; dropped.lines += lines; dropped.reasons[reason] = (dropped.reasons[reason] ?? 0) + 1; };
  for (const file of files) {
    const text = gunzip(readFileSync(file));
    let block = []; let rawLines = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { drop('unreadable-line', 1); block = []; rawLines = []; continue; }
      if (row.kind === 'forge-ore') {
        if (header !== null && (row.schema !== header.schema || row.featureVersion !== header.featureVersion || row.featureNames.join() !== header.featureNames.join())) {
          throw new Error(`${file}: the header differs from the first one (schema ${row.schema} / feature version ${row.featureVersion}); do not mix these records`);
        }
        header ??= row;
        continue;
      }
      if (row.match === true) {
        const hash = createHash('sha256').update(rawLines.join('\n')).digest('hex');
        if (row.decisions !== block.length) drop('count-mismatch', block.length + 1);
        else if (row.sha256 !== hash) drop('hash-mismatch', block.length + 1);
        else if (matches.has(row.job)) {
          // the same match twice (a resumed run, or two shards that overlap): the same content is counted once, different content means the two were not made alike
          if (matches.get(row.job).sha256 !== row.sha256) throw new Error(`${file}: match ${row.job} appears twice with different content (not made under the same conditions)`);
          dropped.duplicates = (dropped.duplicates ?? 0) + 1;
        } else {
          for (const decision of block) { decision.match = row; decisions.push(decision); }
          matches.set(row.job, keepRaw ? { ...row, raw: [...rawLines] } : row);
        }
        block = []; rawLines = [];
        continue;
      }
      block.push(row); rawLines.push(line);
    }
    if (block.length > 0) drop('block-without-match-line', block.length);
  }
  if (header === null) throw new Error('no header line in the ore');
  return { header, decisions, matches, dropped, files };
}
