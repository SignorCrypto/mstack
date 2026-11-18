import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { EvaluationError, forgetSecret, getSecret } from './secrets.mjs';

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
export const inputSchema = z.object({
  state: description.describe('Relevant text or structured JSON to evaluate. Sent to the configured provider. Include evidence explicitly; no filesystem or web access.'),
  questions: z.record(z.string().min(1), question).refine(v => Object.keys(v).length > 0, 'At least one question is required').describe('Independent atomic questions sharing the state, evaluated in one API request. Question IDs are not visible to the model: include the complete question in instructions.'),
}).strict();

export const title = 'Evaluate with a decision model';
export const toolDescription = "Evaluate supplied text/JSON with a decision model (System One format; provider and model are configured by the user, the result names the model that answered). One call supports mixed Noul (yes probability), Choice (2–255 distinct options), and Score (2–10 ordered rubric levels). Choice criteria must map each alternative label to its description, e.g. {\"ok\":\"Supported by evidence\",\"unknown\":\"Insufficient evidence\"}; never wrap alternatives in {\"options\":[...]}. Returns probabilities, confidence where provided, score legends, model version, and token usage. It neither retrieves missing information nor generates explanations; no browser or filesystem access.\nMake each question self-contained with explicit criteria; question IDs are invisible to the model. Prefer precise English where practical. Frame neutral questions with genuinely viable, distinct alternatives and an insufficient_evidence option when appropriate. Separate observations from interpretations and supply the evidence that distinguishes alternatives. For reviews, provide relevant original source excerpts where possible; agreement with your summary is not independent verification.\nBatch independent questions and repeated semantic judgments. Questions do not see each other's answers; use subsequent calls when answers determine new evidence or options. Reuse results while evidence and criteria remain unchanged.\nTreat probabilities and confidence as model judgments, not proof or authorization; they cannot establish unstated user preferences. Noul probability is not a separate confidence score. Keep exact calculations, test execution, final actions, and verification in the host agent or code.\nState and questions are sent to the provider and consume API credits; respect permissions and data restrictions. Context budgets depend on the model (Jev: 64k total tokens, 32k state plus longest question).";

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
  const input = inputSchema.parse(rawInput);
  const { provider, model, policy = { zdr: false, order: [], only: [] }, extra = {}, keyRef } = target;
  const name = provider.label;
  // extra: the provider's own fields for ZDR and routing (providers.mjs), absent when not asked for.
  const body = JSON.stringify({ ...input, model, ...extra });
  // Byte guard is not a tokenizer. The provider enforces the model's actual token budget.
  if (Buffer.byteLength(body) > 2_000_000) throw new EvaluationError('Request exceeds the local 2 MB limit. Reduce state or split questions; nothing was sent.');
  const key = provider.keyName ? apiKey ?? await getSecret(provider.keyName, keyRef) : null;
  const headers = { 'Content-Type': 'application/json', ...(key && { 'Authorization': `Bearer ${key}` }) };
  let reread = false;
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(provider.url, { method: 'POST', redirect: 'error', signal: combined, headers, body });
      if ([429, 529].includes(res.status) && attempt < 2) {
        const header = res.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const retryMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : header ? Math.max(0, Date.parse(header) - Date.now()) : NaN;
        const delay = Number.isFinite(retryMs) ? retryMs : 1000 * 2 ** attempt + Math.random() * 250;
        await res.body?.cancel();
        if (Date.now() - started + delay >= timeoutMs) throw new EvaluationError(`${name} requested a retry beyond this call's deadline. Retry later.`);
        await sleepImpl(delay, undefined, { signal: combined });
        continue;
      }
      // A 401 on a key from a key command usually means it was rotated: drop the cached copy, run the
      // command again and retry once. Safe to repeat: a rejected request was not processed.
      if (res.status === 401 && keyRef && !apiKey && !reread) {
        await res.body?.cancel();
        reread = true;
        forgetSecret(provider.keyName, keyRef);
        headers.Authorization = `Bearer ${await getSecret(provider.keyName, keyRef)}`;
        attempt--;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        const hints = { 400: `Request rejected; check that model "${model}" is a decision model on ${name} and the question structure.`, 401: 'Invalid or missing API key.', 402: 'Insufficient credits.', 403: policy.zdr ? 'Access denied; per-request ZDR may need a paid plan or credits on this provider.' : 'Account access denied.', 404: `Endpoint or model "${model}" not found on ${name}${policy.zdr || policy.only.length ? ', or no upstream matches the ZDR/routing policy' : ''}.`, 413: 'Request too large for the model.', 422: 'Provider rejected the request; check model context limits and question structure.', 429: 'Rate limit reached; retry later.', 529: 'Service overloaded; retry later.' };
        throw new EvaluationError(`${name} HTTP ${res.status}. ${hints[res.status] ?? 'Evaluation failed.'}`);
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
