import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate as rawEvaluate, inputSchema, validateResponse } from '../src/systemone.mjs';
import { createServer } from '../src/server.mjs';
import { nextConfig, readConfig, resolveTarget, targetFor } from '../src/config.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { getSecret, osStore, secretSource } from '../src/secrets.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TYPESAFE = targetFor('typesafe');
const evaluate = (args, options = {}) => rawEvaluate(args, { target: TYPESAFE, ...options });
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const input = { state: { evidence: 'All tests passed.' }, questions: {
  ok: { type: 'noul', instructions: { question: 'Does evidence say tests passed?' }, criteria: { true: ['All passed'], false: 'Failure' } },
  category: { type: 'choice', instructions: 'Classify the result', criteria: { passed: { meaning: 'Success' }, unknown: null } },
  detail: { type: 'score', instructions: ['Rate specificity'], criteria: ['No evidence', { detail: 'Outcome only' }, ['Outcome and counts']] }
} };
const result = { model: 'jev-1.13.0', answers: {
  ok: { type: 'noul', noul: 0.95 },
  category: { type: 'choice', choice: 'passed', probabilities: { passed: 0.9, unknown: 0.1 }, confidence: 0.7 },
  detail: { type: 'score', score: 1.1, probabilities: { '0': 0, '1': 0.9, '2': 0.1 }, confidence: 0.7, legend: { '0': 'No evidence', '1': { detail: 'Outcome only' }, '2': ['Outcome and counts'] } }
}, usage: { input_tokens: 400, output_tokens: 60 } };

test('All primitives and structured criteria survive the API roundtrip', async () => {
  let sent;
  const output = await evaluate(input, { apiKey: 'secret-test-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer secret-test-key');
    assert.equal(options.redirect, 'error');
    sent = JSON.parse(options.body);
    return Response.json(result);
  } });
  assert.deepEqual(sent.questions, input.questions);
  assert.deepEqual(sent.state, input.state);
  assert.deepEqual(output.answers, result.answers);
  assert.deepEqual(output.usage, result.usage);
});

test('Rejects malformed requests and documented primitive limits', () => {
  for (const q of [
    { type: 'score', instructions: 'x', criteria: ['one'] },
    { type: 'score', instructions: 'x', criteria: Array(11).fill('level') },
    { type: 'choice', instructions: 'x', criteria: {} },
    { type: 'choice', instructions: 'x', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, null])) },
    { type: 'noul', instructions: 'x', criteria: { yes: 'wrong key' } }
  ]) assert.equal(inputSchema.safeParse({ state: 's', questions: { x: q } }).success, false);
  assert.equal(inputSchema.safeParse({ state: null, questions: {} }).success, false);
  assert.equal(inputSchema.safeParse({ ...input, api_key: 'secret' }).success, false);
});

test('Rejects degenerate Choice requests before any provider call', async () => {
  let calls = 0;
  for (const criteria of [{ options: ['ok', 'overstated', 'wrong', 'unverified'] }, { ok: 'Supported' }]) {
    const request = { state: 'Evidence', questions: { verdict: { type: 'choice', instructions: 'Classify evidence', criteria } } };
    await assert.rejects(evaluate(request, { apiKey: 'test', fetchImpl: async () => { calls++; return Response.json(result); } }), /Choice requires 2–255 distinct options/);
  }
  assert.equal(calls, 0);
  for (const count of [2, 255]) {
    assert.equal(inputSchema.safeParse({ state: 'Evidence', questions: { verdict: {
      type: 'choice', instructions: 'Classify evidence',
      criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [`option${i}`, null]))
    } } }).success, true);
  }
});

test('MCP rejects wrapped alternatives with actionable guidance before evaluation', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let calls = 0;
  const server = createServer(async () => { calls++; return result; });
  const client = new Client({ name: 'choice-regression', version: '1' });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const response = await client.callTool({ name: 'Evaluate', arguments: {
      state: 'Evidence', questions: { verdict: { type: 'choice', instructions: 'Classify evidence', criteria: { options: ['ok', 'unknown'] } } }
    } });
    assert.equal(response.isError, true);
    assert.match(response.content.map(c => c.text ?? '').join(''), /Choice requires 2–255 distinct options/);
    assert.equal(calls, 0);
  } finally { await client.close(); await server.close(); }
});

