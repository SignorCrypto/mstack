import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { allowedRoots, checkItemsFile, evaluateItems as realEvaluateItems, loadItemsFile, parseItems, LIMITS } from '../src/items.mjs';
import { evaluate, findCredential, inputSchema } from '../src/systemone.mjs';
import { targetFor } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { EvaluationError } from '../src/secrets.mjs';

const questions = {
  severity: { type: 'choice', instructions: 'How severe is this log message?', criteria: { high: 'Outage or data loss', low: 'Noise', unknown: 'Cannot tell' } },
  actionable: { type: 'noul', instructions: 'Does this message call for a code change?' },
};
// A fake provider: "fatal" lines are high, "maybe" lines are borderline, the rest are low.
const answerFor = state => {
  const text = JSON.stringify(state);
  const high = text.includes('fatal'), maybe = text.includes('maybe');
  return { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 }, metadata: { provider: 'typesafe', requested_model: 'jev-latest', zdr_requested: false, served_by: 'typesafe', elapsed_ms: 5, attempts: 1 }, answers: {
    severity: { type: 'choice', choice: high ? 'high' : 'low', probabilities: high ? { high: 0.9, low: 0.05, unknown: 0.05 } : maybe ? { high: 0.4, low: 0.45, unknown: 0.15 } : { high: 0.02, low: 0.95, unknown: 0.03 }, confidence: maybe ? 0.2 : 0.9 },
    actionable: { type: 'noul', noul: high ? 0.9 : maybe ? 0.5 : 0.1 },
  } };
};
// Batched requests carry items under state.items and questions named q<k>_item_<n>: answer each from its item.
const respond = request => {
  const ids = Object.keys(request.questions);
  if (!ids.every(id => /^q\d+_item_\d+$/.test(id))) return answerFor(request.state);
  const answers = {};
  for (const id of ids) {
    const ref = id.slice(id.indexOf('_') + 1);
    answers[id] = answerFor(request.state.items[ref]).answers[request.questions[id].type === 'noul' ? 'actionable' : 'severity'];
  }
  return { ...answerFor(''), answers };
};
const fake = (log = []) => async (request, options) => { log.push({ request, options }); return respond(request); };
// Most tests check per-item semantics (scheduling, budget, errors): one item per request. Batching has its own tests.
const ONE = { ...LIMITS, batchItems: 1 };
const evaluateItems = (input, options = {}) => realEvaluateItems(input, { limits: ONE, ...options });
const workdir = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'dm-items-')));

test('items_file: dedupes, keeps line ids, counts per label, flags uncertain, writes the results file', async () => {
  const dir = workdir();
  const file = path.join(dir, 'errors.log');
  writeFileSync(file, 'fatal: db down\n\nretry ok\nfatal: db down\nmaybe slow\nretry ok\n');
  const log = [];
  const out = await evaluateItems({ entries: loadItemsFile(file), questions, context: 'Botchi backend logs' }, { evaluateOne: fake(log), resultsDir: dir });
  assert.equal(out.items, 5);
  assert.equal(out.distinct, 3);
  assert.equal(log.length, 3, 'one provider call per distinct item');
  assert.deepEqual(log[0].request.state, { context: 'Botchi backend logs', item: 'fatal: db down' });
  assert.deepEqual(out.summary.severity.counts, { high: 2, low: 3 });
  assert.deepEqual(out.summary.severity.uncertain_ids, [5]);
  assert.deepEqual(out.summary.actionable.counts, { yes: 2, no: 2, uncertain: 1 });
  assert.deepEqual(out.results[0], { ids: [1, 4], answers: { severity: { choice: 'high', p: 0.9, confidence: 0.9 }, actionable: { p: 0.9 } } });
  const lines = readFileSync(out.results_file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].item, 'fatal: db down');
  assert.equal(lines[0].answers.severity.probabilities.high, 0.9);
  assert.deepEqual(out.usage, { input_tokens: 30, output_tokens: 6 });
  assert.equal(out.model, 'jev-1.13.0');
});

test('Parsing: .jsonl uses the id field (not sent), .json arrays use positions, bad JSON names the line', () => {
  assert.deepEqual(parseItems('{"id":"e1","msg":"a"}\n\n{"msg":"b"}\n', 'x.jsonl'), [{ id: 'e1', at: 'line 1', item: { id: 'e1', msg: 'a' } }, { id: 3, at: 'line 3', item: { msg: 'b' } }]);
  assert.deepEqual(parseItems('["a",{"id":7,"m":"b"}]', 'x.json'), [{ id: 1, at: 'array position 1', item: 'a' }, { id: '7', at: 'array position 2', item: { id: 7, m: 'b' } }]);
  // An explicit id 1 and the item on line 1 stay distinguishable: '1' vs 1.
  assert.deepEqual(parseItems('{"id":1,"m":"a"}\n"b"\n', 'x.jsonl').map(e => e.id), ['1', 2]);
  assert.throws(() => parseItems('{"ok":1}\n{oops', 'x.ndjson'), /line 2 is not valid JSON/);
  assert.throws(() => parseItems('{"a":1}', 'x.json'), /must hold an array/);
});

