import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EvaluationError } from './secrets.mjs';
import { evaluate, inputSchema, title, toolDescription } from './systemone.mjs';
import { entriesFromArray, evaluateItems, loadItemsFile } from './items.mjs';
import { resolveTarget } from './config.mjs';
import { performance } from 'node:perf_hooks';

// The provider and model are resolved on every call (config.mjs), never chosen by the agent.
const configured = (input, options) => evaluate(input, { ...options, target: resolveTarget() });

export function createServer(evaluator = configured, { roots } = {}) {
  const server = new McpServer({ name: 'decision-model', version: '2.1.0' }, {
    instructions: 'Decision model: fast, cheap labels (yes probability, choice, score) over evidence you supply. Its main use: when a query, file or search returns more free-text items than you want to read through yourself (log and error messages, emails, tickets, comments, review findings, records), write them to a file in /tmp (or $TMPDIR) and call Evaluate with items_file (dedupe: "normalized" for log lines); you get per-label counts, the uncertain ids and a results file to filter with code, so you read only the shortlist. You decide when it pays. Not for code search hits, aggregated output, anything code can compute, or your own decisions: it sees only what you send, so it cannot weigh options you wrote. Load the decision-model skill first if available; the tool description has the operational guidance.',
  });
  server.registerTool('Evaluate', {
    title, description: toolDescription, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    const started = performance.now(); // the items budget runs from here: reading and grouping count
    try {
      let result;
      if (input.state !== undefined) result = await evaluator(input, { signal: extra.signal });
      else {
        const token = extra._meta?.progressToken;
        const onProgress = token === undefined ? undefined : (progress, total) =>
          extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total } }).catch(() => {});
        const entries = input.items_file !== undefined ? loadItemsFile(input.items_file, roots) : entriesFromArray(input.items);
        // One batch, one provider and data policy: the config is resolved once, not per item.
        const target = evaluator === configured ? resolveTarget() : undefined;
        const evaluateOne = target ? (request, options) => evaluate(request, { ...options, target }) : evaluator;
        result = await evaluateItems({ entries, questions: input.questions, context: input.context, dedupe: input.dedupe }, { evaluateOne, signal: extra.signal, onProgress, started });
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof EvaluationError ? e.message : 'Invalid evaluation request or internal failure. No result is available.' }] };
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
