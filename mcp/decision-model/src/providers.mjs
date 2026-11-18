import { EvaluationError } from './secrets.mjs';

// Every provider speaks System One (see systemone.mjs), so a provider is data: where to send the
// request, which key authorises it, the model to use when none is configured, and how it expresses
// the user's data policy and routing in the request body.
// keyName null = no key (local server). defaultModel null = the user must pick one.
// verified: a real call has succeeded through this row; the others follow the providers' docs.
//
// options({ zdr, order, only }) returns the body fields to add, or throws when the provider cannot
// enforce what was asked: a ZDR request is never sent somewhere that cannot guarantee it.
const noRouting = (label) => ({ order, only }) => {
  if (order?.length || only?.length) throw new EvaluationError(`${label} has no routing: it is a single provider. Clear it with \`node src/config.mjs --routing none\`.`);
};

export const PROVIDERS = {
  typesafe: {
    label: 'TypeSafe', url: 'https://api.typesafe.ai/v1/systemone',
    keyName: 'TYPESAFE_API_KEY', defaultModel: 'jev-latest', verified: true,
    options(policy) {
      noRouting(this.label)(policy);
      if (policy.zdr) throw new EvaluationError('TypeSafe has no per-request zero data retention (only account-level, for enterprise). Use a gateway (vercel, openrouter) or `node src/config.mjs --zdr off`.');
      return {};
    },
  },
  vercel: {
    // AI Gateway's TypeSafe-compatible path; its native /v1/decisions uses another schema.
    label: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    keyName: 'AI_GATEWAY_API_KEY', defaultModel: 'typesafe-ai/jev', verified: true,
    options({ zdr, order, only }) {
      const gateway = { ...(zdr && { zeroDataRetention: true }), ...(order?.length && { order }), ...(only?.length && { only }) };
      return Object.keys(gateway).length ? { providerOptions: { gateway } } : {};
    },
  },
  openrouter: {
    // The Decisions API serves every OpenRouter decision model with System One field names.
    // If it changes, the compatible path is https://openrouter.ai/api/v1/systemone.
    label: 'OpenRouter', url: 'https://openrouter.ai/api/alpha/decisions',
    keyName: 'OPENROUTER_API_KEY', defaultModel: '~typesafe/jev-latest', verified: false,
    options({ zdr, order, only }) {
      const provider = { ...(zdr && { zdr: true }), ...(order?.length && { order }), ...(only?.length && { only }) };
      return Object.keys(provider).length ? { provider } : {};
    },
  },
  ollama: {
    // Local: nothing leaves the machine, so ZDR holds by construction, but only on a loopback URL.
    label: 'Ollama (local)', url: 'http://localhost:11434/v1/systemone',
    keyName: null, defaultModel: null, verified: false,
    options(policy) {
      noRouting(this.label)(policy);
      if (policy.zdr && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.url).hostname)) throw new EvaluationError(`${this.url} is not local: ZDR cannot be guaranteed.`);
      return {};
    },
  },
};