test('The id field is not sent and does not defeat deduplication', async () => {
  const log = [];
  const out = await evaluateItems({ entries: [{ id: 'a', item: { id: 'a', msg: 'same' } }, { id: 'b', item: { id: 'b', msg: 'same' } }], questions }, { evaluateOne: fake(log), resultsDir: workdir() });
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].request.state, { msg: 'same' });
  assert.deepEqual(out.results[0].ids, ['a', 'b']);
});

test('items_file path rules: absolute, inside a temp root, regular, size cap, symlinks resolved', () => {
  const dir = workdir();
  const roots = [dir];
  const ok = path.join(dir, 'items.jsonl'); writeFileSync(ok, '"a"\n');
  assert.equal(checkItemsFile(ok, roots).real, ok);
  assert.throws(() => checkItemsFile('items.jsonl', roots), /absolute/);
  assert.throws(() => checkItemsFile(path.join(dir, 'missing.txt'), roots), /not found/);
  const outside = workdir(); writeFileSync(path.join(outside, 'x.txt'), 'a');
  assert.throws(() => checkItemsFile(path.join(outside, 'x.txt'), roots), /must be in a temp directory/);
  mkdirSync(path.join(dir, 'sub'));
  assert.throws(() => checkItemsFile(path.join(dir, 'sub'), roots), /not a regular file/);
  symlinkSync(path.join(outside, 'x.txt'), path.join(dir, 'link.txt'));
  assert.throws(() => checkItemsFile(path.join(dir, 'link.txt'), roots), /must be in a temp directory/, 'a symlink out of the root is resolved');
  writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(LIMITS.fileBytes + 1, 'a'));
  assert.throws(() => checkItemsFile(path.join(dir, 'big.txt'), roots), /exceeds/);
});

test('Allowed roots: temp directories and the user-listed ones; never the project, the home directory or /', () => {
  const roots = allowedRoots({ env: {} });
  assert.ok(roots.includes(realpathSync(tmpdir())));
  assert.ok(!roots.includes(realpathSync(process.cwd())), 'the project is not a root');
  assert.ok(!roots.includes(realpathSync(homedir())));
  const extra = workdir();
  assert.ok(allowedRoots({ env: { DECISION_MODEL_ALLOWED_DIRS: extra } }).includes(extra));
  assert.ok(!allowedRoots({ env: { DECISION_MODEL_ALLOWED_DIRS: '/' } }).includes('/'));
  // The project's own files must be copied out first: a path slipped into a prompt cannot reach them.
  assert.throws(() => checkItemsFile(fileURLToPath(new URL('../package.json', import.meta.url))), /must be in a temp directory/);
});

test('Too many distinct items or a credential: refused before anything is sent', async () => {
  const log = [];
  const many = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  await assert.rejects(evaluateItems({ entries: many, questions }, { evaluateOne: fake(log), limits: { ...ONE, distinctItems: 3 } }), /4 distinct items exceed the 3/);
  const leaked = [{ id: 1, at: 'line 1', item: 'ok' }, { id: 2, at: 'line 2', item: 'auth ghp_' + 'a'.repeat(36) }];
  await assert.rejects(evaluateItems({ entries: leaked, questions }, { evaluateOne: fake(log) }), /credential \(GitHub token\) is in line 2:/);
  await assert.rejects(evaluateItems({ entries: [], questions }, { evaluateOne: fake(log) }), /No items/);
  assert.equal(log.length, 0);
});

test('State mode refuses credentials too, before any provider call', async () => {
  let calls = 0;
  await assert.rejects(evaluate({ state: '-----BEGIN RSA PRIVATE KEY-----\nabc', questions }, { target: targetFor('typesafe'), apiKey: 'k', fetchImpl: async () => { calls++; } }), /private key/);
  assert.equal(calls, 0);
});

test('Fatal errors are typed at the source: one stops the call; others are per item', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  let n = 0;
  await assert.rejects(evaluateItems({ entries, questions }, { evaluateOne: async () => { n++; throw new EvaluationError('Missing AI_GATEWAY_API_KEY', { fatal: true }); } }), e => /Missing AI_GATEWAY_API_KEY/.test(e.message) && e.fatal);
  assert.equal(n, 1, 'a fatal first item fails the call once');
  const flaky = async request => { if (request.state === 'line 2') throw new EvaluationError('Rate limit reached; retry later.'); return answerFor(request.state); };
  const out = await evaluateItems({ entries, questions }, { evaluateOne: flaky, limits: { ...ONE, concurrency: 1 }, resultsDir: workdir() });
  assert.equal(out.errors, 1); assert.equal(out.evaluated, 5); assert.match(out.error_sample, /Rate limit/);
  n = 0;
  const credits = async request => { n++; if (request.state !== 'line 0') throw new EvaluationError('Vercel AI Gateway HTTP 402. Insufficient credits.', { fatal: true }); return answerFor(request.state); };
  const stopped = await evaluateItems({ entries, questions }, { evaluateOne: credits, limits: { ...ONE, concurrency: 1 }, resultsDir: workdir() });
  assert.equal(n, 2, 'stops after the first fatal error');
  assert.equal(stopped.skipped, 4);
  assert.match(stopped.note, /4 distinct items were not evaluated \(stopped: Vercel AI Gateway HTTP 402/);
  // The message no longer decides: a 400 on a model whose name contains "config" is per item.
  n = 0;
  const odd = async request => { n++; if (request.state === 'line 1') throw new EvaluationError('HTTP 400. Request rejected; check that model "configurator" is a decision model.'); return answerFor(request.state); };
  const went = await evaluateItems({ entries, questions }, { evaluateOne: odd, limits: { ...ONE, concurrency: 1 }, resultsDir: workdir() });
  assert.equal(n, 6); assert.equal(went.errors, 1);
});

