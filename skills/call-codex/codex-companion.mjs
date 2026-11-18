#!/usr/bin/env node
// Local launcher; the official plugin remains untouched and resolves afresh per run.
// It owns how Codex is called (model, tier, effort, forbidden combinations), so the
// call-codex skill only says when to call it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function findPlugin(claudeHome) {
  const registry = path.join(claudeHome, 'plugins/installed_plugins.json');
  if (fs.existsSync(registry)) {
    const entries = JSON.parse(fs.readFileSync(registry, 'utf8')).plugins?.['codex@openai-codex'] ?? [];
    const installed = entries.find(entry => entry.scope === 'user');
    if (installed) return validatePlugin(installed.installPath);
  }
  const cache = path.join(claudeHome, 'plugins/cache/openai-codex/codex');
  const versions = fs.readdirSync(cache, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  if (!versions.length) throw new Error('Plugin codex@openai-codex non trovato.');
  return validatePlugin(path.join(cache, versions[0]));
}

function validatePlugin(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Percorso del plugin Codex non valido.');
  for (const file of ['scripts/codex-companion.mjs', 'scripts/lib/app-server.mjs']) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Plugin Codex incompleto: ${file}`);
  }
  return root;
}

// Codex catalog id of the "Fast" service tier (2x speed on sol, more usage).
export const FAST_TIER = 'priority';
const TIER_METHODS = new Set(['thread/start', 'thread/resume', 'turn/start']);

// Asks for the Fast tier on every thread and turn the plugin starts.
export function enableFastTier(Client) {
  return wrapRequests(Client, (method, params) =>
    TIER_METHODS.has(method) ? { ...params, serviceTier: FAST_TIER } : params);
}

// Review commands take no --effort: set it as a config override on the review thread,
// which the reviewer child thread inherits, instead of relying on config.toml.
// `config` is the launcher's own value: pass no effort and keep config.toml's.
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'config'];
export function enableReviewEffort(Client, effort) {
  return wrapRequests(Client, (method, params) => method === 'thread/start'
    ? { ...params, config: { ...params?.config, model_reasoning_effort: effort } } : params);
}

export function enablePersistentReviews(Client) {
  return wrapRequests(Client, (method, params) =>
    method === 'thread/start' ? { ...params, ephemeral: false } : params, (method, result) => {
    if (method === 'thread/start' && result?.thread?.ephemeral === true) {
      throw new Error('Codex ha creato una sessione temporanea: review interrotta prima di inviare il contenuto.');
    }
  });
}

// The plugin's shared broker is a detached process per workspace that only the SessionEnd hook of
// a Claude session in that same folder shuts down, so a call from any other folder (a worktree,
// the scratchpad, a skill dir) leaves it and its app-server running. Give each call its own
// app-server instead, a child that exits with the call; the plugin already falls back to this.
export function disableSharedBroker(Client) {
  const connect = Client.connect;
  Client.connect = function (cwd, options = {}) {
    return connect.call(this, cwd, { ...options, disableBroker: true });
  };
  return () => { Client.connect = connect; };
}

function wrapRequests(Client, transform, check = () => {}) {
  if (typeof Client?.connect !== 'function') {
    throw new Error('Plugin Codex non compatibile con il launcher: manca CodexAppServerClient.connect.');
  }
  const connect = Client.connect;
  const wrapped = new WeakSet();
  Client.connect = async function (...args) {
    const client = await connect.apply(this, args);
    if (wrapped.has(client)) return client;
    if (typeof client?.request !== 'function') {
      await client?.close?.();
      throw new Error('Plugin Codex non compatibile con il launcher: manca client.request.');
    }
    const request = client.request;
    client.request = async function (method, params) {
      const result = await request.call(this, method, transform(method, params));
      check(method, result);
      return result;
    };
    wrapped.add(client);
    return client;
  };
  return () => { Client.connect = connect; };
}

// The plugin's own option sets for the commands the launcher shapes (scripts/codex-companion.mjs,
// handleTask and handleReviewCommand), so its prompt and flags are read exactly as the plugin will.
const PLUGIN_OPTIONS = {
  task: {
    valueOptions: ['model', 'effort', 'cwd', 'prompt-file'],
    booleanOptions: ['json', 'write', 'resume-last', 'resume', 'fresh', 'background'],
    aliasMap: { m: 'model', C: 'cwd' },
  },
  review: {
    valueOptions: ['base', 'scope', 'model', 'cwd'],
    booleanOptions: ['json', 'background', 'wait'],
    aliasMap: { m: 'model', C: 'cwd' },
  },
};
PLUGIN_OPTIONS['adversarial-review'] = PLUGIN_OPTIONS.review;

// Removes a value option before a `--` in every form the plugin's parseArgs accepts
// (`--key v`, `--key=v`, `-key v`, with `key` the name or an alias) and returns the last value.
function takeValue(tokens, keys) {
  let value;
  const rest = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') {
      rest.push(...tokens.slice(i));
      break;
    }
    const long = token.startsWith('--');
    const [key, inline] = long ? token.slice(2).split('=', 2) : [token.slice(1)];
    if (!token.startsWith('-') || !keys.includes(key)) {
      rest.push(token);
    } else if (long && inline !== undefined) {
      value = inline;
    } else {
      if (tokens[i + 1] === undefined) throw new Error(`Manca il valore di ${token}.`);
      value = tokens[i + 1];
      i += 1;
    }
  }
  return { value, rest };
}

// Removes a launcher-only boolean flag before a `--` and says whether it was there.
// `--flag=value` would reach the plugin as prompt text, so it is refused.
function takeFlag(tokens, flag) {
  const end = tokens.includes('--') ? tokens.indexOf('--') : tokens.length;
  const head = tokens.slice(0, end);
  const withValue = head.find(token => token.startsWith(`${flag}=`));
  if (withValue) throw new Error(`${flag} non accetta un valore: usa ${flag} da solo (${withValue}).`);
  return { present: head.includes(flag), rest: [...head.filter(token => token !== flag), ...tokens.slice(end)] };
}

// Turns a launcher command line into the plugin's, applying the call-codex defaults:
// model sol (a family or an exact id, resolved live), Fast tier on sol unless --no-fast,
// effort high, and refusing what call-codex forbids. Pure apart from `resolveModel`.
// Commands other than task / review / adversarial-review pass through untouched.
export function planCall(argv, { resolveModel, parseArgs, splitRaw }) {
  let [command, ...tokens] = argv;
  const options = PLUGIN_OPTIONS[command];
  if (!options) return { command, argv: tokens, passthrough: true };
  // The plugin splits a lone argument as a raw command line: do the same before reading it.
  if (tokens.length === 1) tokens = splitRaw(tokens[0]);

  const dryRun = takeFlag(tokens, '--dry-run');
  const fastOn = takeFlag(dryRun.rest, '--fast');
  const fastOff = takeFlag(fastOn.rest, '--no-fast');
  const model = takeValue(fastOff.rest, ['model', 'm']);
  const effort = takeValue(model.rest, ['effort']);
  tokens = effort.rest;

  if (fastOn.present && fastOff.present) throw new Error('Usa --fast oppure --no-fast, non entrambi.');
  const effortLevel = effort.value ?? 'high';
  if (!EFFORTS.includes(effortLevel)) {
    throw new Error(`--effort non valido: usa uno tra ${EFFORTS.join(', ')}.`);
  }

  const { options: parsed, positionals } = parseArgs(tokens, options);
  if (parsed.background) {
    throw new Error('--background non è ammesso: lancia il comando con Bash run_in_background, come indica call-codex.');
  }
  // The plugin reads stdin when the joined positionals are empty (a lone ""); blank is no prompt either.
  if (command === 'task' && !parsed['prompt-file'] && !positionals.join(' ').trim()) {
    throw new Error('Il task richiede --prompt-file o un prompt, anche con --resume-last: il launcher non legge lo stdin.');
  }

  const modelId = resolveModel(model.value ?? 'sol');
  const family = modelId.match(/-([a-z]+)$/)?.[1] ?? '';
  if (command === 'task' && parsed.write && family === 'astra') {
    throw new Error(`${modelId} non implementa: --write è ammesso solo con sol.`);
  }
  const fast = fastOn.present || (!fastOff.present && family === 'sol');

  const end = tokens.includes('--') ? tokens.indexOf('--') : tokens.length;
  const added = ['--model', modelId];
  if (command === 'task' && effortLevel !== 'config') added.push('--effort', effortLevel);
  return {
    command,
    argv: [...tokens.slice(0, end), ...added, ...tokens.slice(end)],
    model: modelId,
    fast,
    effort: effortLevel,
    write: command === 'task' && Boolean(parsed.write),
    dryRun: dryRun.present,
  };
}

// Current id of a family, or an exact id validated, from the live Codex catalog.
export function resolveModel(name) {
  const models = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models.py');
  try {
    return execFileSync('python3', [models, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error(`modello "${name}" non risolto: ${String(error.stderr || error.message).trim()}`);
  }
}

export async function launch(argv = process.argv.slice(2)) {
  const configuredHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeHome = configuredHome.startsWith('~/')
    ? path.join(os.homedir(), configuredHome.slice(2)) : path.resolve(configuredHome);
  const root = findPlugin(claudeHome);
  const { CodexAppServerClient } = await import(pathToFileURL(path.join(root, 'scripts/lib/app-server.mjs')).href);
  if (argv[0] === '--launcher-check') {
    disableSharedBroker(CodexAppServerClient)();
    enableFastTier(CodexAppServerClient)();
    enablePersistentReviews(CodexAppServerClient)();
    console.log(JSON.stringify({ plugin: root, persistentReviews: true, fastTier: FAST_TIER, sharedBroker: false }));
    return;
  }
  const { parseArgs, splitRawArgumentString } = await import(pathToFileURL(path.join(root, 'scripts/lib/args.mjs')).href);
  const plan = planCall(argv, { resolveModel, parseArgs, splitRaw: splitRawArgumentString });
  if (plan.dryRun) {
    console.log(JSON.stringify(plan));
    return;
  }
  if (!plan.passthrough) {
    disableSharedBroker(CodexAppServerClient);
    if (plan.fast) enableFastTier(CodexAppServerClient);
    if (plan.command !== 'task') {
      enablePersistentReviews(CodexAppServerClient);
      if (plan.effort !== 'config') enableReviewEffort(CodexAppServerClient, plan.effort);
    }
    const where = plan.command === 'task' ? `sandbox=${plan.write ? 'workspace-write' : 'read-only'}` : plan.command;
    console.error(`codex launcher: ${plan.model}${plan.fast ? ' fast' : ''} effort=${plan.effort} ${where}`);
    // The plugin reads its command line from process.argv.
    process.argv.splice(2, Infinity, plan.command, ...plan.argv);
  }
  await import(pathToFileURL(path.join(root, 'scripts/codex-companion.mjs')).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launch().catch(error => {
    console.error(`Codex launcher: ${error.message}`);
    process.exitCode = 1;
  });
}
