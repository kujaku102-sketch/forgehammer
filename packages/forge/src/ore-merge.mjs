// Putting the records of several places together (shards of a recording run on several machines, or the rounds of a loop).
//   mergeOre(inputs, outDir, { expect })  ->  { matches, decisions, missing, extra, dropped }
// Checks while it reads (src/ore.mjs): the headers (schema, feature version and names) are the same, every block is whole and its hash agrees, and a match that appears twice is
// the same match. Then: with `expect` (the job ids the table has), says which are missing and which are not in the table. Writes one file of whole blocks in the order of the job ids.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { readOre } from './ore.mjs';

export function mergeOre(inputs, outDir, { expect = null } = {}) {
  const ore = readOre(inputs, { keepRaw: true });
  const jobs = [...ore.matches.keys()].sort();
  const missing = expect ? expect.filter((job) => !ore.matches.has(job)) : [];
  const extra = expect ? jobs.filter((job) => !expect.includes(job)) : [];
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'ore-merged.jsonl.gz');
  if (existsSync(file)) throw new Error(`${file} is already there`);
  const { match: _unused, ...header } = ore.header;
  appendFileSync(file, gzipSync(`${JSON.stringify({ ...header, merged: { from: inputs.length, matches: jobs.length } })}\n`));
  for (const job of jobs) {
    const { raw, ...row } = ore.matches.get(job);
    appendFileSync(file, gzipSync(`${[...raw, JSON.stringify(row)].join('\n')}\n`));
  }
  return { matches: jobs.length, decisions: ore.decisions.length, missing, extra, dropped: ore.dropped, file };
}

export const readExpected = (file) => readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