test('Breaker: when the first items all fail and none succeeds, the rest is not sent', async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  let n = 0;
  await assert.rejects(evaluateItems({ entries, questions }, { evaluateOne: async () => { n++; throw new EvaluationError('HTTP 400. Request rejected.'); } }), /No item was evaluated \(5 failed, 15 not evaluated\)\. Stopped: the first 5 requests all failed \(last: HTTP 400/);
  assert.equal(n, LIMITS.breakerAfter, 'warm-up sends one at a time: exactly breakerAfter requests');
  // One slow success during warm-up opens the pool; failures before it do not stop the batch.
  n = 0;
  const late = async request => { n++; if (n <= 3) throw new EvaluationError('HTTP 400. Request rejected.'); return answerFor(request.state); };
  const out = await evaluateItems({ entries, questions }, { evaluateOne: late, resultsDir: workdir() });
  assert.equal(out.errors, 3); assert.equal(out.evaluated, 17);
  // The stop reason survives an earlier item-specific error: 413 first, then 402.
  n = 0;
  const credits = async () => { n++; throw n === 1 ? new EvaluationError('HTTP 413. Too large.') : new EvaluationError('HTTP 402. Insufficient credits.', { fatal: true }); };
  await assert.rejects(evaluateItems({ entries, questions }, { evaluateOne: credits }), e => /\(2 failed, 18 not evaluated\)\. Stopped: HTTP 402/.test(e.message) && e.fatal);
});

test('Typed errors from evaluate: key failures and 401-404 are fatal, 413 is not', async () => {
  const target = targetFor('typesafe');
  for (const [status, fatal] of [[402, true], [404, true], [413, false], [422, false]]) {
    await assert.rejects(evaluate({ state: 'x', questions }, { target, apiKey: 'k', fetchImpl: async () => new Response('', { status }) }), e => e.fatal === fatal, String(status));
  }
  const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(evaluate({ state: 'x', questions }, { target: targetFor('typesafe', null, { keys: { TYPESAFE_API_KEY: '/usr/bin/false' } }), fetchImpl: async () => {} }), e => e.fatal === true);
  } finally { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; }
});

test('Time budget: items not started in time are skipped, and each call gets the remaining time', async () => {
  let clock = 0;
  const seen = [];
  const slow = async (request, options) => { seen.push(options.timeoutMs); clock += 20_000; return answerFor(request.state); };
  const entries = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  const out = await evaluateItems({ entries, questions }, { evaluateOne: slow, now: () => clock, limits: { ...ONE, concurrency: 1 }, resultsDir: workdir() });
  assert.deepEqual(seen, [45_000, 30_000, 10_000]);
  assert.equal(out.evaluated, 3); assert.equal(out.skipped, 2);
  const lines = readFileSync(out.results_file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.filter(l => l.skipped).map(l => l.ids[0]), [4, 5]);
});

