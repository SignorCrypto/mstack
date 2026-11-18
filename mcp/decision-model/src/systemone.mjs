import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { EvaluationError, forgetSecret, secretRead } from './secrets.mjs';

export { EvaluationError };

// System One: the decision-model wire format (state + typed questions) shared by TypeSafe,
// Vercel AI Gateway, OpenRouter and others. One client; a provider is only an endpoint and a key.

// Keep structured instructions and criteria intact.
const description = z.union([z.string().min(1), z.record(z.string(), z.json()), z.array(z.json())]);
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: description, criteria: z.object({ true: description.optional(), false: description.optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: description, criteria: z.record(z.string().min(1), description.nullable()).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 255, 'Choice requires 2–255 distinct options as separate criteria keys, e.g. {"ok":"Supported","unknown":"Insufficient evidence"}; do not nest labels under an options key').describe('Map each alternative label to its description, e.g. {"ok":"Supported by evidence","unknown":"Insufficient evidence"}. Use 2–255 separate keys, not an array or {options: [...]}.') }).strict(),
  z.object({ type: z.literal('score'), instructions: description, criteria: z.array(description).min(2).max(10) }).strict(),
]);
// The wire request: what one provider call carries.
export const requestSchema = z.object({
  state: description.describe('Relevant text or structured JSON to evaluate. Sent to the configured provider. Include evidence explicitly; no filesystem or web access.'),
  questions: z.record(z.string().min(1), question).refine(v => Object.keys(v).length > 0, 'At least one question is required').describe('Independent atomic questions sharing the state, evaluated in one API request. Question IDs are not visible to the model: include the complete question in instructions.'),
}).strict();

// The tool input: one evidence (`state`), or many items asked the same questions (`items`, `items_file`).
export const inputSchema = z.object({
  state: description.optional().describe('One evidence for all questions: text or structured JSON, included explicitly. Use instead of items/items_file.'),
  items: z.array(z.json()).min(1).optional().describe('Many items, each asked the same questions: an array of texts or JSON values (an object\'s `id` field names it and is not sent).'),
  items_file: z.string().min(1).optional().describe('Absolute path to the items in a temp directory (/tmp, $TMPDIR, or one the user allowed): .jsonl/.ndjson (one JSON value per line), .json (an array), or any other text file (one item per line). Write or copy the items there with code; they never need to enter your context.'),
  context: description.optional().describe('Items mode only: background shared by every item (what the items are, where they come from). Sent with each item.'),
  dedupe: z.enum(['exact', 'normalized']).optional().describe('Items mode only. exact (default): identical items are evaluated once. normalized: items that differ only in timestamps, UUIDs, hex, prefixed-id suffixes and numbers (log lines) form one group; a standalone 0 and id prefixes are kept. The first one is sent as the example and the answer covers the group; results_file lists up to 3 variants. Use exact when a number (HTTP status, size vs limit) decides the answer.'),
  questions: requestSchema.shape.questions,
}).strict().superRefine((v, ctx) => {
  const sources = ['state', 'items', 'items_file'].filter(k => v[k] !== undefined);
  if (sources.length !== 1) ctx.addIssue({ code: 'custom', message: `Pass exactly one of state, items, items_file (got ${sources.length ? sources.join(' and ') : 'none'}).` });
  if (v.state !== undefined && (v.context !== undefined || v.dedupe !== undefined)) ctx.addIssue({ code: 'custom', message: 'context and dedupe are for items mode; with state, put the context in the state.' });
});

// High-precision credential shapes. Evidence carrying one is refused before anything is sent.
const CREDENTIALS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['API key', /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ['Stripe key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Vercel key', /\bvck_[A-Za-z0-9]{20,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
// Checked on the raw strings, keys included: a serialized form would escape a newline into `\n` and
// hide a token that starts a line from the word boundary.
// Iterative, so no input nesting can overflow the stack.
export const findCredential = value => {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') { for (const [kind, re] of CREDENTIALS) if (re.test(v)) return kind; }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stack.push(k, x);
  }
  return null;
};

// Waits for p, but no longer than signal allows (a key command may block on an unlock prompt).
// The lookup may reject after we stopped waiting: keep that rejection handled.
const until = (p, signal, message) => (p.catch(() => {}), new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new EvaluationError(message));
  const onAbort = () => reject(new EvaluationError(message));
  signal.addEventListener('abort', onAbort, { once: true });
  p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
}));

