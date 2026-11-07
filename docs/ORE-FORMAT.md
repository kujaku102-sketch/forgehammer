# Ore format (schema 1)

What a teacher CPU decided, written by the game's test bench (SZbattlefield, `src/ore.mjs`) and read by `packages/forge` (`src/ore.mjs`).

## File
`ore-<tag>.jsonl.gz`, one file per writer process. It is a sequence of **gzip members**, each holding JSON lines. A block appended later (after a stop, or by a
resumed run) never spoils what is already there; a file cut in the middle of its last member is read up to the cut.

1. First member: one **header** line.
2. Then, for every match, one member holding that match's block: its **decision** lines, then one closing **match** line.

## Header
```json
{ "kind": "forge-ore", "schema": 1, "featureVersion": 3, "featureNames": ["type_install", "..."], "stateNames": ["turn", "..."],
  "game": { "commit": "…", "variant": null },
  "rules": { "ruleVersion": "2.0-public-staging.19", "cardVersion": "beta0.9.2-cards.11", "firstTurnDraw": { "first": 0, "second": 2 } }, "cpus": { "a": "lookahead", "b": "lookahead" }, "envId": "…" }
```
`rules` says under which rules the records were made (the game's rule version and card version, and the first-turn draw read from its source); records made under another rule are not mixed without looking.
`featureNames` names the columns of a candidate (index = position). All files of one learning run must have the same `schema`, `featureVersion` and `featureNames`;
the reader refuses to mix them.

## Decision line
```json
{ "job": "…", "seed": 26, "seat": "seat-a", "rev": 71, "turn": 10,
  "s": [0.5, 1, …],
  "c": [ [[8, 1], [9, 0.2], …], [[4, 1], …] ],
  "t": [-1.5, null],
  "k": 0, "why": "own",
  "e": [ [[4, 1]], … ], "eo": [0, 1, …], "ek": 0 }
```
- `s`: the state features (`stateNames`), dense, 4 significant digits. It is what the value model reads.
- `c`: the candidates. The candidates are made from the seat's own query alone (its legal actions, with one planning call for each entry that needs a pick: an attack target, a place to put a card, a spell target; a place that differs only in the slot is one) and the features from its observation; the same two functions run in the learned CPU. Candidate *i* is the *i*-th of them, as sparse pairs `[feature index, value]`; a zero is not written. When the decision has kinds of action that give no candidate (several picks, a second stage), one more candidate stands for "let the game's own CPU decide", at the end. The number of candidates differs from decision to decision.
- `e`: the same features for the legal actions *before their options are known* (one per entry of the seat's legal-actions list, in order; an entry that still needs a pick has `entry_open`). `eo`: for each candidate, the index of the entry it comes from (`-1` for the extra "let the game's CPU decide" candidate). `ek`: the entry the teacher's action comes from, or `null`. A CPU that picks the entry first and plans only that one is learned from these (`forge hammer --method staged`).
- Some features need what the seat itself has done earlier in its turn (`used_n`, `moves_done`, …); the recorder keeps that record per seat and turn, and so does the CPU.
- `t`: the teacher's own value of each candidate (for lookahead, its average gain), or `null` where it did not rate it.
- `k`: the index of the candidate the teacher chose; `null` when it could not be matched to a candidate (not learned from).
- `why`: `own` (the teacher chose by its own rating), `no-gain` / `no-supported-move` (it left the move to the game's CPU), with `:baseline` added when that move had no candidate of its own and was matched to the "let the game's CPU decide" candidate, `:unmapped` when it matched nothing.

Choices that are windows to answer (not moves of the turn) are not recorded.

## Match line (closes the block)
```json
{ "match": true, "job": "…", "seed": 26, "decks": { "seat-a": "start-orange", "seat-b": "start-yellow" }, "firstSeat": "seat-a",
  "status": "finished", "outcome": { "kind": "win", "winnerSeat": "seat-a" }, "turns": 12, "decisions": 38, "sha256": "…" }
```
`decisions` is the number of decision lines of the block and `sha256` the hash of those lines joined with `\n`, exactly as written. A block whose count or hash does not agree, and a block
without its match line, are dropped by the reader (and counted in `dropped`). An advantage is not stored: it is made from `outcome` when learning.

## Why JSON lines
A variable number of candidates and of non-zero values per candidate: a line is the unit that can be checked on its own, a broken line costs one decision, the closing line says
whether the block is whole, and the file can be read with any tool. Speed was put second; a fixed binary layout can be added later as a conversion of this one.