test('Large batches return the summary and results file, not inline results', async () => {
  const entries = Array.from({ length: LIMITS.inlineResults + 1 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  const out = await evaluateItems({ entries, questions }, { evaluateOne: fake(), resultsDir: workdir() });
  assert.equal(out.results, undefined);
  assert.equal(out.summary.severity.counts.low, LIMITS.inlineResults + 1);
});

test('Tool schema: exactly one source; context only in items mode', () => {
  assert.equal(inputSchema.safeParse({ state: 'x', questions }).success, true);
  assert.equal(inputSchema.safeParse({ items: ['a'], context: 'logs', questions }).success, true);
  assert.equal(inputSchema.safeParse({ items_file: '/tmp/x.txt', questions }).success, true);
  assert.equal(inputSchema.safeParse({ questions }).success, false);
  assert.equal(inputSchema.safeParse({ state: 'x', items: ['a'], questions }).success, false);
  assert.equal(inputSchema.safeParse({ state: 'x', context: 'c', questions }).success, false);
  assert.equal(inputSchema.safeParse({ items: [], questions }).success, false);
  assert.equal(inputSchema.safeParse({ items: ['a'], dedupe: 'normalized', questions }).success, true);
  assert.equal(inputSchema.safeParse({ state: 'x', dedupe: 'normalized', questions }).success, false);
  assert.equal(inputSchema.safeParse({ items: ['a'], dedupe: 'fuzzy', questions }).success, false);
});

test('MCP: items_file through the server returns the summary; path refusals are tool errors', async () => {
  const dir = workdir();
  const file = path.join(dir, 'msgs.txt'); writeFileSync(file, 'fatal: x\nok\n');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(fake(), { roots: [dir] });
  const client = new Client({ name: 'items', version: '1' });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const res = await client.callTool({ name: 'Evaluate', arguments: { items_file: file, questions } });
    assert.notEqual(res.isError, true);
    assert.deepEqual(res.structuredContent.summary.severity.counts, { high: 1, low: 1 });
    const inline = await client.callTool({ name: 'Evaluate', arguments: { items: ['fatal', 'fine'], questions } });
    assert.equal(inline.structuredContent.distinct, 2);
    const refused = await client.callTool({ name: 'Evaluate', arguments: { items_file: '/etc/hosts', questions } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /must be in a temp directory/);
  } finally { await client.close(); await server.close(); }
});

// ---- Review fixes (sol, pass 1)

test('A credential that starts a new line is caught, in state and in items', async () => {
  const token = 'ghp_' + 'a'.repeat(36);
  let calls = 0;
  await assert.rejects(evaluate({ state: `request failed\n${token}`, questions }, { target: targetFor('typesafe'), apiKey: 'k', fetchImpl: async () => { calls++; } }), /GitHub token/);
  await assert.rejects(evaluateItems({ entries: [{ id: 1, at: 'line 1', item: { msg: `line one\nAuthorization: ${token}` } }], questions }, { evaluateOne: async () => { calls++; } }), /is in line 1/);
  assert.equal(calls, 0);
});

test('A slow key lookup counts against the deadline', async () => {
  const dir = workdir();
  const bin = path.join(dir, 'slow-key');
  writeFileSync(bin, '#!/bin/sh\nsleep 3\nprintf k\n', { mode: 0o755 });
  const saved = process.env.AI_GATEWAY_API_KEY; delete process.env.AI_GATEWAY_API_KEY;
  try {
    const t = Date.now(); let calls = 0;
    await assert.rejects(evaluate({ state: 'x', questions }, { target: targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: bin } }), timeoutMs: 300, fetchImpl: async () => { calls++; } }), /timed out while reading AI_GATEWAY_API_KEY/);
    assert.ok(Date.now() - t < 2000); assert.equal(calls, 0);
  } finally { if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved; }
});

test('An error of the first item alone is recorded and the batch goes on; all failing is an error', async () => {
  const entries = ['huge', 'fatal: a', 'fine'].map((item, i) => ({ id: i + 1, item }));
  const tooLarge = async request => { if (request.state === 'huge') throw new EvaluationError('Vercel AI Gateway HTTP 413. Request too large for the model.'); return answerFor(request.state); };
  const out = await evaluateItems({ entries, questions }, { evaluateOne: tooLarge, resultsDir: workdir() });
  assert.equal(out.evaluated, 2); assert.equal(out.errors, 1);
  assert.deepEqual(out.results[0], { ids: [1], error: 'Vercel AI Gateway HTTP 413. Request too large for the model.' });
  await assert.rejects(evaluateItems({ entries, questions }, { evaluateOne: async () => { throw new EvaluationError('Evaluation cancelled or timed out.'); } }), /No item was evaluated \(3 failed, 0 not evaluated\)\. Last error: Evaluation cancelled/);
});

test('Scalar items are wrapped into a valid state', async () => {
  const log = [];
  await evaluateItems({ entries: [42, false, null, ''].map((item, i) => ({ id: i + 1, item })), questions }, { evaluateOne: async (r, o) => { log.push(r.state); return answerFor(r.state); }, resultsDir: workdir() });
  assert.deepEqual(log.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ item: '' }, { item: 42 }, { item: false }, { item: null }]);
});

test('One line repeated 150,000 times: one request, capped ids, no crash', async () => {
  const entries = Array.from({ length: 150_000 }, (_, i) => ({ id: i + 1, item: 'maybe slow' }));
  const out = await evaluateItems({ entries, questions }, { evaluateOne: fake(), resultsDir: workdir() });
  assert.equal(out.distinct, 1);
  assert.equal(out.summary.severity.uncertain_ids.length, LIMITS.listedIds);
  assert.equal(out.summary.severity.uncertain_total, 150_000);
  assert.equal(out.results[0].ids.length, LIMITS.listedIds);
  assert.equal(out.results[0].count, 150_000);
});

