// Which provider, model, data policy and routing Evaluate uses. Stored in one file shared by every
// client and read on each call, so a change applies without restarting Claude Code or Codex.
//
//   node src/config.mjs                        show the current choice and the providers
//   node src/config.mjs <provider> [model]     choose (the model defaults to the provider's)
//   node src/config.mjs --zdr on|off           require zero data retention on every request
//   node src/config.mjs --order a,b            preferred upstream providers (gateways; still fail over)
//   node src/config.mjs --only a,b             allowed upstream providers (gateways; hard limit)
//   node src/config.mjs --routing none         clear order and only
//   node src/config.mjs --key NAME=/abs/cmd   get key NAME from `cmd NAME` (NAME=none to stop)
//   node src/config.mjs --summary              one line; exit 1 if the provider's key is missing
// Flags combine with each other and with <provider> [model].
//
// zdr is the user's policy: it survives a provider switch, and a provider that cannot enforce it
// refuses the call. model and routing belong to the provider they were set for: a switch drops them.
// DECISION_MODEL_PROVIDER / DECISION_MODEL in the server environment override the file (tests).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './providers.mjs';
import { EvaluationError, isKeyCommand, secretSource } from './secrets.mjs';

// What an empty config means: Jev through Vercel AI Gateway, zero data retention required.
export const DEFAULTS = { provider: 'vercel', zdr: true };

export const CONFIG_PATH = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'decision-model', 'config.json');

// The config is trusted only after this check: a hand edit with the wrong shape (zdr as "true", a key
// pasted where a key command belongs, a typo in a field name) must stop the call, not silently weaken
// it. Errors name the field, never its value, which could be a key.
const configSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  zdr: z.boolean().optional(),
  routing: z.object({ order: z.array(z.string().min(1)).optional(), only: z.array(z.string().min(1)).optional() }).strict().optional(),
  keys: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().refine(isKeyCommand)).optional(),
}).strict();

export function readConfig(file = CONFIG_PATH) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new EvaluationError(`Unreadable decision-model config ${file}: fix it or rerun \`node src/config.mjs <provider>\`.`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(i => i.path.join('.') || (i.keys ?? []).join(', ') || 'root'))].join(', ');
    throw new EvaluationError(`Invalid decision-model config ${file} (field: ${fields}). zdr must be true/false, keys must be absolute paths to executables, unknown fields are refused. Fix it or rewrite it with \`node src/config.mjs\`.`);
  }
  return parsed.data;
}

// targetFor: the provider row, the model to send, the policy, and the body fields that express it.
// Throws, with the fix, when the model is missing or the provider cannot enforce the policy.
export function targetFor(id, model, { zdr = false, routing = {}, keys = {} } = {}) {
  const row = PROVIDERS[id];
  if (!row) throw new EvaluationError(`Unknown decision-model provider "${id}". Available: ${Object.keys(PROVIDERS).join(', ')}.`);
  const chosen = model || row.defaultModel;
  if (!chosen) throw new EvaluationError(`Provider ${id} has no default model: run \`node src/config.mjs ${id} <model>\`.`);
  const provider = { id, ...row };
  const policy = { zdr: zdr === true, order: routing.order ?? [], only: routing.only ?? [] };
  return { provider, model: chosen, policy, extra: provider.options(policy), keyRef: row.keyName ? keys?.[row.keyName] : undefined };
}

export function resolveTarget({ env = process.env, file = CONFIG_PATH } = {}) {
  const cfg = readConfig(file);
  const configured = cfg.provider ?? DEFAULTS.provider;
  const id = env.DECISION_MODEL_PROVIDER || configured;
  // Model and routing were written for the configured provider; on any other they would be wrong.
  const own = configured === id;
  return targetFor(id, env.DECISION_MODEL || (own ? cfg.model : undefined), { zdr: cfg.zdr ?? DEFAULTS.zdr, routing: own ? cfg.routing : undefined, keys: cfg.keys });
}

