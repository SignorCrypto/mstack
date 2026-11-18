import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EvaluationError } from './secrets.mjs';
import { evaluate, inputSchema, title, toolDescription } from './systemone.mjs';
import { resolveTarget } from './config.mjs';

// The provider and model are resolved on every call (config.mjs), never chosen by the agent.
const configured = (input, options) => evaluate(input, { ...options, target: resolveTarget() });

export function createServer(evaluator = configured) {
  const server = new McpServer({ name: 'decision-model', version: '2.0.0' }, {
    instructions: 'Decision model: fast, cheap semantic judgments (yes/no probability, choice, score) over evidence you supply. Use Evaluate for first-pass classification, filtering and triage of collections; if the decision-model skill is available, load it before calling. The tool description contains the operational guidance.',
  });
  server.registerTool('Evaluate', {
    title, description: toolDescription, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    try {
      const result = await evaluator(input, { signal: extra.signal });
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