test('Retries overload/rate-limit only, honors Retry-After, preserves body', async () => {
  const delays = []; const bodies = [];
  const statuses = [429, 529, 200];
  const output = await evaluate(input, { apiKey: 'x', sleepImpl: async ms => delays.push(ms), fetchImpl: async (_, options) => {
    bodies.push(options.body);
    const status = statuses.shift();
    return status === 200 ? Response.json(result) : new Response('overloaded', { status, headers: { 'retry-after': '2' } });
  } });
  assert.deepEqual(delays, [2000, 2000]);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(output.metadata.attempts, 3);
});

test('Does not retry authentication errors or expose provider error bodies', async () => {
  let calls = 0;
  await assert.rejects(evaluate(input, { apiKey: 'secret', fetchImpl: async () => { calls++; return new Response('sensitive state secret', { status: 401 }); } }), e => /401/.test(e.message) && !/sensitive|secret/.test(e.message));
  assert.equal(calls, 1);
});

test('Uncertain network submission is not retried; errors do not leak keys', async () => {
  let calls = 0;
  await assert.rejects(evaluate(input, { apiKey: 'secret', fetchImpl: async () => { calls++; throw Error('secret'); } }), e => !e.message.includes('secret'));
  assert.equal(calls, 1);
});

test('Rejects missing answers, wrong option distributions, and out-of-range scores', () => {
  for (const change of [
    r => delete r.answers.ok,
    r => r.answers.ok.noul = 2,
    r => r.answers.category.choice = 'invented',
    r => r.answers.category.probabilities = { passed: 1 },
    r => r.answers.detail.score = 4
  ]) { const bad = structuredClone(result); change(bad); assert.throws(() => validateResponse(bad, input.questions)); }
});

test('Honors cancellation and refuses Retry-After beyond deadline', async () => {
  await assert.rejects(evaluate(input, { apiKey: 'x', signal: AbortSignal.abort(), fetchImpl: async (_, o) => { o.signal.throwIfAborted(); } }), /cancelled/);
  await assert.rejects(evaluate(input, { apiKey: 'x', timeoutMs: 100, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }) }), /deadline/);
});

test('MCP initialize, discovery, all-primitives call and validation with mocked provider', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer((args, options) => evaluate(args, { ...options, apiKey: 'test', fetchImpl: async () => Response.json(result) }));
  const client = new Client({ name: 'test', version: '1' });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name), ['Evaluate']);
    const response = await client.callTool({ name: 'Evaluate', arguments: input });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.structuredContent.answers, result.answers);
    const invalid = await client.callTool({ name: 'Evaluate', arguments: { state: 'x', questions: {} } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
});

test('Real stdio subprocess starts without credentials and exposes Evaluate', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'Evaluate');
    assert.equal(tools[0].inputSchema.type, 'object');
  } finally { await client.close(); }
});

test('The agent cannot pick the model per call', () => {
  assert.equal(inputSchema.safeParse({ ...input, model: 'liquid/d1' }).success, false);
});

test('Each provider row sends System One to its endpoint with its own key', async () => {
  for (const [id, row] of Object.entries(PROVIDERS)) {
    let seen;
    const target = targetFor(id, row.defaultModel ?? 'local-model');
    const output = await rawEvaluate(input, { target, apiKey: 'k', fetchImpl: async (url, options) => { seen = { url, options }; return Response.json({ ...result, model: 'served/' + id }); } });
    assert.equal(seen.url, row.url);
    assert.equal(seen.options.headers.Authorization, row.keyName ? 'Bearer k' : undefined, id);
    assert.equal(JSON.parse(seen.options.body).model, target.model);
    assert.deepEqual(output.metadata.provider, id);
    assert.equal(output.metadata.requested_model, target.model);
    assert.equal(output.model, 'served/' + id);
  }
});

