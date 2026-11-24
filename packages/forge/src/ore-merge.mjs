// Putting the records of several places together (shards of a recording run on several machines, or the rounds of a loop).
//   mergeOre(inputs, outDir, { expect })  ->  { matches, decisions, missing, extra, dropped, file }
// Checks while it reads (the same rules as readOre in src/ore.mjs): the headers (schema, feature version and names) are the same, every block is whole and its hash agrees, and a match that appears twice is
// the same match. Then: with `expect` (the job ids the table has), says which are missing and which are not in the table. Writes one file of whole blocks in the order of the job ids.
// It never holds the records: one file is read at a time and one block (one match) at a time. Each good block is gzipped and put in a spool file next to the output, and only a small note
// (job, hash, place in the spool) stays in memory; at the end the blocks are copied from the spool to the output in the order of the job ids. The spool is removed when done, or when it fails.
// The command line calls mergeOre and uses the answer at once, and node:zlib cannot carry a half-read gzip stream from one synchronous call to the next, so mergeOre runs mergeOreStream (the real work, async)
// in a child node process and waits for it. Code that can await may call mergeOreStream itself.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oreFiles, oreLines } from './ore.mjs';

const CHILD = 'FORGE_ORE_MERGE_CHILD';

// the same key as readOre uses: the job, and who looked (the shadow) when there is one
const keyOf = (job, shadow) => (shadow ? `${job}|${shadow}` : job);

const writeAll = (fd, buffer, position = null) => {
  let done = 0;
  while (done < buffer.length) done += writeSync(fd, buffer, done, buffer.length - done, position === null ? null : position + done);
};

const readAt = (fd, size, position) => {
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const got = readSync(fd, buffer, done, size - done, position + done);
    if (got === 0) throw new Error('the spool file ended early');
    done += got;
  }
  return buffer;
};

// The real work. Reads each file as a stream, keeps the good blocks in a spool, writes the output sorted by job id.
export async function mergeOreStream(inputs, outDir, { expect = null } = {}) {
  const files = oreFiles(inputs);
  if (files.length === 0) throw new Error(`no ore-*.jsonl.gz in ${inputs.join(', ')}`);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'ore-merged.jsonl.gz');
  if (existsSync(file)) throw new Error(`${file} is already there`);
  const spoolFile = `${file}.spool-${process.pid}`;
  let header = null; let decisions = 0; let spooled = 0;
  const index = new Map();   // key -> { sha256, at, size }: where the gzip member of the block is in the spool
  const dropped = { blocks: 0, lines: 0, reasons: {} };
  const drop = (reason, lines) => { dropped.blocks += 1; dropped.lines += lines; dropped.reasons[reason] = (dropped.reasons[reason] ?? 0) + 1; };
  const spool = openSync(spoolFile, 'w+');
  let out = null;
  try {
    for (const input of files) {
      let block = []; let shadow = '';
      for await (const line of oreLines(input)) {
        let row;
        try { row = JSON.parse(line); } catch { drop('unreadable-line', 1); block = []; continue; }
        if (row.kind === 'forge-ore') {
          if (header !== null && (row.schema !== header.schema || row.featureVersion !== header.featureVersion || row.featureNames.join() !== header.featureNames.join())) {
            throw new Error(`${input}: the header differs from the first one (schema ${row.schema} / feature version ${row.featureVersion}); do not mix these records`);
          }
          header ??= row;
          shadow = row.shadow ?? '';
          continue;
        }
        if (row.match === true) {
          const key = keyOf(row.job, shadow);
          const hash = createHash('sha256').update(block.join('\n')).digest('hex');
          if (row.decisions !== block.length) drop('count-mismatch', block.length + 1);
          else if (row.sha256 !== hash) drop('hash-mismatch', block.length + 1);
          else if (index.has(key)) {
            // the same match twice: the same content is counted once, different content means the two were not made alike
            if (index.get(key).sha256 !== row.sha256) throw new Error(`${input}: match ${row.job} appears twice with different content (not made under the same conditions)`);
            dropped.duplicates = (dropped.duplicates ?? 0) + 1;
          } else {
            const { raw: _raw, ...clean } = row;
            const member = gzipSync(`${[...block, JSON.stringify(clean)].join('\n')}\n`);
            writeAll(spool, member, spooled);
            index.set(key, { sha256: row.sha256, at: spooled, size: member.length });
            spooled += member.length;
            decisions += block.length;
          }
          block = [];
          continue;
        }
        block.push(line);
      }
      if (block.length > 0) drop('block-without-match-line', block.length);
    }
    if (header === null) throw new Error('no header line in the ore');
    const jobs = [...index.keys()].sort();
    const wanted = expect ? new Set(expect) : null;
    const missing = wanted ? expect.filter((job) => !index.has(job)) : [];
    const extra = wanted ? jobs.filter((job) => !wanted.has(job)) : [];
    const { match: _unused, ...headerRest } = header;
    out = openSync(file, 'wx');
    writeAll(out, gzipSync(`${JSON.stringify({ ...headerRest, merged: { from: inputs.length, matches: jobs.length } })}\n`));
    for (const job of jobs) {
      const note = index.get(job);
      writeAll(out, readAt(spool, note.size, note.at));
    }
    closeSync(out); out = null;
    return { matches: jobs.length, decisions, missing, extra, dropped, file };
  } catch (error) {
    if (out !== null) { closeSync(out); rmSync(file, { force: true }); }
    throw error;
  } finally {
    closeSync(spool); rmSync(spoolFile, { force: true });
  }
}

// The synchronous face the command line uses: the same work, done by a child node process (see the top of the file).
export function mergeOre(inputs, outDir, { expect = null } = {}) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    input: JSON.stringify({ inputs, outDir, expect }),
    env: { ...process.env, [CHILD]: '1' },
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (child.error) throw child.error;
  let answer = null;
  try { answer = JSON.parse(child.stdout); } catch { /* the child ended before it could answer */ }
  if (answer?.error !== undefined) throw new Error(answer.error);
  if (!answer?.ok) throw new Error(`the merge process ended without an answer (${child.signal ?? `exit ${child.status}`})`);
  return answer.ok;
}

export const readExpected = (file) => readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);

// When this file is started as the child of mergeOre: read the arguments from stdin, do the merge, print the answer as one line of JSON.
if (process.env[CHILD] === '1' && process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  delete process.env[CHILD];
  try {
    const { inputs, outDir, expect } = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify({ ok: await mergeOreStream(inputs, outDir, { expect }) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error?.message ?? String(error) }));
    process.exitCode = 1;
  }
}
