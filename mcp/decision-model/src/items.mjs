// Items mode: the same questions asked of many items, each evaluated on its own.
//
// Why it exists: to label a collection through `state`, an agent must first read every item and then
// copy it into the call, which costs more than reading the items itself. With `items_file` the
// collection goes from a file to the provider without passing through the agent's context, and only a
// summary comes back; the full per-item results land in a JSONL file the agent filters with code.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EvaluationError } from './secrets.mjs';
import { findCredential } from './systemone.mjs';

// budgetMs keeps a call under the clients' tool timeout (Codex's default is 60 s): items not started
// in time are reported as skipped, never silently dropped. breakerAfter: when that many items in a row
// have failed and none succeeded, the rest would fail too, whatever the cause.
// batchItems / batchQuestions / batchChars: several items share one request, each asked its own copy
// of the questions. Measured on 298 support messages with Jev: 10 per request cut input tokens 37% and
// time from 4.7 s to ~1 s, with the same accuracy as one item per request (96.3%, 98% identical labels).
export const LIMITS = { fileBytes: 10_000_000, distinctItems: 500, concurrency: 20, budgetMs: 50_000, perItemMs: 45_000, inlineResults: 20, listedIds: 50, idChars: 80, depth: 60, breakerAfter: 5, batchItems: 10, batchQuestions: 50, batchChars: 24_000 };

// items_file may live only where an agent writes scratch data on purpose: the temp directories and the
// directories the user lists in DECISION_MODEL_ALLOWED_DIRS. Not the project, not the home directory:
// a file there must first be copied or extracted, a deliberate act, so a path an injected instruction
// slips in cannot point the tool at a secret.
export function allowedRoots({ env = process.env } = {}) {
  const real = p => { try { return [realpathSync(p)]; } catch { return []; } };
  const extra = (env.DECISION_MODEL_ALLOWED_DIRS ?? '').split(path.delimiter).filter(p => path.isAbsolute(p)).flatMap(real);
  return [...new Set([...real(tmpdir()), ...real('/tmp'), ...extra])].filter(r => r !== path.parse(r).root);
}

export function checkItemsFile(file, roots = allowedRoots()) {
  if (!path.isAbsolute(file)) throw new EvaluationError('items_file must be an absolute path.');
  let real;
  try { real = realpathSync(file); } catch { throw new EvaluationError(`items_file not found: ${file}`); }
  if (!roots.some(r => real.startsWith(r + path.sep))) throw new EvaluationError(`items_file must be in a temp directory (${roots.join(', ')}): write or copy the items there first.`);
  const st = statSync(real);
  if (!st.isFile()) throw new EvaluationError('items_file is not a regular file.');
  if (st.size > LIMITS.fileBytes) throw new EvaluationError(`items_file exceeds ${LIMITS.fileBytes / 1e6} MB: reduce it with code first (filter, group, dedupe).`);
  return { real, dev: st.dev, ino: st.ino };
}

// Reads the very file that was checked: no symlink at the last step, same device and inode.
export function readItemsFile(file, roots) {
  const { real, dev, ino } = checkItemsFile(file, roots);
  let fd;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new EvaluationError('items_file could not be opened.'); }
  try {
    const st = fstatSync(fd);
    if (st.dev !== dev || st.ino !== ino || !st.isFile() || st.size > LIMITS.fileBytes) throw new EvaluationError('items_file changed while it was being read: write it again and retry.');
    // Read at most the checked size: a log still being appended cannot push the read past the cap.
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) { const n = readSync(fd, buf, read, st.size - read, read); if (!n) break; read += n; }
    return { real, text: buf.subarray(0, read).toString('utf8') };
  } finally { closeSync(fd); }
}

// An item's id: its own `id` field as a string, else its line number (array position for .json) as a
// number, so the two kinds never collide and the agent can find the source line.
const idOf = (item, n) => item && typeof item === 'object' && !Array.isArray(item) && ['string', 'number'].includes(typeof item.id) ? String(item.id) : n;
const withoutId = item => {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('id' in item)) return item;
  const { id, ...rest } = item;
  return rest;
};

