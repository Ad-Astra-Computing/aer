// A customer agent using the Vercel AI SDK, run under the documented setup.
import http from 'node:http';
import { generateText, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

const provider = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'THE-REPLY-TEXT' }], stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 4 },
  }));
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${provider.address().port}`;
const model = createAnthropic({ apiKey: process.env.FAKE_KEY, baseURL: base })('claude-sonnet-4-5');

await generateText({ model, prompt: 'THE-PROMPT-TEXT' });

const { getActiveCollector } = await import('@adastracomputing/aer-auto-node');
const collector = getActiveCollector();
process.stdout.write(`ADAPTERS:${JSON.stringify([...collector.enabledAdapters])}\n`);
await collector.complete();
provider.close();