export const title = 'Evaluate with a decision model';
export const toolDescription = "Evaluate supplied text/JSON with a decision model (System One format; provider and model are configured by the user, the result names the model that answered).\nTwo modes. One evidence, several questions: pass `state`. Many items, the same questions asked of each: pass `items` (an array) or, better for anything you have not read, `items_file` (absolute path in a temp dir such as /tmp: .jsonl, .json array, or one item per line), plus an optional shared `context`. Items mode groups duplicates (`dedupe: \"normalized\"` also groups log lines that differ only in timestamps, ids and numbers, keeping a standalone 0; use exact when a number such as an HTTP status decides the answer), asks each distinct item the questions, about 10 items per request (at most 500 per call, about 50 s; items not reached come back as skipped; if none succeeds the call errors with the counts and the stop reason), and returns per-question counts, the ids of uncertain items, inline results when there are at most 20 distinct items, and `results_file`: JSONL with every item and its full answers, to filter with code. Item ids are an object's `id` field, else the line number (array position for .json).\nOne call supports mixed Noul (yes probability), Choice (2–255 distinct options), and Score (2–10 ordered rubric levels). Choice criteria must map each alternative label to its description, e.g. {\"ok\":\"Supported by evidence\",\"unknown\":\"Insufficient evidence\"}; never wrap alternatives in {\"options\":[...]}. Returns probabilities, confidence where provided, score legends, model version, and token usage. It neither retrieves missing information nor generates explanations; the model has no browser or filesystem access (only the server reads items_file).\nMake each question self-contained with explicit criteria; question IDs are invisible to the model. Prefer precise English where practical. Frame neutral questions with genuinely viable, distinct alternatives; a none-of-the-above option often works poorly, so when an item may fit no option ask a companion Noul (does it fit any?) and read the Choice only where it says yes. Phrase a Noul so that a high value means yes, one condition per Noul; TypeSafe suggests >= 0.7 yes, <= 0.3 no, the band between to a person. Separate observations from interpretations and supply the evidence that distinguishes alternatives. For reviews, provide relevant original source excerpts where possible; agreement with your summary is not independent verification.\nBatch independent questions and repeated semantic judgments. Questions do not see each other's answers; use subsequent calls when answers determine new evidence or options. Reuse results while evidence and criteria remain unchanged.\nTreat probabilities and confidence as model judgments, not proof or authorization; they cannot establish unstated user preferences. Noul probability is not a separate confidence score. Keep exact calculations, test execution, final actions, and verification in the host agent or code.\nState and questions are sent to the provider and consume API credits; respect permissions and data restrictions. Evidence that looks like a credential is refused before sending. Context budgets depend on the model and apply per item in items mode (Jev: 64k total tokens, 32k state plus longest question).";

const probability = z.number().min(0).max(1);
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }).passthrough(),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), probability), confidence: probability }).passthrough(),
  z.object({ type: z.literal('score'), score: z.number().finite(), legend: z.record(z.string(), z.json()).optional(), probabilities: z.record(z.string(), probability), confidence: probability }).passthrough(),
]);
const responseSchema = z.object({ model: z.string(), answers: z.record(z.string(), answer), usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).passthrough() }).passthrough();

// Strict on every field that carries a judgment. A gateway's language-model fallback answers with
// probabilities {} and confidence 0: that fails the distribution check, so it is never accepted.
export function validateResponse(data, questions, label = 'The provider') {
  const parsed = responseSchema.safeParse(data);
  if (!parsed.success) throw new EvaluationError(`${label} returned an invalid response. No evaluation was accepted.`);
  const result = parsed.data;
  label = `${label} (model ${result.model})`;
  if (Object.keys(result.answers).length !== Object.keys(questions).length) throw new EvaluationError(`${label} returned mismatched question IDs.`);
  for (const [id, q] of Object.entries(questions)) {
    const a = result.answers[id];
    if (!a || a.type !== q.type) throw new EvaluationError(`${label} returned a missing or mismatched answer.`);
    if (q.type === 'noul') continue;
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    if (Object.keys(a.probabilities).length !== keys.length || keys.some(k => !Object.hasOwn(a.probabilities, k)) || Math.abs(Object.values(a.probabilities).reduce((s, p) => s + p, 0) - 1) > 0.02) throw new EvaluationError(`${label} returned an invalid probability distribution.`);
    if (q.type === 'choice' && !keys.includes(a.choice)) throw new EvaluationError(`${label} returned an unknown choice.`);
    if (q.type === 'score' && (a.score < 0 || a.score > q.criteria.length - 1 || (a.legend && keys.some(k => !Object.hasOwn(a.legend, k))))) throw new EvaluationError(`${label} returned an invalid score or legend.`);
  }
  return result;
}