test('Config: default, file, provider switch drops the old model, env override, errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dm-'));
  const file = path.join(dir, 'config.json');
  assert.equal(readConfig(file).provider, undefined);
  const empty = resolveTarget({ env: {}, file });
  assert.deepEqual([empty.provider.id, empty.model, empty.policy.zdr], ['vercel', 'typesafe-ai/jev', true]);
  assert.deepEqual(empty.extra, { providerOptions: { gateway: { zeroDataRetention: true } } });
  writeFileSync(file, JSON.stringify({ provider: 'vercel', model: 'liquid/d1' }));
  assert.equal(resolveTarget({ env: {}, file }).model, 'liquid/d1');
  assert.equal(resolveTarget({ env: { DECISION_MODEL_PROVIDER: 'openrouter' }, file }).model, '~typesafe/jev-latest');
  assert.equal(resolveTarget({ env: { DECISION_MODEL: 'x/y' }, file }).model, 'x/y');
  assert.throws(() => targetFor('ollama'), /no default model/);
  assert.throws(() => targetFor('nope'), /Unknown decision-model provider/);
  writeFileSync(file, '{broken');
  assert.throws(() => resolveTarget({ env: {}, file }), /Unreadable/);
});

test('Gateway language-model fallback (empty distribution) is rejected, naming the served model', () => {
  const fallback = structuredClone(result);
  fallback.model = 'openai/gpt-6-astra';
  fallback.answers.category = { type: 'choice', choice: 'passed', probabilities: {}, confidence: 0 };
  assert.throws(() => validateResponse(fallback, input.questions, 'Vercel AI Gateway'), /Vercel AI Gateway \(model openai\/gpt-6-astra\) returned an invalid probability distribution/);
});

test('Score legend is optional, but checked when present', () => {
  const noLegend = structuredClone(result); delete noLegend.answers.detail.legend;
  assert.doesNotThrow(() => validateResponse(noLegend, input.questions));
  const badLegend = structuredClone(result); badLegend.answers.detail.legend = { '0': 'x' };
  assert.throws(() => validateResponse(badLegend, input.questions));
});

test('ZDR and routing: each provider writes its own fields, omits them when off, refuses what it cannot enforce', () => {
  const on = { zdr: true, routing: { order: ['typesafe'], only: ['typesafe', 'liquid'] } };
  assert.deepEqual(targetFor('openrouter', null, on).extra, { provider: { zdr: true, order: ['typesafe'], only: ['typesafe', 'liquid'] } });
  assert.deepEqual(targetFor('vercel', null, on).extra, { providerOptions: { gateway: { zeroDataRetention: true, order: ['typesafe'], only: ['typesafe', 'liquid'] } } });
  for (const id of ['typesafe', 'vercel', 'openrouter']) assert.deepEqual(targetFor(id).extra, {}, `${id} sends nothing when off`);
  assert.deepEqual(targetFor('openrouter', null, { zdr: false, routing: { order: [] } }).extra, {});
  assert.throws(() => targetFor('typesafe', null, { zdr: true }), /no per-request zero data retention/);
  assert.throws(() => targetFor('typesafe', null, { routing: { only: ['x'] } }), /has no routing/);
  assert.deepEqual(targetFor('ollama', 'm', { zdr: true }).extra, {});
  assert.throws(() => targetFor('ollama', 'm', { routing: { order: ['x'] } }), /has no routing/);
});

test('The policy reaches the request body and the metadata, with the upstream that served', async () => {
  let body;
  const target = targetFor('openrouter', null, { zdr: true, routing: { only: ['typesafe'] } });
  const out = await rawEvaluate(input, { target, apiKey: 'k', fetchImpl: async (_, o) => { body = JSON.parse(o.body); return Response.json({ ...result, provider: 'TypeSafe' }); } });
  assert.deepEqual(body.provider, { zdr: true, only: ['typesafe'] });
  assert.equal(out.metadata.zdr_requested, true);
  assert.deepEqual(out.metadata.routing.only, ['typesafe']);
  assert.equal(out.metadata.served_by, 'TypeSafe');
});