test('A Choice label named like an Object.prototype property counts correctly', async () => {
  const q = { kind: { type: 'choice', instructions: 'Which kind?', criteria: { constructor: 'A constructor', toString: 'A method' } } };
  const out = await evaluateItems({ entries: [{ id: 1, item: 'a' }, { id: 2, item: 'b' }], questions: q }, { resultsDir: workdir(), evaluateOne: async () => ({ model: 'm', usage: {}, metadata: {}, answers: { kind: { type: 'choice', choice: 'constructor', probabilities: { constructor: 0.9, toString: 0.1 }, confidence: 0.9 } } }) });
  assert.equal(out.summary.kind.counts.constructor, 2);
});

test('normalized dedupe: ids, timestamps and numbers merge; a lone 0, id prefixes and structure do not', async () => {
  const lines = [
    '2026-11-18T08:01:12Z INFO user 4821 opened dashboard',                         // 1
    '2026-11-18T09:44:03.120Z INFO user 77 opened dashboard',                       // 2 = 1
    '2026-11-18T08:03:05Z ERROR stripe webhook verification failed for evt_1QabcD', // 3
    '2026-11-18T08:09:15Z ERROR stripe webhook verification failed for evt_9ZzzyX', // 4 = 3
    '08:04:11 ERROR request 3f2a9c1be0d4 failed after 1200ms',                      // 5
    '08:05:11 ERROR request 7c1d00ab99ef failed after 87ms',                        // 6 = 5
    'export for workspace 4410 wrote 0 rows',                                       // 7
    'export for workspace 5521 wrote 12 rows',                                      // 8 != 7
    'export for workspace 5522 wrote 0.5 rows',                                     // 9 = 8 (0.5 is not a lone 0)
    'dispatch evt_a1234',                                                           // 10
    'dispatch job_b1234',                                                           // 11 != 10
    'requests \uE000n\uE001',                                                       // 12: literal placeholder text
    'requests 23456',                                                               // 13 != 12
  ];
  const log = [];
  const dir = workdir();
  const entries = lines.map((item, i) => ({ id: i + 1, item }));
  const out = await evaluateItems({ entries, questions, dedupe: 'normalized' }, { evaluateOne: fake(log), resultsDir: dir });
  assert.deepEqual(out.results.map(r => r.ids), [[1, 2], [3, 4], [5, 6], [7], [8, 9], [10], [11], [12], [13]]);
  assert.equal(log[0].request.state, lines[0], 'the representative is a real line, not the placeholder key');
  const first = JSON.parse(readFileSync(out.results_file, 'utf8').split('\n')[0]);
  assert.deepEqual(first.variants, [lines[0], lines[1]], 'results_file shows the variants of a group');
  // Structure is kept: escapes in JSON cannot blend into an id.
  const json = [{ m: 'a\nevt_1234x' }, { m: 'a\tevt_1234x' }].map((item, i) => ({ id: i + 1, item }));
  assert.equal((await evaluateItems({ entries: json, questions, dedupe: 'normalized' }, { evaluateOne: fake(), resultsDir: workdir() })).distinct, 2);
});

test('Deep nesting is refused with a clear error, not a stack overflow; ids in responses are capped in length', async () => {
  let deep = 'x'; for (let i = 0; i < 5000; i++) deep = [deep];
  await assert.rejects(evaluateItems({ entries: [{ id: 1, item: deep }], questions }, { evaluateOne: fake() }), /nested deeper than 60 levels/);
  assert.equal(findCredential(deep), null);
  const long = 'i'.repeat(100_000);
  const out = await evaluateItems({ entries: [{ id: long, item: 'maybe a' }], questions }, { evaluateOne: fake(), resultsDir: workdir() });
  assert.equal(out.summary.severity.uncertain_ids[0].length, LIMITS.idChars + 1);
  assert.ok(JSON.stringify(out).length < 5000);
});

test('A credential in a group member that would not be sent is still refused', async () => {
  const token = 'ghp_' + 'b'.repeat(36);
  const entries = [{ id: 1, item: 'auth failed for user 1' }, { id: 2, item: `auth failed for user 2 ${token}` }];
  let calls = 0;
  await assert.rejects(evaluateItems({ entries, questions, dedupe: 'normalized' }, { evaluateOne: async () => { calls++; } }), /is in an item/);
  // A credential used as an id is never echoed: errors name the source position.
  const parsed = parseItems(JSON.stringify({ id: token, msg: 'x' }) + '\n', 'x.jsonl');
  await assert.rejects(evaluateItems({ entries: parsed, questions }, { evaluateOne: async () => { calls++; } }), e => /is in line 1/.test(e.message) && !e.message.includes(token));
  assert.equal(calls, 0);
});

test('Cancelled before a failing key lookup: no unhandled rejection', async () => {
  const dir = workdir();
  const bin = path.join(dir, 'failing-key');
  writeFileSync(bin, '#!/bin/sh\nsleep 0.2\nexit 1\n', { mode: 0o755 });
  const saved = process.env.AI_GATEWAY_API_KEY; delete process.env.AI_GATEWAY_API_KEY;
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(evaluate({ state: 'x', questions }, { target: targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: bin } }), signal: AbortSignal.abort(), fetchImpl: async () => {} }), /cancelled or timed out/);
    await new Promise(r => setTimeout(r, 600));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved; }
});

