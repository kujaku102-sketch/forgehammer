// The audit report: a folder of static files that a person opens in a browser (no server, no network, works from file://) to read the decisions of a teacher and mark each one.
//
//   buildAudit(textDirs, outDir, { marks })   text logs (SZbattlefield --record-text; later the LLM's) -> outDir/index.html + outDir/data/*.js
//   applyMarks(files, textDirs, outFile)      marks files (what the page exports) -> one checked marks file (decision ids must exist; the last mark of a decision wins)
//   loadMarks(file)                           marks.jsonl -> Map(decisionId -> mark)
//
// The page reads its data from <script src> files (not fetch), which is what lets it open from a folder. It sends nothing anywhere.
// A mark is one line: { "decisionId", "status": "adopt" | "reject" | "hold", "by", "at", "note" }.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { constants, gunzipSync } from 'node:zlib';
import path from 'node:path';

const gunzip = (buffer) => { try { return gunzipSync(buffer).toString('utf8'); } catch { return gunzipSync(buffer, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8'); } };
export const STATUSES = Object.freeze(['adopt', 'reject', 'hold']);

function textFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (statSync(input).isDirectory()) for (const name of readdirSync(input).sort()) { if (/^text-.*\.jsonl\.gz$/.test(name)) files.push(path.join(input, name)); }
    else files.push(input);
  }
  return files;
}

// { header, matches: Map(job -> { match, decisions: [...] }) } ; only whole blocks (the closing line is there and the hash agrees)
export function readTextLogs(inputs) {
  const matches = new Map(); let header = null;
  for (const file of textFiles(inputs)) {
    let block = []; let raw = [];
    for (const line of gunzip(readFileSync(file)).split('\n')) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { block = []; raw = []; continue; }
      if (row.kind === 'forge-text') { header ??= row; continue; }
      if (row.match === true) {
        if (row.decisions === block.length && row.sha256 === createHash('sha256').update(raw.join('\n')).digest('hex') && !matches.has(row.job)) matches.set(row.job, { match: row, decisions: block });
        block = []; raw = []; continue;
      }
      block.push(row); raw.push(line);
    }
  }
  if (header === null) throw new Error(`no forge-text header in ${inputs.join(', ')}`);
  return { header, matches };
}

export function loadMarks(file) {
  const marks = new Map();
  if (!file || !existsSync(file)) return marks;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const mark = JSON.parse(line);
    if (!STATUSES.includes(mark.status) || typeof mark.decisionId !== 'string') throw new Error(`not a mark: ${line.slice(0, 80)}`);
    const before = marks.get(mark.decisionId);
    if (!before || String(before.at) <= String(mark.at)) marks.set(mark.decisionId, mark);
  }
  return marks;
}