// `at` is where the item sits in the source (line, or array position). Errors name items by it, never
// by their own id, which is the caller's data and could be anything, a credential included.
export function entriesFromArray(items, where = 'item') {
  return items.map((item, i) => ({ id: idOf(item, i + 1), at: `${where} ${i + 1}`, item }));
}

// .json: an array. .jsonl/.ndjson: one JSON value per line. Anything else: one text item per line.
export function parseItems(text, file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    let value;
    try { value = JSON.parse(text); } catch { throw new EvaluationError('items_file is not valid JSON.'); }
    if (!Array.isArray(value)) throw new EvaluationError('A .json items_file must hold an array of items.');
    return entriesFromArray(value, 'array position');
  }
  const jsonLines = ext === '.jsonl' || ext === '.ndjson';
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    if (!jsonLines) return out.push({ id: i + 1, at: `line ${i + 1}`, item: line });
    let item;
    try { item = JSON.parse(line); } catch { throw new EvaluationError(`items_file line ${i + 1} is not valid JSON.`); }
    out.push({ id: idOf(item, i + 1), at: `line ${i + 1}`, item });
  });
  return out;
}

export function loadItemsFile(file, roots) {
  const { real, text } = readItemsFile(file, roots);
  return parseItems(text, real);
}

const depthOf = value => {
  let max = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > max) max = d;
    if (v && typeof v === 'object') for (const x of Object.values(v)) stack.push([x, d + 1]);
  }
  return max;
};

// The grouping key. normalized: what varies between lines of one kind of event (timestamps, UUIDs, hex,
// the id part of prefixed ids, numbers) becomes a placeholder, so one representative answers for the
// whole group. Kept: a standalone 0 ("0 rows" is not "12 rows"), id prefixes (evt_ vs job_), the
// structure. When another number decides the answer (HTTP status, a size against a limit) the caller
// uses exact or its own grouping; results_file shows up to 3 variants per group to check that with code.
// It works on the raw strings, so JSON escapes cannot blend into a token, and placeholders use
// private-use characters, so no literal text can collide with them.
const P = tag => `\uE000${tag}\uE001`;
const NORMALIZE = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, P('uuid')],
  [/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/g, P('ts')],
  [/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, P('time')],
  [/\b([A-Za-z]{1,10}_)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,}\b/g, `$1${P('id')}`],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, P('hex')],
  [/(?<![A-Za-z_\d])(?!0(?!\d|\.\d))\d+(\.\d+)?/g, P('n')], // 1200ms -> <n>ms, user 77 -> user <n>; a lone 0 stays, "0." included
];
// Private-use characters already in the text are escaped first (\uE002 before each), so a generated
// placeholder can never equal original text.
const normalizeString = text => NORMALIZE.reduce((t, [re, to]) => t.replace(re, to), text.replace(/[\uE000-\uE002]/g, c => `\uE002${c}`));
// Depth is already capped, so this recursion is bounded.
const mapStrings = (v, f) => typeof v === 'string' ? f(v)
  : Array.isArray(v) ? v.map(x => mapStrings(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]))
  : v;
const keyOf = (content, dedupe) => JSON.stringify(dedupe === 'normalized' ? mapStrings(content, normalizeString) : content);

const compact = a => a.type === 'noul' ? { p: a.noul }
  : a.type === 'choice' ? { choice: a.choice, p: a.probabilities[a.choice], confidence: a.confidence }
  : { score: a.score, confidence: a.confidence };
