// The audit as a markdown file: one file for a set, a section for each decision where the answers differ, with lines to write the mark in. It can be written on a PC or a phone.
//
//   exportMd(textDirs, outFile, { title, all })      text logs -> one .md file (UTF-8, LF); `all` puts every decision in, not only the ones where the answers differ
//   importMd(files, { by, at })                        the files written in -> { marks: [...], unreadable: [{ file, heading, line, reason }], blank, sections }
//
// A section:
//   ## D-3fa91 （seed 201・試合 12・ターン 5・seat-a）
//   ID: <the decision id>                      (the line the import reads the decision from)
//   > the board, one line each, and the cards' effects, one line each      > ...
//   候補: numbered, with the looking-ahead teacher's score
//   答え: the teacher, the models (number and reason), the machine's judgement
//   印: <one word>        正しい手: <number>        メモ: <free text>
// The word after 印: is read loosely (full-width, spaces, a full stop): 採用 / LLM (the model's move is good: adopt), 却下 / 先読み / どれも違う (it is not: reject), 保留 (hold).
// A mark is the same shape as the one the HTML report exports, so `hammer --audit` reads it: { decisionId, status: adopt|reject|hold, by, at, note } and, besides, `choice`
// ("llm" | "lookahead" | "neither") and `correct` (the number of the right move) when they were written.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { readTextLogs } from './audit.mjs';

const MARK_LINE = /^\s*(印|正しい手|メモ)\s*[:：]\s*(.*)$/;

const shortCode = (ids) => {
  const codes = new Map(); const taken = new Map();
  for (const id of ids) {
    const hash = createHash('sha1').update(id).digest('hex');
    for (let n = 5; n <= hash.length; n += 1) { const code = `D-${hash.slice(0, n)}`; if (!taken.has(code)) { taken.set(code, id); codes.set(id, code); break; } }
  }
  return codes;
};

// how strongly the answers differ (the larger first): the machine's judgement gap, else the number of different moves chosen
function weight(d) {
  const j = d.answers.judge;
  if (j?.values && Number.isFinite(j.values.llm) && Number.isFinite(j.values.lookahead)) return 1000 + Math.abs(j.values.llm - j.values.lookahead);
  const ns = new Set([d.answers.teacher?.n, d.answers.llm?.n, ...Object.values(d.answers.llms ?? {}).map((a) => a?.n)].filter((n) => n));
  return ns.size;
}

const differs = (d) => {
  const a = d.answers ?? {};
  const t = a.teacher?.n ?? null;
  const ns = [a.llm?.n, ...Object.values(a.llms ?? {}).filter((m) => m && !m.error).map((m) => m.n)].filter((n) => n);
  return ns.some((n) => t !== null && n !== t) || new Set(ns).size > 1 || (a.student?.n && t !== null && a.student.n !== t);
};