test('A 401 key refresh also counts against the deadline', async () => {
  const dir = workdir();
  const flag = path.join(dir, 'second');
  const bin = path.join(dir, 'rotating-key');
  writeFileSync(bin, `#!/bin/sh\nif [ -f "${flag}" ]; then sleep 3; fi\ntouch "${flag}"\nprintf k\n`, { mode: 0o755 });
  const saved = process.env.AI_GATEWAY_API_KEY; delete process.env.AI_GATEWAY_API_KEY;
  try {
    const t = Date.now();
    await assert.rejects(evaluate({ state: 'x', questions }, { target: targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: bin } }), timeoutMs: 500, fetchImpl: async () => new Response('', { status: 401 }) }), /timed out while reading/);
    assert.ok(Date.now() - t < 2000);
  } finally { if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved; }
});

// ---- Review fixes (sol, change set 2)

test('A broken response stream does not hide a fatal status', async () => {
  for (const status of [401, 402, 403, 404]) {
    const body = new ReadableStream({ start(c) { c.error(new Error('stream broke')); } });
    const res = new Response(body, { status });
    Object.defineProperty(res, 'body', { value: { cancel: () => Promise.reject(new Error('cancel failed')) } });
    await assert.rejects(evaluate({ state: 'x', questions }, { target: targetFor('typesafe'), apiKey: 'k', fetchImpl: async () => res }), e => e.fatal === true && new RegExp(`HTTP ${status}`).test(e.message), String(status));
  }
});

test('A key rotated mid-batch: parallel 401s share one refresh', async () => {
  const dir = workdir();
  const count = path.join(dir, 'count'); writeFileSync(count, '');
  const current = path.join(dir, 'current'); writeFileSync(current, 'old');
  const bin = path.join(dir, 'key');
  writeFileSync(bin, `#!/bin/sh\necho x >> "${count}"\ncat "${current}"\n`, { mode: 0o755 });
  const saved = process.env.AI_GATEWAY_API_KEY; delete process.env.AI_GATEWAY_API_KEY;
  try {
    const target = targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: bin } });
    const valid = { key: 'old' };
    const fetchImpl = async (_, o) => o.headers.Authorization === `Bearer ${valid.key}` ? Response.json(answerFor('x')) : new Response('', { status: 401 });
    await evaluate({ state: 'x', questions }, { target, fetchImpl });
    writeFileSync(current, 'new'); valid.key = 'new';
    await Promise.all(Array.from({ length: 20 }, () => evaluate({ state: 'x', questions }, { target, fetchImpl })));
    assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 2, 'one read before, one shared refresh after the rotation');
  } finally { if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved; }
});

test('The budget runs from the start of the tool call', async () => {
  let clock = 100_000;
  const entries = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  const seen = [];
  await evaluateItems({ entries, questions }, { now: () => clock, started: clock - 40_000, evaluateOne: async (r, o) => { seen.push(o.timeoutMs); clock += 1; return answerFor(r.state); }, limits: { ...ONE, concurrency: 1 }, resultsDir: workdir() });
  assert.ok(seen[0] <= 10_000, `first item got ${seen[0]} ms of a budget mostly spent before it`);
});

// ---- Review fixes (sol, change set 2, pass 2)

test('A lone 0 stays distinct before punctuation too', async () => {
  const entries = ['Rows written: 0.', 'Rows written: 12.', 'Rows written: 7.'].map((item, i) => ({ id: i + 1, item }));
  const out = await evaluateItems({ entries, questions, dedupe: 'normalized' }, { evaluateOne: fake(), resultsDir: workdir() });
  assert.deepEqual(out.results.map(r => r.ids), [[1], [2, 3]]);
});

test('Rotation where the first refresh still returns the revoked key: staggered 401s refresh once each, never per request', async () => {
  const dir = workdir();
  const count = path.join(dir, 'count'); writeFileSync(count, '');
  const bin = path.join(dir, 'key');
  writeFileSync(bin, `#!/bin/sh\necho x >> "${count}"\nprintf revoked\n`, { mode: 0o755 });
  const saved = process.env.AI_GATEWAY_API_KEY; delete process.env.AI_GATEWAY_API_KEY;
  try {
    const target = targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: bin } });
    let arrivals = 0;
    // Each request is rejected after a stagger, so 401s land at different times.
    const fetchImpl = async () => { await new Promise(r => setTimeout(r, 20 * (arrivals++ % 4))); return new Response('', { status: 401 }); };
    await Promise.allSettled(Array.from({ length: 4 }, () => evaluate({ state: 'x', questions }, { target, fetchImpl })));
    assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 2, 'one first read, one shared refresh');
  } finally { if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved; }
});