// nextConfig(current, args): the config after a CLI command, validated before anything is written.
export function nextConfig(current, args) {
  const list = (v) => (v === 'none' ? [] : v.split(',').map(s => s.trim()).filter(Boolean));
  const positional = [], flags = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new EvaluationError(`${args[i]} needs a value.`);
    flags.push([args[i], args[++i]]);
  }
  const [id, model] = positional;
  // The switch comes first: it drops the old provider's model and routing, then this command's
  // flags apply to the new provider.
  // Defaults are written out, so an explicit `--zdr off` is kept and routing has a provider to belong to.
  const base = { ...DEFAULTS, ...current };
  const next = id && id !== base.provider ? { provider: id, zdr: base.zdr, ...(base.keys && { keys: base.keys }) } : base;
  if (model) next.model = model;
  for (const [flag, v] of flags) {
    if (flag === '--zdr') { if (!['on', 'off'].includes(v)) throw new EvaluationError('--zdr takes on or off.'); next.zdr = v === 'on'; }
    else if (flag === '--order') next.routing = { ...next.routing, order: list(v) };
    else if (flag === '--only') next.routing = { ...next.routing, only: list(v) };
    else if (flag === '--routing') { if (v !== 'none') throw new EvaluationError('--routing only takes none.'); delete next.routing; }
    else if (flag === '--key') {
      // Key commands are per key name, not per provider: they survive a provider switch.
      const [, name, command] = v.match(/^([A-Z][A-Z0-9_]*)=(.+)$/) ?? [];
      if (!name || (command !== 'none' && !isKeyCommand(command))) throw new EvaluationError('--key takes NAME=/absolute/path/to/executable or NAME=none.');
      const keys = { ...next.keys };
      if (command === 'none') delete keys[name]; else keys[name] = command;
      if (Object.keys(keys).length) next.keys = keys; else delete next.keys;
    }
    else throw new EvaluationError(`Unknown option ${flag}.`);
  }
  if (next.routing && !next.routing.order?.length && !next.routing.only?.length) delete next.routing;
  // Fails here, leaving the file untouched, if the result could not be used.
  targetFor(next.provider, next.model, { zdr: next.zdr, routing: next.routing });
  return next;
}

// Reports where the key would come from without reading it (no key command is run).
async function keyStatus(row, keys = readConfig().keys) {
  if (!row.keyName) return 'no key needed';
  const source = await secretSource(row.keyName, keys?.[row.keyName]);
  return source ? `${row.keyName} from ${source}` : `${row.keyName} missing`;
}

function describe({ provider, model, policy }) {
  const routing = [policy.order.length && `order ${policy.order.join(',')}`, policy.only.length && `only ${policy.only.join(',')}`].filter(Boolean).join(', ');
  return `${provider.label}, model ${model}, zdr ${policy.zdr ? 'on' : 'off'}${routing ? `, ${routing}` : ''}`;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    if (args[0] === '--summary') {
      const target = resolveTarget();
      const status = await keyStatus(target.provider);
      console.log(`decision model: ${describe(target)} (${status})`);
      if (status.endsWith('missing')) {
        const k = target.provider.keyName;
        console.log(`  add the key: python3 "${path.join(here, '..', 'setup-key.py')}" ${k}   (OS keychain), or configure a key command: see the decision-model README`);
        process.exitCode = 1;
      }
    } else if (args.length) {
      const next = nextConfig(readConfig(), args);
      mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
      const target = resolveTarget();
      console.log(`decision model: ${describe(target)} (${await keyStatus(target.provider)})`);
    } else {
      console.log(`current: ${describe(resolveTarget())}\n  [${CONFIG_PATH}]\n`);
      for (const [pid, row] of Object.entries(PROVIDERS)) {
        console.log(`${pid.padEnd(11)} ${row.label.padEnd(18)} default ${String(row.defaultModel ?? '(none: pass a model)').padEnd(22)} ${(await keyStatus(row)).padEnd(28)} ${row.verified ? '' : 'unverified'}`);
      }
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
