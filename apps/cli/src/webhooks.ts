export interface WebhookCmdOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

export async function listWebhooks(opts: WebhookCmdOptions): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/webhooks`, {
    headers: authHeaders(opts.apiKey),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createWebhook(
  opts: WebhookCmdOptions & { url: string; description?: string; eventTypes?: string[] },
): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/webhooks`, {
    method: 'POST',
    headers: { ...authHeaders(opts.apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      url: opts.url,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.eventTypes ? { event_types: opts.eventTypes } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function rotateWebhookSecret(opts: WebhookCmdOptions & { webhookId: string }): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/webhooks/${opts.webhookId}/rotate-secret`, {
    method: 'POST',
    headers: authHeaders(opts.apiKey),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function testWebhook(opts: WebhookCmdOptions & { webhookId: string }): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/webhooks/${opts.webhookId}/test`, {
    method: 'POST',
    headers: authHeaders(opts.apiKey),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deleteWebhook(opts: WebhookCmdOptions & { webhookId: string }): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/webhooks/${opts.webhookId}`, {
    method: 'DELETE',
    headers: authHeaders(opts.apiKey),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

export async function listDeliveries(opts: WebhookCmdOptions & { webhookId: string; limit?: number }): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const q = opts.limit ? `?limit=${opts.limit}` : '';
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/webhooks/${opts.webhookId}/deliveries${q}`, {
    headers: authHeaders(opts.apiKey),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}
