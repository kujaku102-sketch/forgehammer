// The bundle: a folder (or the same folder as an archive) that carries one stage's result from one place to another: a GitHub artifact, a folder on a VM.
//
//   manifest.json   { schema, kind, id, round, createdAt, game, rules, features, teacher, student, env, inputs, files: { path: { sha256, bytes } } }
//   kinds           ore (records), weights (a learned weight vector), eval (a measured table), report
// `id` is the hash of what the bundle IS (kind, round, game, rules, features, teacher, student, inputs, files); it does not change with the date or the machine.
// `env.key` is what the numbers depend on (node, game commit, CPUs, bench code, limits): bundles of the same kind with different keys are not mixed. `env.info` is for reading only.
// A bundle never holds a secret: packing scans every file (gz opened) for the values of the key-like environment variables and for the usual shapes of keys, and stops.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

export const BUNDLE_SCHEMA = 1;
export const KINDS = Object.freeze(['ore', 'weights', 'eval', 'report']);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else if (name !== 'manifest.json') out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const SHAPES = [/sk-[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];
const KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

// the key-like values of this process's environment (long enough not to match by accident)
export function secretValues(env = process.env) {
  return Object.entries(env).filter(([name, value]) => KEY_NAME.test(name) && typeof value === 'string' && value.length >= 12).map(([name, value]) => ({ name, value }));
}

// Returns the list of problems ("path: what") found in the files of `dir`; empty when clean.
export function scanForSecrets(dir, files, env = process.env) {
  const secrets = secretValues(env); const problems = [];
  for (const file of files) {
    let buffer = readFileSync(path.join(dir, file));
    if (file.endsWith('.gz')) { try { buffer = gunzipSync(buffer); } catch { /* a cut file is scanned as it is */ } }
    const text = buffer.toString('latin1');
    for (const { name, value } of secrets) if (text.includes(value)) problems.push(`${file}: holds the value of ${name}`);
    for (const shape of SHAPES) if (shape.test(text)) problems.push(`${file}: has the shape of a key (${shape})`);
  }
  return problems;
}

// meta: { kind, round, game, rules, features, teacher, student, env, inputs, note }
export function packBundle(dir, meta, { env = process.env } = {}) {
  if (!KINDS.includes(meta.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const names = walk(dir);
  if (names.length === 0) throw new Error(`${dir} has no files`);
  const secretProblems = scanForSecrets(dir, names, env);
  if (secretProblems.length > 0) throw new Error(`a bundle must not hold a secret:\n  ${secretProblems.join('\n  ')}`);
  const files = {};
  for (const name of names) { const buffer = readFileSync(path.join(dir, name)); files[name] = { sha256: sha256(buffer), bytes: buffer.length }; }
  const identity = { kind: meta.kind, round: meta.round ?? null, game: meta.game ?? null, rules: meta.rules ?? null, features: meta.features ?? null, teacher: meta.teacher ?? null, student: meta.student ?? null, inputs: meta.inputs ?? [], files };
  const manifest = { schema: BUNDLE_SCHEMA, id: sha256(JSON.stringify(identity)), ...identity, env: meta.env ?? null, note: meta.note ?? null, createdAt: new Date().toISOString() };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

// { ok, problems: [...], manifest }. Checks the files against the manifest (missing, changed, extra), the id, and the secrets again.
export function verifyBundle(dir, { env = process.env } = {}) {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return { ok: false, problems: ['no manifest.json'], manifest: null };
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  if (manifest.schema !== BUNDLE_SCHEMA) problems.push(`schema ${manifest.schema} (this reads ${BUNDLE_SCHEMA})`);
  const names = new Set(walk(dir));
  for (const [name, entry] of Object.entries(manifest.files ?? {})) {
    if (!names.has(name)) { problems.push(`${name}: missing`); continue; }
    const buffer = readFileSync(path.join(dir, name));
    if (buffer.length !== entry.bytes || sha256(buffer) !== entry.sha256) problems.push(`${name}: changed`);
    names.delete(name);
  }
  for (const name of names) problems.push(`${name}: not in the manifest`);
  const identity = { kind: manifest.kind, round: manifest.round, game: manifest.game, rules: manifest.rules, features: manifest.features, teacher: manifest.teacher, student: manifest.student, inputs: manifest.inputs, files: manifest.files };
  if (sha256(JSON.stringify(identity)) !== manifest.id) problems.push('id does not match the content of the manifest');
  problems.push(...scanForSecrets(dir, Object.keys(manifest.files ?? {}).filter((n) => !problems.some((p) => p.startsWith(`${n}:`))), env));
  return { ok: problems.length === 0, problems, manifest };
}

// Whether two bundles can be put together: same kind, same game and rules, same features, same key of the environment.
export function compatible(a, b) {
  const problems = [];
  if (a.kind !== b.kind) problems.push(`kind ${a.kind} / ${b.kind}`);
  for (const part of ['game', 'rules', 'features', 'teacher']) if (JSON.stringify(a[part]) !== JSON.stringify(b[part])) problems.push(`${part} differs`);
  if (JSON.stringify(a.env?.key ?? null) !== JSON.stringify(b.env?.key ?? null)) problems.push('env.key differs');
  return problems;
}