// Uncertain answers go back to the agent to inspect, as the skill asks.
// TypeSafe's own starting points: a Noul at or above 0.7 is yes, at or below 0.3 no, in between goes to a
// person (docs.typesafe.ai/primitives/noul). Choice/Score: low confidence goes to a person.
const NOUL_YES = 0.7, NOUL_NO = 0.3;
const isUncertain = a => a.type === 'noul' ? a.noul > NOUL_NO && a.noul < NOUL_YES : a.confidence < 0.5;
const shortId = (id, limits) => typeof id === 'string' && id.length > limits.idChars ? id.slice(0, limits.idChars) + '…' : id;

// evaluateOne(request, { signal, timeoutMs }) evaluates one System One request (evaluate() with a target).
// started: when the tool call began (a monotonic clock), so reading and grouping count against the budget.
export async function evaluateItems({ entries, questions, context, dedupe = 'exact' }, { evaluateOne, signal, onProgress, limits = LIMITS, now = () => performance.now(), started = now(), resultsDir = path.join(tmpdir(), 'decision-model') } = {}) {
  if (!entries.length) throw new EvaluationError('No items to evaluate.');
  const deep = entries.find(e => depthOf(e.item) > limits.depth);
  if (deep) throw new EvaluationError(`The ${deep.at ?? 'item'} is nested deeper than ${limits.depth} levels: flatten it with code. Nothing was sent.`);
  const groups = new Map();
  for (const { id, item } of entries) {
    const content = withoutId(item);
    const key = keyOf(content, dedupe);
    if (!groups.has(key)) groups.set(key, { ids: [], content, variants: new Set() });
    const g = groups.get(key);
    g.ids.push(id);
    if (dedupe === 'normalized' && g.variants.size < 3) g.variants.add(JSON.stringify(content));
  }
  const list = [...groups.values()];
  if (list.length > limits.distinctItems) throw new EvaluationError(`${list.length} distinct items exceed the ${limits.distinctItems} per call: reduce them with code first (filter, group${dedupe === 'exact' ? ', or dedupe: "normalized" for log lines' : ''}) or split them across calls. Nothing was sent.`);
  // Every item is checked, not only the representatives: with normalized grouping a credential may sit
  // in a member that is never sent, and the agent should still learn the file holds one.
  const leaked = entries.map(e => [e.at ?? 'an item', findCredential(e.item)]).filter(([, kind]) => kind);
  if (leaked.length) throw new EvaluationError(`What looks like a credential (${leaked[0][1]}) is in ${leaked.slice(0, 10).map(([at]) => at).join(', ')}${leaked.length > 10 ? ` and ${leaked.length - 10} more` : ''}: redact it with code and retry. Nothing was sent.`);
  if (context !== undefined && findCredential(context)) throw new EvaluationError('context contains what looks like a credential: redact it and retry. Nothing was sent.');

  // A state must be non-empty text, an object or an array: wrap anything else (42, false, null, "").
  const valid = c => (typeof c === 'string' && c.length > 0) || (c !== null && typeof c === 'object');
  const qids = Object.keys(questions);
  // One request per batch of distinct items. A batch of one is the plain request; a larger one sends
  // the items under items.item_N and each question once per item, told which item to consider.
  const requestFor = batch => {
    if (batch.length === 1) {
      const c = batch[0].content;
      return { state: context !== undefined ? { context, item: c } : valid(c) ? c : { item: c }, questions, read: res => [res.answers] };
    }
    const items = {}, qs = {}, keys = [];
    batch.forEach((g, j) => {
      const ref = `item_${j + 1}`;
      items[ref] = g.content;
      const mine = {};
      qids.forEach((qid, k) => {
        const id = `q${k + 1}_${ref}`, q = questions[qid];
        // TypeSafe's syntax for pointing a question at a nested value: a backticked dot path.
        const ins = typeof q.instructions === 'string' ? `About \`items.${ref}\` only: ${q.instructions}` : { about: `items.${ref}`, question: q.instructions };
        qs[id] = { ...q, instructions: ins };
        mine[qid] = id;
      });
      keys.push(mine);
    });
    return { state: context !== undefined ? { context, items } : { items }, questions: qs, read: res => keys.map(mine => Object.fromEntries(qids.map(qid => [qid, res.answers[mine[qid]]]))) };
  };
  const perRequest = Math.max(1, Math.min(limits.batchItems, Math.floor(limits.batchQuestions / qids.length)));
  const batches = [];
  for (const g of list) {
    const size = JSON.stringify(g.content).length;
    const last = batches.at(-1);
    if (last && last.length < perRequest && last.chars + size <= limits.batchChars) { last.push(g); last.chars += size; }
    else batches.push(Object.assign([g], { chars: size }));
  }
  // usage: tokens of accepted responses; requests: every request actually sent.
  const usage = { input_tokens: 0, output_tokens: 0 };
  let requests = 0;
  // Never more than the time actually left (requests are not started once it is gone).
  const send = async unit => {
    const { read, ...request } = requestFor(unit);
    requests++;
    // Whole milliseconds: AbortSignal.timeout refuses a fractional delay.
    const res = await evaluateOne(request, { signal, timeoutMs: Math.max(1, Math.floor(Math.min(limits.perItemMs, limits.budgetMs - (now() - started)))) });
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;
    const answers = read(res);
    unit.forEach((g, j) => { g.result = { model: res.model, answers: answers[j], metadata: res.metadata }; });
  };
  // One queue of units (a batch, or one item): a batch the provider rejected unprocessed comes back as
  // single items at the end, handled by the same pool with the same budget, breaker and accounting.
  const queue = [...batches];
  const running = new Set();
  let poolOpen = false;
  // stop: why the remaining items are not sent, kept apart from any item's own error.
  let next = 0, done = 0, succeeded = 0, failedInARow = 0, stop = null;
  const halted = () => {
    if (!stop && signal?.aborted) stop = { reason: 'the call was cancelled', fatal: false };
    if (!stop && now() - started >= limits.budgetMs) stop = { reason: 'the time budget ran out', fatal: false };
    return !!stop;
  };
  const attempt = async unit => {
    try { await send(unit); succeeded++; failedInARow = 0; } catch (e) {
      const message = e instanceof EvaluationError ? e.message : 'Evaluation failed.';
      failedInARow++;
      if (e instanceof EvaluationError && e.fatal) stop ??= { reason: message, fatal: true };
      else if (!succeeded && failedInARow >= limits.breakerAfter) stop ??= { reason: `the first ${failedInARow} requests all failed (last: ${message})`, fatal: false };
      // Only a request refused unprocessed is split: a dropped connection or a rate limit may have been
      // processed and billed, so its items are not sent again.
      // Requeued even when the breaker just tripped: then they end up skipped, like every unit not started.
      if (unit.length > 1 && e instanceof EvaluationError && e.rejected) { for (const g of unit) queue.push([g]); spawn(); return; }
      for (const g of unit) g.error = message;
    }
    onProgress?.(done += unit.length, list.length);
  };
  // Warm-up: requests go one at a time until one succeeds, so a provider that fails every request is
  // sent at most breakerAfter of them; only then the pool opens. A fatal error stops at once.
  while (!succeeded && next < queue.length && !halted()) await attempt(queue[next++]);
  // Up to `concurrency` workers drain the queue; units requeued later open more of them (spawn), so a
  // late split runs in parallel instead of on the one worker that found it.
  const worker = async () => {
    while (next < queue.length) {
      const unit = queue[next++];
      if (halted()) { for (const g of unit) g.skipped = true; continue; }
      await attempt(unit);
    }
  };
  function spawn() {
    // Each new worker takes a unit at once: start them while one is still untaken.
    while (poolOpen && running.size < limits.concurrency && next < queue.length) {
      const w = worker().finally(() => running.delete(w));
      running.add(w);
    }
  }
  if (succeeded) { poolOpen = true; spawn(); while (running.size) await Promise.all([...running]); }
  for (const unit of queue.slice(next)) for (const g of unit) g.skipped = true;
  if (!succeeded) {
    const errors = list.filter(g => g.error), skipped = list.filter(g => g.skipped);
    const why = [stop && `Stopped: ${stop.reason}.`, errors.length && !stop?.reason.includes(errors[errors.length - 1].error) && `Last error: ${errors[errors.length - 1].error}`].filter(Boolean).join(' ');
    throw new EvaluationError(`No item was evaluated (${errors.length} failed, ${skipped.length} not evaluated). ${why}`, { fatal: !!stop?.fatal });
  }
  return summarize(list, questions, { entries: entries.length, dedupe, stop, usage, requests, elapsed: now() - started, limits, resultsDir });
}