test('Config commands: switch keeps zdr and drops model and routing; unusable results are refused', () => {
  let cfg = nextConfig({}, ['openrouter', 'liquid/d1', '--zdr', 'on', '--only', 'liquid']);
  assert.deepEqual(cfg, { provider: 'openrouter', model: 'liquid/d1', zdr: true, routing: { only: ['liquid'] } });
  cfg = nextConfig(cfg, ['vercel']);
  assert.deepEqual(cfg, { provider: 'vercel', zdr: true });
  assert.deepEqual(nextConfig(cfg, ['--zdr', 'off']), { provider: 'vercel', zdr: false });
  assert.deepEqual(nextConfig({ provider: 'vercel', routing: { order: ['a'] } }, ['--routing', 'none']), { provider: 'vercel', zdr: true });
  assert.throws(() => nextConfig(cfg, ['typesafe']), /no per-request zero data retention/);
  assert.deepEqual(nextConfig({}, ['typesafe', '--zdr', 'off']), { provider: 'typesafe', zdr: false });
  assert.deepEqual(nextConfig({}, ['--order', 'typesafe']), { provider: 'vercel', zdr: true, routing: { order: ['typesafe'] } });
  assert.throws(() => nextConfig({ provider: 'typesafe', zdr: false }, ['--order', 'x']), /has no routing/);
  assert.throws(() => nextConfig({}, ['--zdr', 'maybe']), /on or off/);
});

test('Env provider override ignores routing written for another provider but keeps zdr', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dm-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ provider: 'vercel', zdr: false }));
  assert.equal(resolveTarget({ env: {}, file }).policy.zdr, false, 'an explicit off beats the default');
  writeFileSync(file, JSON.stringify({ provider: 'openrouter', zdr: true, routing: { only: ['liquid'] } }));
  const t = resolveTarget({ env: { DECISION_MODEL_PROVIDER: 'vercel' }, file });
  assert.deepEqual(t.extra, { providerOptions: { gateway: { zeroDataRetention: true } } });
});

// A fake key command: prints a key per name (or the content of a file), logs calls, fails for BROKEN_KEY.
function keyCommand({ from } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'keycmd-'));
  const bin = path.join(dir, 'key'), log = path.join(dir, 'calls');
  writeFileSync(log, '');
  writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${log}"\n[ "$1" = "BROKEN_KEY" ] && exit 1\n${from ? `cat "${from}"` : `printf 'secret-for-%s' "$1"`}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length };
}

test('Key command: run once per key, cached, env wins, failures are errors not fallbacks', async () => {
  const cmd = keyCommand();
  try {
    assert.equal(await getSecret('DM_TEST_KEY', cmd.bin), 'secret-for-DM_TEST_KEY');
    assert.equal(await getSecret('DM_TEST_KEY', cmd.bin), 'secret-for-DM_TEST_KEY');
    assert.equal(cmd.calls(), 1, 'second read comes from memory');
    assert.equal(await secretSource('OTHER_KEY', cmd.bin), 'command');
    assert.equal(cmd.calls(), 1, 'status never runs the command');
    await assert.rejects(getSecret('BROKEN_KEY', cmd.bin), e => /key command for BROKEN_KEY/.test(e.message) && !/secret-for/.test(e.message));
    await assert.rejects(getSecret('BROKEN_KEY', cmd.bin));
    assert.equal(cmd.calls(), 3, 'a failed read is retried, not cached');
    process.env.DM_TEST_KEY = 'from-env';
    assert.equal(await getSecret('DM_TEST_KEY', cmd.bin), 'from-env');
  } finally { delete process.env.DM_TEST_KEY; }
});

test('A configured key command authorises the request', async () => {
  const cmd = keyCommand();
  let auth;
  const target = targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: cmd.bin } });
  await rawEvaluate(input, { target, fetchImpl: async (_, o) => { auth = o.headers.Authorization; return Response.json(result); } });
  assert.equal(auth, 'Bearer secret-for-AI_GATEWAY_API_KEY');
});

test('Config --key: set, survive a provider switch, remove, reject what is not an absolute executable', () => {
  const cmd = keyCommand();
  let cfg = nextConfig({}, ['--key', `AI_GATEWAY_API_KEY=${cmd.bin}`]);
  assert.deepEqual(cfg.keys, { AI_GATEWAY_API_KEY: cmd.bin });
  cfg = nextConfig(cfg, ['openrouter']);
  assert.deepEqual(cfg.keys, { AI_GATEWAY_API_KEY: cmd.bin });
  cfg = nextConfig(cfg, ['--key', 'AI_GATEWAY_API_KEY=none']);
  assert.equal(cfg.keys, undefined);
  for (const bad of ['AI_GATEWAY_API_KEY=sk-plaintext', 'AI_GATEWAY_API_KEY=relative/cmd', `AI_GATEWAY_API_KEY=${cmd.bin}.missing`, `lower=${cmd.bin}`])
    assert.throws(() => nextConfig({}, ['--key', bad]), /--key takes NAME=/);
});