test('The stop reason is reported apart from item errors; the per-item timeout never exceeds the time left', async () => {
  let clock = 0;
  const entries = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  const seen = [];
  const tooLargeThenSlow = async (r, o) => { seen.push(o.timeoutMs); clock += 49_950; throw new EvaluationError('HTTP 413. Too large.'); };
  await assert.rejects(evaluateItems({ entries, questions }, { evaluateOne: tooLargeThenSlow, now: () => clock, resultsDir: workdir() }),
    e => /\(2 failed, 2 not evaluated\)\. Stopped: the time budget ran out\. Last error: HTTP 413/.test(e.message) && !e.fatal);
  assert.deepEqual(seen, [45_000, 50], 'the second item gets only the 50 ms actually left');
  clock = 0; seen.length = 0;
  const slowThenOk = async (r, o) => { seen.push(o.timeoutMs); clock += 49_950; return answerFor(r.state); };
  const out = await evaluateItems({ entries, questions }, { evaluateOne: slowThenOk, now: () => clock, resultsDir: workdir() });
  assert.equal(out.skipped, 2); assert.match(out.note, /stopped: the time budget ran out/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(evaluateItems({ entries, questions }, { evaluateOne: fake(), signal: ac.signal }), /Stopped: the call was cancelled/);
  clock = 49_950;
  await evaluateItems({ entries: entries.slice(0, 1), questions }, { evaluateOne: async (r, o) => { seen.push(o.timeoutMs); return answerFor(r.state); }, now: () => clock, started: 0, resultsDir: workdir() }).catch(() => {});
  assert.equal(seen.at(-1), 50, 'capped at the 50 ms actually left');
});

// ---- Batched requests

test('Batching: 10 distinct items per request, each asked its own copy of the questions, answers mapped back', async () => {
  const log = [];
  const entries = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, at: `line ${i + 1}`, item: i % 5 === 0 ? `fatal ${i}` : `ok ${i}` }));
  const out = await realEvaluateItems({ entries, questions, context: 'logs' }, { evaluateOne: fake(log), resultsDir: workdir() });
  assert.deepEqual(log.map(l => Object.keys(l.request.state.items ?? { one: 1 }).length), [10, 10, 3]);
  assert.equal(out.metadata.requests, 3);
  const first = log[0].request;
  assert.deepEqual(first.state.context, 'logs');
  assert.equal(first.questions.q1_item_2.instructions, 'About `items.item_2` only: How severe is this log message?');
  assert.deepEqual(first.questions.q1_item_2.criteria, questions.severity.criteria);
  assert.equal(Object.keys(first.questions).length, 20);
  assert.deepEqual(out.summary.severity.counts, { high: 5, low: 18 });
  assert.deepEqual(out.usage, { input_tokens: 30, output_tokens: 6 }, 'usage counted per request, not per item');
});

test('Batching respects the question cap and the size cap; a batch of one is the plain request', async () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`d${i}`, { type: 'noul', instructions: `Dimension ${i}?` }]));
  const log = [];
  const entries = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, item: `ok ${i}` }));
  const answerAll = async request => { log.push(request); return { model: 'm', usage: {}, metadata: {}, answers: Object.fromEntries(Object.keys(request.questions).map(k => [k, { type: 'noul', noul: 0.1 }])) }; };
  await realEvaluateItems({ entries, questions: many }, { evaluateOne: answerAll, resultsDir: workdir() });
  assert.deepEqual(log.map(r => Object.keys(r.questions).length), [48, 48, 12], '50 questions per request at most: 4 items of 12 questions');
  log.length = 0;
  const big = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, item: 'x'.repeat(15_000) + i }));
  await realEvaluateItems({ entries: big, questions }, { evaluateOne: fake(log), resultsDir: workdir() });
  assert.equal(log.length, 3, 'items too large to share a request go alone');
  assert.equal(typeof log[0].request.state, 'string', 'a batch of one is the plain request');
});

test('A batch rejected for its content is retried one item at a time; a fatal error is not', async () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, item: i === 2 ? 'huge' : `ok ${i}` }));
  const log = [];
  const picky = async request => {
    log.push(request);
    if (JSON.stringify(request.state).includes('huge')) throw new EvaluationError('HTTP 413. Too large.', { rejected: true });
    return respond(request);
  };
  const out = await realEvaluateItems({ entries, questions }, { evaluateOne: picky, resultsDir: workdir() });
  assert.equal(out.evaluated, 3); assert.equal(out.errors, 1);
  assert.equal(log.length, 5, 'one batch, then four single retries');
  assert.equal(out.metadata.requests, 5, 'requests counts what was actually sent');
  log.length = 0;
  await assert.rejects(realEvaluateItems({ entries, questions }, { evaluateOne: async r => { log.push(r); throw new EvaluationError('HTTP 402. Insufficient credits.', { fatal: true }); } }), e => e.fatal);
  assert.equal(log.length, 1, 'a fatal error is not retried item by item');
});