// target: { provider: a row of PROVIDERS, model } as resolved by config.mjs.
export async function evaluate(rawInput, { target, fetchImpl = fetch, apiKey, signal, timeoutMs = 45000, sleepImpl = sleep } = {}) {
  const input = requestSchema.parse(rawInput);
  const leaked = findCredential(input);
  if (leaked) throw new EvaluationError(`Evidence contains what looks like a credential (${leaked}): redact it and retry. Nothing was sent.`);
  const { provider, model, policy = { zdr: false, order: [], only: [] }, extra = {}, keyRef } = target;
  const name = provider.label;
  // extra: the provider's own fields for ZDR and routing (providers.mjs), absent when not asked for.
  const body = JSON.stringify({ ...input, model, ...extra });
  // Byte guard is not a tokenizer. The provider enforces the model's actual token budget.
  if (Buffer.byteLength(body) > 2_000_000) throw new EvaluationError('Request exceeds the local 2 MB limit. Reduce state or split questions; nothing was sent.');
  // The deadline covers the key lookup too, so a call never outlives timeoutMs.
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = Date.now();
  // Any failure to get the key would repeat on every request: fatal.
  let keyEntry = null;
  const readKey = () => {
    const { value, entry } = secretRead(provider.keyName, keyRef);
    keyEntry = entry;
    return until(value, combined, `Evaluation cancelled or timed out while reading ${provider.keyName}. Nothing was sent.`)
      .catch(e => { throw e instanceof EvaluationError ? new EvaluationError(e.message, { fatal: true }) : e; });
  };
  const key = provider.keyName ? apiKey ?? await readKey() : null;
  const headers = { 'Content-Type': 'application/json', ...(key && { 'Authorization': `Bearer ${key}` }) };
  let reread = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(provider.url, { method: 'POST', redirect: 'error', signal: combined, headers, body });
      if ([429, 529].includes(res.status) && attempt < 2) {
        const header = res.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const retryMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : header ? Math.max(0, Date.parse(header) - Date.now()) : NaN;
        const delay = Number.isFinite(retryMs) ? retryMs : 1000 * 2 ** attempt + Math.random() * 250;
        await res.body?.cancel().catch(() => {}); // cleanup must not hide the status
        if (Date.now() - started + delay >= timeoutMs) throw new EvaluationError(`${name} requested a retry beyond this call's deadline. Retry later.`);
        await sleepImpl(delay, undefined, { signal: combined });
        continue;
      }
      // A 401 on a key from a key command usually means it was rotated: drop the cached copy, run the
      // command again and retry once. Safe to repeat: a rejected request was not processed.
      if (res.status === 401 && keyRef && !apiKey && !reread) {
        await res.body?.cancel().catch(() => {}); // cleanup must not hide the status
        reread = true;
        forgetSecret(provider.keyName, keyRef, keyEntry);
        headers.Authorization = `Bearer ${await readKey()}`;
        attempt--;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {}); // cleanup must not hide the status
        const hints = { 400: `Request rejected; check that model "${model}" is a decision model on ${name} and the question structure.`, 401: 'Invalid or missing API key.', 402: 'Insufficient credits.', 403: policy.zdr ? 'Access denied; per-request ZDR may need a paid plan or credits on this provider.' : 'Account access denied.', 404: `Endpoint or model "${model}" not found on ${name}${policy.zdr || policy.only.length ? ', or no upstream matches the ZDR/routing policy' : ''}.`, 413: 'Request too large for the model.', 422: 'Provider rejected the request; check model context limits and question structure.', 429: 'Rate limit reached; retry later.', 529: 'Service overloaded; retry later.' };
        // Auth, credits, access and a missing model or route are the same for every item: fatal.
        throw new EvaluationError(`${name} HTTP ${res.status}. ${hints[res.status] ?? 'Evaluation failed.'}`, { fatal: [401, 402, 403, 404].includes(res.status), rejected: [400, 413, 422].includes(res.status) });
      }
      const result = validateResponse(await res.json(), input.questions, name);
      // zdr_requested is what was asked; served_by is the gateway's own report of the upstream that
      // answered (OpenRouter `provider`, Vercel `provider_metadata.gateway.routing.finalProvider`): the
      // evidence of how the request was routed. The full gateway report stays in the result.
      return { ...result, metadata: { provider: provider.id, requested_model: model, zdr_requested: policy.zdr, routing: { order: policy.order, only: policy.only }, served_by: result.provider ?? result.provider_metadata?.gateway?.routing?.finalProvider ?? null, elapsed_ms: Date.now() - started, attempts: attempt + 1 } };
    } catch (e) {
      if (e instanceof EvaluationError) throw e;
      if (combined.aborted) throw new EvaluationError('Evaluation cancelled or timed out. No result is available; an already submitted request may still be billed.');
      // Never echo provider error bodies, state, Authorization, or arbitrary transport errors.
      throw new EvaluationError(`${name} connection failed or returned invalid JSON. No automatic retry after an uncertain submission.`);
    }
  }
}