function summarize(list, questions, { entries, dedupe, stop, usage, requests, elapsed, limits, resultsDir }) {
  const ok = list.filter(g => g.result);
  const summary = {};
  for (const [qid, q] of Object.entries(questions)) {
    // A Map: a label such as "constructor" must not meet Object.prototype.
    const counts = new Map(), uncertain = [];
    let uncertainTotal = 0;
    for (const g of ok) {
      const a = g.result.answers[qid];
      const bucket = q.type === 'choice' ? a.choice : q.type === 'score' ? String(Math.round(a.score)) : a.noul >= NOUL_YES ? 'yes' : a.noul <= NOUL_NO ? 'no' : 'uncertain';
      counts.set(bucket, (counts.get(bucket) ?? 0) + g.ids.length);
      if (!isUncertain(a)) continue;
      uncertainTotal += g.ids.length;
      for (const id of g.ids) { if (uncertain.length >= limits.listedIds) break; uncertain.push(shortId(id, limits)); }
    }
    summary[qid] = { type: q.type, counts: Object.fromEntries(counts), uncertain_ids: uncertain, ...(uncertainTotal > uncertain.length && { uncertain_total: uncertainTotal }) };
  }
  // Every group, with its full answers, for the agent to filter with code (jq, a script).
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const resultsFile = path.join(resultsDir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.jsonl`);
  writeFileSync(resultsFile, list.map(g => JSON.stringify({ ids: g.ids, count: g.ids.length, item: g.content, ...(g.variants?.size > 1 && { variants: [...g.variants].map(v => JSON.parse(v)) }), ...(g.result ? { answers: g.result.answers } : g.error ? { error: g.error } : { skipped: true }) })).join('\n') + '\n', { mode: 0o600 });

  const errors = list.filter(g => g.error), skipped = list.filter(g => g.skipped);
  const models = [...new Set(ok.map(g => g.result.model))];
  const { elapsed_ms, attempts, served_by, ...meta } = ok[0].result.metadata ?? {};
  return {
    model: models.length === 1 ? models[0] : models,
    items: entries, distinct: list.length, ...(dedupe === 'normalized' && { dedupe }), evaluated: ok.length, errors: errors.length, skipped: skipped.length,
    summary,
    // Ids per row are capped: one line repeated thousands of times is one distinct item.
    ...(list.length <= limits.inlineResults && { results: list.map(g => ({ ids: g.ids.slice(0, limits.listedIds).map(id => shortId(id, limits)), ...(g.ids.length > limits.listedIds && { count: g.ids.length }), ...(g.result ? { answers: Object.fromEntries(Object.entries(g.result.answers).map(([k, a]) => [k, compact(a)])) } : g.error ? { error: g.error } : { skipped: true }) })) }),
    results_file: resultsFile,
    ...(errors.length && { error_sample: errors[0].error }),
    ...(skipped.length && { note: `${skipped.length} distinct items were not evaluated (${stop ? `stopped: ${stop.reason}` : 'not reached'}); results_file marks them "skipped": pass them again as items.` }),
    usage,
    metadata: { ...meta, requests, served_by: [...new Set(ok.map(g => g.result.metadata?.served_by).filter(Boolean))], elapsed_ms: elapsed },
  };
}