const oneLine = (text, max = 160) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function exportMd(textDirs, outFile, { title = 'audit', all = false } = {}) {
  const { matches } = readTextLogs(textDirs);
  const rows = []; let matchNo = 0;
  for (const [job, { match, decisions }] of [...matches.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    matchNo += 1;
    for (const d of decisions) rows.push({ d, job, match, matchNo });
  }
  const chosen = rows.filter(({ d }) => all || differs(d)).sort((x, y) => weight(y.d) - weight(x.d) || x.d.id.localeCompare(y.d.id));
  const codes = shortCode(rows.map(({ d }) => d.id));
  const out = [];
  out.push(`# ${title}`, '',
    '書き方（スマホでもPCでもこのファイルに直接書けます）:',
    '- 各節の「印:」のあとに1語。 採用 / 却下 / 保留。 LLM（LLMの手がよい＝採用）、先読み（lookaheadの手がよい＝却下）、どれも違う（＝却下）も使えます。',
    '- 「正しい手:」のあとに候補の番号（わかるときだけ）。「メモ:」は自由。',
    '- 全角・半角・空白・句点は気にしなくて大丈夫です。節の見出しとID行は書き換えないでください。', '',
    `${chosen.length} 件（${all ? '全部' : '答えが食い違った判断だけ'}、差が大きい順）`, '');
  for (const { d, match, matchNo: no } of chosen) {
    const code = codes.get(d.id);
    out.push(`## ${code} （seed ${d.seed ?? match.seed}・試合 ${no}・ターン ${d.turn}・${d.seat}）`);
    out.push(`ID: ${d.id}`, '');
    const prompt = String(d.prompt ?? '');
    const cut = prompt.indexOf('\n選択肢:');
    for (const line of (cut >= 0 ? prompt.slice(0, cut) : prompt).split('\n')) out.push(line.trim() === '' ? '>' : `> ${line}`);
    out.push('', '候補:');
    const scores = d.answers.teacher?.scores ?? [];
    d.candidates.forEach((c, i) => out.push(`${c.n}. ${oneLine(String(c.label).replace(/^\s*\d+\.\s*/, ''))}${Number.isFinite(scores[i]) ? `　〔先読み点 ${scores[i]}〕` : ''}`));
    out.push('', '答え:');
    const t = d.answers.teacher;
    if (t) out.push(`- 先読み(lookahead): ${t.baseline ? 'ゲームのCPUに任せた手' : t.n ?? '-'}${t.n && Number.isFinite(scores[t.n - 1]) ? `（点 ${scores[t.n - 1]}）` : ''}`);
    if (d.answers.student) out.push(`- 学習CPU: ${d.answers.student.n ?? '-'}`);
    if (d.answers.llm && !d.answers.llms) out.push(`- LLM: ${d.answers.llm.error ? `エラー ${d.answers.llm.error.kind}` : d.answers.llm.n}${d.answers.llm.reason ? ` 「${oneLine(d.answers.llm.reason, 140)}」` : ''}`);
    for (const [name, m] of Object.entries(d.answers.llms ?? {})) out.push(`- ${name}: ${m.error ? `エラー ${m.error.kind}` : m.n}${m.via ? `（${m.via}が代わり）` : ''}${m.reason ? ` 「${oneLine(m.reason, 140)}」` : ''}`);
    const j = d.answers.judge;
    if (j) out.push(`- 機械の判定: ${({ llm: 'LLMの手が良い', lookahead: '先読みの手が良い', tie: '引き分け', unknown: '判定できない' })[j.winner] ?? j.winner}${j.values ? `（LLM ${j.values.llm ?? '-'} / 先読み ${j.values.lookahead ?? '-'}、${j.samples ?? 0}通り）` : ''}`);
    out.push('', '印: ', '正しい手: ', 'メモ: ', '');
  }
  writeFileSync(outFile, `${out.join('\n')}\n`, 'utf8');
  return { decisions: rows.length, sections: chosen.length };
}

// ---- reading it back
const norm = (text) => String(text ?? '').normalize('NFKC').replace(/[\s　。．.、，,!！?？・「」『』()（）\[\]【】]/g, '').toLowerCase();

// the word after 印: -> { status, choice } | null (blank) | undefined (cannot be read)
export function readMark(word) {
  const w = norm(word);
  if (w === '') return null;
  const has = (list) => list.some((x) => w === x || w.startsWith(x));
  if (has(['どれも違う', 'どれもちがう', 'どれも', 'neither', '全部違う', '違う', 'ちがう'])) return { status: 'reject', choice: 'neither' };
  if (has(['先読み', 'さきよみ', 'lookahead', 'la', '先読', '先'])) return { status: 'reject', choice: 'lookahead' };
  if (has(['却下', 'きゃっか', 'reject', 'ng', '×', 'x', 'ばつ', 'no'])) return { status: 'reject', choice: null };
  if (has(['保留', 'ほりゅう', 'hold', '△', 'さんかく', 'あとで', '?', 'pending'])) return { status: 'hold', choice: null };
  if (has(['採用', 'さいよう', 'adopt', 'ok', '○', '〇', 'o', 'まる', 'yes'])) return { status: 'adopt', choice: null };
  if (has(['llm', 'ai', 'モデル', 'haiku', 'sonnet', 'flash'])) return { status: 'adopt', choice: 'llm' };
  return undefined;
}

export function importMd(files, { by = '文豪', at = null } = {}) {
  const marks = []; const unreadable = []; let blank = 0; let sections = 0;
  for (const file of files) {
    const when = at ?? statSync(file).mtime.toISOString();
    const lines = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    let cur = null;
    const finish = () => {
      if (!cur) return;
      sections += 1;
      if (!cur.id) { unreadable.push({ file, heading: cur.heading, line: cur.line, reason: 'the ID line is missing' }); cur = null; return; }
      const mark = readMark(cur.mark);
      const correctText = norm(cur.correct);
      let correct = null;
      if (correctText !== '') { const m = /\d+/.exec(correctText); if (m) correct = Number(m[0]); else unreadable.push({ file, heading: cur.heading, line: cur.line, reason: `正しい手 "${cur.correct}" has no number` }); }
      if (mark === undefined) { unreadable.push({ file, heading: cur.heading, line: cur.line, reason: `印 "${cur.mark}" cannot be read` }); cur = null; return; }
      if (mark === null && correct === null && !cur.note.trim()) { blank += 1; cur = null; return; }
      // a right move written without a mark: the mark is "none of them" (reject) when it is not the model's, else left to the reader of the note
      const status = mark?.status ?? 'hold';
      marks.push({ decisionId: cur.id, status, by, at: when, note: cur.note.trim(), ...(mark?.choice ? { choice: mark.choice } : {}), ...(correct !== null ? { correct } : {}) });
      cur = null;
    };
    lines.forEach((raw, index) => {
      const heading = /^##\s+(D-[0-9a-f]+)\b/.exec(raw);
      if (heading) { finish(); cur = { heading: raw.trim(), line: index + 1, id: null, mark: '', correct: '', note: '' }; return; }
      if (!cur) return;
      const idLine = /^ID:\s*(.+?)\s*$/.exec(raw);
      if (idLine && !cur.id) { cur.id = idLine[1]; return; }
      const m = MARK_LINE.exec(raw);
      if (!m) return;
      if (m[1] === '印') cur.mark = m[2]; else if (m[1] === '正しい手') cur.correct = m[2]; else cur.note = m[2];
    });
    finish();
  }
  // the last mark of a decision wins
  const byId = new Map(); for (const mark of marks) byId.set(mark.decisionId, mark);
  return { marks: [...byId.values()], unreadable, blank, sections };
}

export function writeMarks(marks, outFile) {
  writeFileSync(outFile, marks.map((m) => JSON.stringify(m)).join('\n') + (marks.length ? '\n' : ''), 'utf8');
}
