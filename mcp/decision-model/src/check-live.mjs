// One real call (consumes provider credits).
//   node src/check-live.mjs                      the configured provider and model
//   node src/check-live.mjs <provider> [model]   a specific one, without changing the config
import { evaluate } from './systemone.mjs';
import { DEFAULTS, readConfig, resolveTarget, targetFor } from './config.mjs';

const [id, model] = process.argv.slice(2);
try {
  const cfg = readConfig();
  // A named provider still gets the configured data policy and key references.
  const target = id ? targetFor(id, model, { zdr: cfg.zdr ?? DEFAULTS.zdr, keys: cfg.keys }) : resolveTarget();
  const result = await evaluate({ state: 'The test suite completed: 12 tests passed, 0 failed.', questions: { passed: { type: 'noul', instructions: 'Does the text explicitly state that the test suite passed?' }, status: { type: 'choice', instructions: 'What test outcome is explicitly reported?', criteria: { passed: 'All tests passed', failed: 'Some tests failed', unknown: 'No outcome reported' } }, detail: { type: 'score', instructions: 'How much test outcome detail is present?', criteria: ['No result', 'Outcome only', 'Outcome and counts'] } } }, { target });
  console.log(JSON.stringify(result, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