test('Vercel reports the upstream inside provider_metadata; served_by names it', async () => {
  const target = targetFor('vercel', null, { zdr: true });
  const out = await rawEvaluate(input, { target, apiKey: 'k', fetchImpl: async () => Response.json({ ...result, provider_metadata: { gateway: { routing: { finalProvider: 'typesafe-ai', skippedProviderAttempts: [{ provider: 'digitalocean', reason: 'zdr_ineligible_model' }] } } } }) });
  assert.equal(out.metadata.served_by, 'typesafe-ai');
  assert.equal(out.provider_metadata.gateway.routing.skippedProviderAttempts[0].reason, 'zdr_ineligible_model');
});

test('A rotated key: a 401 reruns the key command once and retries; a second 401 is an error', async () => {
  const current = path.join(mkdtempSync(path.join(tmpdir(), 'rot-')), 'current');
  writeFileSync(current, 'old-key');
  const cmd = keyCommand({ from: current });
  const target = targetFor('vercel', null, { keys: { AI_GATEWAY_API_KEY: cmd.bin } });
  const valid = { key: 'old-key' };
  const fetchImpl = async (_, o) => o.headers.Authorization === `Bearer ${valid.key}` ? Response.json(result) : new Response('', { status: 401 });
  await rawEvaluate(input, { target, fetchImpl });            // runs the command, caches old-key
  writeFileSync(current, 'new-key'); valid.key = 'new-key';  // rotated in the secret manager, old one revoked
  const seen = [];
  const out = await rawEvaluate(input, { target, fetchImpl: async (u, o) => { seen.push(o.headers.Authorization); return fetchImpl(u, o); } });
  assert.deepEqual(seen, ['Bearer old-key', 'Bearer new-key']);
  assert.equal(out.metadata.attempts, 1);
  valid.key = 'revoked-everywhere';
  await assert.rejects(rawEvaluate(input, { target, fetchImpl }), /HTTP 401/);
});

test('Linux: the OS secret store is the Secret Service through secret-tool', async () => {
  assert.equal(osStore('linux').label, 'secret service');
  assert.deepEqual(osStore('linux').lookup('K'), ['secret-tool', ['lookup', 'service', 'decision-model', 'account', 'K']]);
  assert.equal(osStore('win32'), null);
  const dir = mkdtempSync(path.join(tmpdir(), 'st-'));
  writeFileSync(path.join(dir, 'secret-tool'), '#!/bin/sh\n[ "$1 $3 $5" = "lookup decision-model DM_LINUX_KEY" ] && printf stored-on-linux && exit 0\nexit 1\n');
  chmodSync(path.join(dir, 'secret-tool'), 0o755);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const PATH = process.env.PATH;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.PATH = `${dir}:${PATH}`;
  try {
    assert.equal(await getSecret('DM_LINUX_KEY'), 'stored-on-linux');
    assert.equal(await secretSource('DM_LINUX_KEY'), 'secret service');
    await assert.rejects(getSecret('DM_ABSENT_KEY'), /Missing DM_ABSENT_KEY/);
  } finally { Object.defineProperty(process, 'platform', platform); process.env.PATH = PATH; }
});

test('Config is validated on read: wrong shapes stop the call and never echo values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dm-'));
  const file = path.join(dir, 'config.json');
  for (const [bad, field] of [
    [{ provider: 'typesafe', zdr: 'true' }, 'zdr'],
    [{ keys: { AI_GATEWAY_API_KEY: 'vck_pasted_secret_value' } }, 'keys.AI_GATEWAY_API_KEY'],
    [{ provider: 'vercel', zrd: true }, 'zrd'],
    [{ routing: { only: 'liquid' } }, 'routing.only'],
  ]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => resolveTarget({ env: {}, file }), e => e.message.includes(`field: ${field}`) && !e.message.includes('vck_pasted'), JSON.stringify(bad));
  }
});
