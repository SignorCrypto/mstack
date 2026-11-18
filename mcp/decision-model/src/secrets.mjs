import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

// Service name in the OS secret store, shared by every provider; the account is the provider's key name.
export const KEYCHAIN_SERVICE = 'decision-model';

// fatal: the cause is not the evidence (key, config, account, credits, model), so every other request in
// the same call would fail the same way. rejected: the provider refused this request without processing
// it (400/413/422), so it is not billed and a smaller request may pass. Both are set where the cause is
// known, never inferred from the message.
export class EvaluationError extends Error {
  constructor(message, { fatal = false, rejected = false } = {}) { super(message); this.fatal = fatal; this.rejected = rejected; }
}

const run = promisify(execFile);

// The OS secret store: the macOS Keychain, or on Linux the Secret Service (GNOME Keyring, KWallet)
// through secret-tool. setup-key.py writes to the same place.
export function osStore(platform = process.platform) {
  if (platform === 'darwin') return { label: 'keychain', lookup: (name) => ['/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']] };
  if (platform === 'linux') return { label: 'secret service', lookup: (name) => ['secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', name]] };
  return null;
}

// A provider key comes from, in order:
//   1. the server environment (NAME);
//   2. a key command set in the config (`node src/config.mjs --key NAME=/abs/path/to/command`): an
//      executable run as `command NAME` that prints the key on stdout. It is how any secret manager
//      plugs in. Run on first use, kept in memory for the life of the server, rerun after a 401;
//   3. the OS secret store (macOS Keychain or Linux Secret Service; service decision-model, account NAME).
// A configured command that fails is an error, never a silent fall back to the secret store.
// Keys are never accepted as tool arguments and never echoed.
export async function getSecret(name, command) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  if (command) return runKeyCommand(name, command);
  const stored = await storedSecret(name);
  if (stored) return stored;
  throw new EvaluationError(`Missing ${name}. Run \`python3 setup-key.py ${name}\` in the decision-model folder (macOS Keychain or Linux Secret Service), configure a key command (\`node src/config.mjs --key ${name}=/abs/path/to/command\`), or set ${name} in the server environment. Never pass keys as tool arguments.`);
}

// Where a key would come from, without printing any secret: 'env' | 'command' | 'keychain' |
// 'secret service' | null. A key command is never run here.
export async function secretSource(name, command) {
  if (process.env[name]?.trim()) return 'env';
  if (command) return 'command';
  return await storedSecret(name) ? osStore().label : null;
}

async function storedSecret(name) {
  const store = osStore();
  if (!store) return null;
  try {
    const [bin, args] = store.lookup(name);
    const { stdout } = await run(bin, args, { timeout: 15000 });
    return stdout.trim() || null;
  } catch { return null; } // Absent, locked, or no store installed. Do not expose output or secrets.
}

// An absolute path to an executable: desktop clients start the server with a minimal PATH, and no
// shell is involved, so there is nothing to expand or split.
export function isKeyCommand(command) {
  if (!path.isAbsolute(command)) return false;
  try { accessSync(command, constants.X_OK); return true; } catch { return false; }
}

const cache = new Map();
function runKeyCommand(name, command) {
  const id = `${command}\0${name}`;
  if (!cache.has(id)) {
    const read = (async () => {
      try {
        // Up to a minute: the command may wait for an unlock or a confirmation.
        const { stdout } = await run(command, [name], { timeout: 60000 });
        if (stdout.trim()) return stdout.trim();
      } catch { /* Do not expose command output or secrets. */ }
      throw new EvaluationError(`The key command for ${name} (${command}) failed or printed nothing. Run \`"${command}" ${name} >/dev/null\` in a terminal to check it.`);
    })();
    cache.set(id, read);
    read.catch(() => cache.delete(id)); // a failed read is retried on the next call
  }
  return cache.get(id);
}

// The key and the cached read it came from (null when it is not from a key command), so a rejection
// can invalidate exactly that read. getSecret runs the command synchronously up to its first await, so
// the cache holds the entry it used.
export function secretRead(name, command) {
  const value = getSecret(name, command);
  const entry = command && !process.env[name]?.trim() ? cache.get(`${command}\0${name}`) ?? null : null;
  return { value, entry };
}

// After the provider rejects a key from a command (e.g. rotated), run the command again on next use.
// By identity: only the read the rejected request used is dropped, so any number of 401s on one
// rotation share one refresh, even when the refresh still returns the revoked key.
export const forgetSecret = (name, command, entry) => {
  const id = `${command}\0${name}`;
  if (!entry || cache.get(id) === entry) cache.delete(id);
};