export function applyMarks(files, textDirs, outFile) {
  const { matches } = readTextLogs(textDirs);
  const ids = new Set(); for (const { decisions } of matches.values()) for (const d of decisions) ids.add(d.id);
  const merged = new Map(); const unknown = [];
  for (const file of files) for (const [id, mark] of loadMarks(file)) {
    if (!ids.has(id)) { unknown.push(id); continue; }
    const before = merged.get(id); if (!before || String(before.at) <= String(mark.at)) merged.set(id, mark);
  }
  if (unknown.length) throw new Error(`${unknown.length} marks name a decision that is not in the logs (e.g. ${unknown[0]})`);
  writeFileSync(outFile, [...merged.values()].map((m) => JSON.stringify({ decisionId: m.decisionId, status: m.status, by: m.by ?? '', at: m.at ?? '', note: m.note ?? '' })).join('\n') + (merged.size ? '\n' : ''));
  return merged.size;
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
const js = (name, value) => `window.${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};\n`;

export function buildAudit(textDirs, outDir, { marks = null } = {}) {
  const { header, matches } = readTextLogs(textDirs);
  mkdirSync(path.join(outDir, 'data'), { recursive: true });
  const decks = new Set(); const types = new Set(); const rows = [];
  let n = 0;
  for (const [job, { match, decisions }] of [...matches.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    n += 1; const file = `m-${n}.js`;
    const seatsWin = match.outcome?.kind === 'win' ? match.outcome.winnerSeat : null;
    let disagree = 0; let invalid = 0;
    const out = decisions.map((d) => {
      const a = d.answers ?? {}; const t = a.teacher?.n ?? null; const s = a.student?.n ?? null; const l = a.llm?.n ?? null;
      const differs = (s !== null && t !== null && s !== t) || (l !== null && t !== null && l !== t);
      const bad = Boolean(a.llm?.error);
      if (differs) disagree += 1; if (bad) invalid += 1;
      const chosen = d.candidates[(t ?? l ?? 1) - 1]?.label ?? '';
      const type = chosen.split(':')[0].trim() || 'その他'; types.add(type);
      return { id: d.id, seat: d.seat, turn: d.turn, rev: d.rev, prompt: d.prompt, candidates: d.candidates, answers: a, differs, invalid: bad, type, won: seatsWin === null ? null : seatsWin === d.seat };
    });
    for (const deck of Object.values(match.decks ?? {})) decks.add(deck);
    writeFileSync(path.join(outDir, 'data', file), `window.AUDIT_MATCH = window.AUDIT_MATCH || {};\nwindow.AUDIT_MATCH[${JSON.stringify(job)}] = ${JSON.stringify(out).replace(/</g, '\\u003c')};\n`);
    rows.push({ job, file, decks: match.decks, outcome: match.outcome, firstSeat: match.firstSeat, turns: match.turns, n: decisions.length, disagree, invalid });
  }
  writeFileSync(path.join(outDir, 'data', 'index.js'), js('AUDIT_INDEX', { promptVersion: header.promptVersion, game: header.game, rules: header.rules, cpus: header.cpus, system: header.system, decks: [...decks].sort(), types: [...types].sort(), matches: rows, reportId: createHash('sha256').update(JSON.stringify(rows.map((r) => [r.job, r.n]))).digest('hex').slice(0, 12) }));
  writeFileSync(path.join(outDir, 'data', 'marks.js'), js('AUDIT_MARKS', marks ? [...marks.values()] : []));
  writeFileSync(path.join(outDir, 'index.html'), PAGE);
  return { matches: rows.length, decisions: rows.reduce((s, r) => s + r.n, 0) };
}

const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit</title>
<style>
:root{--bg:#fff;--fg:#1c1c1e;--mut:#6b6b70;--line:#d9d9de;--acc:#1e66f5;--ok:#2e7d32;--ng:#c62828;--hold:#8a6d00;--sel:#e8f0fe}
@media (prefers-color-scheme: dark){:root{--bg:#161618;--fg:#ececf0;--mut:#9a9aa2;--line:#34343a;--acc:#6ea0ff;--ok:#66bb6a;--ng:#ef5350;--hold:#d4b13a;--sel:#22304d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
header{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
header label{display:flex;gap:4px;align-items:center;color:var(--mut)}input,select,button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
button{cursor:pointer}button.on{border-color:var(--acc);color:var(--acc)}
main{display:grid;grid-template-columns:260px 300px 1fr;height:calc(100vh - 52px)}
@media (max-width:900px){main{grid-template-columns:1fr;height:auto}}
section{overflow:auto;border-right:1px solid var(--line)}
.item{padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer}.item.sel{background:var(--sel)}.item small{color:var(--mut)}
.tag{display:inline-block;padding:0 6px;border-radius:9px;border:1px solid var(--line);font-size:12px;margin-left:4px}
.adopt{color:var(--ok)}.reject{color:var(--ng)}.hold{color:var(--hold)}
#detail{padding:10px 14px}pre{white-space:pre-wrap;background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0;font:13px/1.55 ui-monospace,monospace}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}tr.t td{background:var(--sel)}
.who{font-weight:600}
</style></head><body>
<header>
<strong>Audit</strong><span id="info"></span>
<label><input type="checkbox" id="fDiff">食い違い</label><label><input type="checkbox" id="fInvalid">無効</label><label><input type="checkbox" id="fLost">負けた試合</label>
<label>デッキ <select id="fDeck"><option value="">すべて</option></select></label><label>手 <select id="fType"><option value="">すべて</option></select></label>
<label>印 <select id="fMark"><option value="">すべて</option><option value="none">未</option><option value="adopt">採用</option><option value="reject">却下</option><option value="hold">保留</option></select></label>
<label><input id="fText" placeholder="検索(カード名・理由)" size="16"></label><label>名前 <input id="who" size="8"></label>
<button id="export">印を書き出す</button><label><input type="file" id="import" accept=".jsonl,.json,.txt">読み込み</label>
</header>
<main><section id="matches"></section><section id="decisions"></section><section id="detail">試合を選んでください。</section></main>
<script src="data/index.js"></script><script src="data/marks.js"></script>
<script>
(() => {
const IDX = window.AUDIT_INDEX; const key = 'audit:' + IDX.reportId;
const $ = (id) => document.getElementById(id);
const marks = new Map(); // decisionId -> mark
const store = (() => { try { return window.localStorage; } catch { return null; } })();
for (const m of window.AUDIT_MARKS || []) marks.set(m.decisionId, m);
try { for (const m of JSON.parse(store?.getItem(key) || '[]')) marks.set(m.decisionId, m); } catch {}
const save = () => { try { store?.setItem(key, JSON.stringify([...marks.values()])); } catch {} };
$('who').value = (store && store.getItem('audit:who')) || '';
$('who').addEventListener('change', () => { try { store?.setItem('audit:who', $('who').value); } catch {} });
$('info').textContent = IDX.matches.length + ' 試合 / prompt v' + IDX.promptVersion + ' / ' + (IDX.game?.commit || '').slice(0, 7);
for (const d of IDX.decks) $('fDeck').add(new Option(d.replace('start-', ''), d));
for (const t of IDX.types) $('fType').add(new Option(t, t));
let curJob = null; let cur = []; let curIdx = -1; let shown = [];
const loaded = {};
function load(job, cb) {
  if (loaded[job]) return cb();
  const row = IDX.matches.find((m) => m.job === job);
  const s = document.createElement('script'); s.src = 'data/' + row.file; s.onload = () => { loaded[job] = true; cb(); }; document.body.appendChild(s);
}
const mark = (d) => marks.get(d.id)?.status || '';
function renderMatches() {
  const box = $('matches'); box.textContent = '';
  const lostOnly = $('fLost').checked; const deck = $('fDeck').value;
  IDX.matches.forEach((m) => {
    const seats = Object.keys(m.decks);
    if (deck && !Object.values(m.decks).includes(deck)) return;
    const win = m.outcome?.kind === 'win' ? m.outcome.winnerSeat : null;
    const div = document.createElement('div'); div.className = 'item' + (m.job === curJob ? ' sel' : '');
    div.innerHTML = '<div></div><small></small>';
    div.firstChild.textContent = seats.map((s) => (m.decks[s] || '').replace('start-', '') + (s === win ? '★' : '')).join(' 対 ');
    div.lastChild.textContent = m.job.split('/').slice(-1)[0] + ' ・ ' + m.n + '手 ・ ' + m.turns + 'ターン ・ 食い違い ' + m.disagree + (m.invalid ? ' ・ 無効 ' + m.invalid : '');
    div.onclick = () => { curJob = m.job; load(m.job, () => { cur = window.AUDIT_MATCH[m.job]; renderMatches(); renderDecisions(); }); };
    box.appendChild(div);
  });
}
function renderDecisions() {
  const box = $('decisions'); box.textContent = '';
  const f = { diff: $('fDiff').checked, inv: $('fInvalid').checked, lost: $('fLost').checked, type: $('fType').value, mark: $('fMark').value, text: $('fText').value.trim() };
  shown = cur.filter((d) => (!f.diff || d.differs) && (!f.inv || d.invalid) && (!f.lost || d.won === false) && (!f.type || d.type === f.type)
    && (!f.mark || (f.mark === 'none' ? !mark(d) : mark(d) === f.mark))
    && (!f.text || (d.prompt + JSON.stringify(d.answers) + d.candidates.map((c) => c.label).join(' ')).includes(f.text)));
  shown.forEach((d, i) => {
    const div = document.createElement('div'); div.className = 'item' + (i === curIdx ? ' sel' : '');
    const m = mark(d); const t = d.answers.teacher?.n; const s = d.answers.student?.n; const l = d.answers.llm?.n;
    div.textContent = 'T' + d.turn + ' ' + d.seat.replace('seat-', '') + ' r' + d.rev + ' ・ ' + d.type;
    const small = document.createElement('small'); small.textContent = ' 先生' + (t ?? '-') + (s !== undefined ? ' 学習' + (s ?? '-') : '') + (l !== undefined ? ' LLM' + (l ?? '-') : '');
    div.appendChild(small);
    if (d.differs) { const x = document.createElement('span'); x.className = 'tag'; x.textContent = '食い違い'; div.appendChild(x); }
    if (d.invalid) { const x = document.createElement('span'); x.className = 'tag'; x.textContent = '無効'; div.appendChild(x); }
    if (m) { const x = document.createElement('span'); x.className = 'tag ' + m; x.textContent = { adopt: '採用', reject: '却下', hold: '保留' }[m]; div.appendChild(x); }
    div.onclick = () => { curIdx = i; renderDecisions(); renderDetail(); };
    box.appendChild(div);
  });
}
function renderDetail() {
  const d = shown[curIdx]; const box = $('detail'); box.textContent = '';
  if (!d) { box.textContent = '判断を選んでください。'; return; }
  const h = document.createElement('div'); h.className = 'who'; h.textContent = d.id + (d.won === null ? '' : d.won ? '  (この席は勝った試合)' : '  (この席は負けた試合)'); box.appendChild(h);
  const pre = document.createElement('pre'); pre.textContent = d.prompt; box.appendChild(pre);
  const a = d.answers; const tbl = document.createElement('table'); tbl.innerHTML = '<tr><th>番号</th><th>選択肢</th><th>先生(点数)</th><th>学習CPU</th><th>LLM</th></tr>';
  d.candidates.forEach((c, i) => {
    const tr = document.createElement('tr'); if (a.teacher?.n === c.n) tr.className = 't';
    const cells = [c.n, c.label, (a.teacher?.n === c.n ? '★ ' : '') + (a.teacher?.scores?.[i] ?? ''), a.student?.n === c.n ? '●' : '', a.llm?.n === c.n ? '✔' : ''];
    cells.forEach((x) => { const td = document.createElement('td'); td.textContent = x; tr.appendChild(td); }); tbl.appendChild(tr);
  });
  box.appendChild(tbl);
  const info = document.createElement('div'); info.style.margin = '6px 0'; info.textContent = '先生: ' + (a.teacher?.baseline ? 'ゲームのCPUに任せた手' : a.teacher?.n ?? '-') + ' (' + (a.teacher?.why || '') + ')' + (a.llm?.reason ? '  LLMの理由: ' + a.llm.reason : '') + (a.llm?.error ? '  LLMのエラー: ' + a.llm.error.kind : ''); box.appendChild(info);
  const note = document.createElement('input'); note.placeholder = 'メモ'; note.size = 40; note.value = marks.get(d.id)?.note || '';
  const set = (status) => { marks.set(d.id, { decisionId: d.id, status, by: $('who').value || '(名前なし)', at: new Date().toISOString(), note: note.value }); save(); renderDecisions(); renderDetail(); };
  for (const [s, label] of [['adopt', '採用 (a)'], ['reject', '却下 (r)'], ['hold', '保留 (h)']]) { const b = document.createElement('button'); b.textContent = label; if (mark(d) === s) b.className = 'on'; b.onclick = () => set(s); b.style.marginRight = '6px'; box.appendChild(b); }
  box.appendChild(note);
}
function step(by) { if (!shown.length) return; curIdx = Math.max(0, Math.min(shown.length - 1, curIdx + by)); renderDecisions(); renderDetail(); }
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'j') step(1); else if (e.key === 'k') step(-1);
  else if (shown[curIdx] && ['a', 'r', 'h'].includes(e.key)) { const status = { a: 'adopt', r: 'reject', h: 'hold' }[e.key]; const d = shown[curIdx]; marks.set(d.id, { decisionId: d.id, status, by: $('who').value || '(名前なし)', at: new Date().toISOString(), note: marks.get(d.id)?.note || '' }); save(); renderDecisions(); renderDetail(); }
});
for (const id of ['fDiff', 'fInvalid', 'fLost', 'fDeck', 'fType', 'fMark', 'fText']) $(id).addEventListener('input', () => { curIdx = -1; renderMatches(); renderDecisions(); renderDetail(); });
$('export').onclick = () => {
  const lines = [...marks.values()].map((m) => JSON.stringify(m)).join('\\n') + '\\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines], { type: 'text/plain' }));
  a.download = 'marks-' + (($('who').value || 'anon').replace(/[^A-Za-z0-9_-]/g, '_')) + '-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.jsonl'; a.click();
};
$('import').onchange = (e) => { const f = e.target.files[0]; if (!f) return; f.text().then((t) => { for (const line of t.split('\\n')) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.decisionId && m.status) marks.set(m.decisionId, m); } catch {} } save(); renderDecisions(); renderDetail(); }); };
renderMatches();
})();
</script></body></html>
`;
