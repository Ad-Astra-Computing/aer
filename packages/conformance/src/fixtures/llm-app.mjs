// A customer agent: real SDKs, real calls, over loopback. Run under
// `node --import .../register.js`, which is the documented setup.
import http from 'node:http';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const provider = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (String(req.url).includes('messages')) {
    res.end(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'THE-REPLY-TEXT' }], stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 2 },
    }));
    return;
  }
  res.end(JSON.stringify({
    id: 'c', object: 'chat.completion', model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'THE-REPLY-TEXT' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  }));
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${provider.address().port}`;

await new OpenAI({ apiKey: process.env.FAKE_KEY, baseURL: `${base}/v1` })
  .chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'THE-PROMPT-TEXT' }] });

await new Anthropic({ apiKey: process.env.FAKE_KEY, baseURL: base })
  .messages.create({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'THE-PROMPT-TEXT' }] });

const { getActiveCollector } = await import('@adastracomputing/aer-auto-node');
const collector = getActiveCollector();
process.stdout.write(`ADAPTERS:${JSON.stringify([...collector.enabledAdapters])}\n`);
await collector.complete();
provider.close();
