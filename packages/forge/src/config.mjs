// One place for what differs from one machine to another (a laptop, a VM, a GitHub runner). Everything else in forge reads its settings from here and from nowhere else.
//
// Where a value comes from, first found wins:   command line (--key value)  >  environment (FORGE_<KEY>)  >  the config file  >  the default below.
// The config file is JSON (`forge.config.json`, or the path given by --config / FORGE_CONFIG); it is not kept in the repository (forge.config.example.json is).
// Paths in the file may be relative: they are read from the folder of the file (`work` and the places under it from the work folder).
// No path, drive letter or shell is assumed. The game is fetched from `game.source` at `game.commit` (SZbattlefield does that; GAME_SOURCE / SZB_WORK are its names for them).
// Keys (API keys, tokens) are not settings: they are read from the environment only, by the one module that needs them (src/secrets.mjs), and are never written anywhere.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  work: './forge-work',
  szb: '../SZbattlefield',
  forge: '.',
  game: { commit: null, variant: null, source: null, clones: null },
  workers: Math.max(1, os.cpus().length - 1),
  teacher: 'lookahead',
  record: { firstSeed: 101, seedsPerRound: 5 },
  eval: { vsSimple: '1-10', vsLookahead: '1-5' },
  baseOre: [],
  shard: null            // "i/n": this machine plays the i-th of n shards of every table
});

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// FORGE_GAME_COMMIT, FORGE_WORKERS, FORGE_RECORD_FIRST_SEED ... -> nested keys by "_" after the first word; kept small on purpose: only the keys named here
const ENV_KEYS = Object.freeze({
  FORGE_WORK: 'work', FORGE_SZB: 'szb', FORGE_FORGE: 'forge', FORGE_WORKERS: 'workers', FORGE_TEACHER: 'teacher', FORGE_SHARD: 'shard',
  FORGE_GAME_COMMIT: 'game.commit', FORGE_GAME_VARIANT: 'game.variant', FORGE_GAME_SOURCE: 'game.source', FORGE_GAME_CLONES: 'game.clones',
  FORGE_RECORD_FIRST_SEED: 'record.firstSeed', FORGE_RECORD_SEEDS_PER_ROUND: 'record.seedsPerRound',
  FORGE_EVAL_VS_SIMPLE: 'eval.vsSimple', FORGE_EVAL_VS_LOOKAHEAD: 'eval.vsLookahead'
});
const NUMBERS = new Set(['workers', 'record.firstSeed', 'record.seedsPerRound']);

function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {});
  node[parts.at(-1)] = NUMBERS.has(dotted) ? Number(value) : value;
}

// argv: ['--work', 'x', '--game.commit', 'abc', ...] (only --key value pairs and flags); returns { config, args }
export function parseArgs(argv) {
  const args = {}; const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { const key = argv[i].slice(2); args[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else positional.push(argv[i]);
  }
  return { args, positional };
}

export function loadConfig({ argv = [], env = process.env } = {}) {
  const { args } = parseArgs(argv);
  const file = args.config ?? env.FORGE_CONFIG ?? (existsSync('forge.config.json') ? 'forge.config.json' : null);
  const fromFile = file ? readJson(file) : {};
  const base = file ? path.dirname(path.resolve(file)) : process.cwd();
  const config = structuredClone(DEFAULTS);
  const merge = (target, source) => { for (const [key, value] of Object.entries(source)) { if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') merge(target[key], value); else target[key] = value; } };
  merge(config, fromFile);
  for (const [name, dotted] of Object.entries(ENV_KEYS)) if (env[name] !== undefined && env[name] !== '') setPath(config, dotted, env[name]);
  for (const [key, value] of Object.entries(args)) if (key.includes('.') || key in DEFAULTS) setPath(config, key, value === true ? true : value);
  // relative paths: work from the folder of the file, the rest from the folder of the file as well; the work folder is the root for what a round writes
  const fix = (p) => (p ? path.resolve(base, p) : p);
  config.work = fix(config.work); config.szb = fix(config.szb); config.forge = fix(config.forge);
  if (config.game.clones) config.game.clones = fix(config.game.clones);
  if (config.game.source && !/^[a-z]+:\/\//i.test(config.game.source)) config.game.source = fix(config.game.source);
  config.baseOre = config.baseOre.map(fix);
  for (const key of ['student0', 'round0']) if (config[key]) for (const [k, v] of Object.entries(config[key])) if (typeof v === 'string' && k !== 'name') config[key][k] = fix(v);
  config.workers = Number(config.workers);
  return { config, file };
}

// "i/n" -> { index: i-1, count: n } (the same split as SZbattlefield's --shard)
export function parseShard(text) {
  if (!text) return null;
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`shard must be i/n with 1 <= i <= n, got "${text}"`);
  return { index: Number(m[1]) - 1, count: Number(m[2]) };
}