test('Batch answers map to the right item and question, structured instructions included', async () => {
  const qs = {
    a: { type: 'noul', instructions: 'Is it A?' },
    b: { type: 'noul', instructions: { ask: 'Is it B?' } },
  };
  const entries = ['x1', 'x2', 'x3'].map((item, i) => ({ id: `id${i + 1}`, item: { id: `id${i + 1}`, text: item } }));
  let sent;
  // Each answer encodes its own item and question: a = n/10, b = n/10 + 0.05 (computed exactly).
  const echo = async request => {
    sent = request;
    const answers = {};
    for (const [qid, q] of Object.entries(request.questions)) {
      const n = Number(qid.match(/item_(\d+)$/)[1]);
      answers[qid] = { type: 'noul', noul: (n * 10 + (qid.startsWith('q2_') ? 5 : 0)) / 100 };
    }
    return { model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, metadata: {}, answers };
  };
  const out = await realEvaluateItems({ entries, questions: qs }, { evaluateOne: echo, resultsDir: workdir() });
  assert.deepEqual(sent.questions.q2_item_3.instructions, { about: 'items.item_3', question: { ask: 'Is it B?' } });
  assert.deepEqual(sent.state.items.item_2, { text: 'x2' }, 'the id field is not sent');
  assert.deepEqual(out.results.map(r => [r.ids[0], r.answers.a.p, r.answers.b.p]), [['id1', 0.1, 0.15], ['id2', 0.2, 0.25], ['id3', 0.3, 0.35]]);
});

test('Breaker with batches: a rejected batch counts, so an outage costs exactly breakerAfter requests', async () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  let n = 0;
  await assert.rejects(realEvaluateItems({ entries, questions }, { evaluateOne: async () => { n++; throw new EvaluationError('HTTP 400. Request rejected.', { rejected: true }); } }), /Stopped: the first 5 requests all failed/);
  assert.equal(n, LIMITS.breakerAfter);
});

test('Errors that may have been processed (connection, rate limit) are not retried item by item', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  let n = 0;
  const flaky = async request => { n++; if (n === 2) throw new EvaluationError('Rate limit reached; retry later.'); return respond(request); };
  const out = await realEvaluateItems({ entries, questions }, { evaluateOne: flaky, resultsDir: workdir() });
  assert.equal(n, 2, 'two batches, no per-item resend');
  assert.equal(out.errors, 2); assert.equal(out.evaluated, 10);
});

// ---- Second pass on the queue (astra): failing reproductions turned into tests

test('A fractional remaining budget still sends: the timeout is whole milliseconds', async () => {
  const seen = [];
  await realEvaluateItems({ entries: [{ id: 1, item: 'a' }], questions }, { evaluateOne: async (r, o) => { seen.push(o.timeoutMs); return respond(r); }, started: 0, now: () => 5000.25, resultsDir: workdir() });
  assert.ok(Number.isInteger(seen[0]), String(seen[0]));
  const target = { provider: { label: 'Mock', id: 'mock' }, model: 'm' };
  const out = await realEvaluateItems({ entries: [{ id: 1, item: 'a' }], questions }, { evaluateOne: (r, o) => evaluate(r, { ...o, target, fetchImpl: async () => Response.json(respond(r)) }), started: 0, now: () => 5000.25, resultsDir: workdir() });
  assert.equal(out.evaluated, 1);
});

test('Singles split late run in parallel, not on one worker', async () => {
  let inFlight = 0, peak = 0;
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  const out = await realEvaluateItems({ entries, questions }, { resultsDir: workdir(), evaluateOne: async r => {
    if (r.state.items && r.state.items.item_1 !== 'line 0') throw new EvaluationError('HTTP 413. Too large.', { rejected: true });
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(res => setTimeout(res, 20));
    inFlight--;
    return respond(r);
  } });
  assert.equal(out.evaluated, 20);
  assert.ok(peak >= 10, `peak concurrency ${peak}`);
});

test('At the breaker, every requeued single is not evaluated, not failed', async () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, item: `line ${i}` }));
  await assert.rejects(realEvaluateItems({ entries, questions }, { evaluateOne: async () => { throw new EvaluationError('HTTP 413. Too large.', { rejected: true }); } }), /\(0 failed, 50 not evaluated\)/);
});

test("Noul bands follow TypeSafe's starting points: >= 0.7 yes, <= 0.3 no, between uncertain", async () => {
  const qs = { a: { type: 'noul', instructions: 'Is it A?' } };
  const values = { p72: 0.72, p70: 0.7, p69: 0.69, p31: 0.31, p30: 0.3, p28: 0.28 };
  const entries = Object.keys(values).map(k => ({ id: k, item: { id: k, k } }));
  const out = await evaluateItems({ entries, questions: qs }, { resultsDir: workdir(), evaluateOne: async r => ({ model: 'm', usage: {}, metadata: {}, answers: { a: { type: 'noul', noul: values[r.state.k] } } }) });
  assert.deepEqual(out.summary.a.counts, { yes: 2, uncertain: 2, no: 2 });
  assert.deepEqual(out.summary.a.uncertain_ids, ['p69', 'p31']);
});
