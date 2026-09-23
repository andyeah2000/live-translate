import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLiveSessionConfig, parseSessionRequest } from './live-session.mjs';

const host = process.env.LIVE_TRANSLATE_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.LIVE_TRANSLATE_PORT || '8787', 10);
const apiKey = process.env.OPENAI_API_KEY || '';
const serverToken = process.env.LIVE_TRANSLATE_SERVER_TOKEN || '';
const configuredOrigin = (process.env.LIVE_TRANSLATE_ALLOWED_ORIGIN || '').replace(/\/$/, '');

function allowedOrigin(origin) {
  if (!origin) return false;
  return configuredOrigin ? origin === configuredOrigin : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function send(response, status, body, origin = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function tokenMatches(candidate) {
  if (!serverToken || typeof candidate !== 'string') return false;
  const expected = Buffer.from(serverToken);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid-json');
  }
}

const server = createServer(async (request, response) => {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
  if (request.method === 'OPTIONS' && request.url === '/api/live/session') {
    if (!allowedOrigin(origin)) return send(response, 403, { error: 'Unexpected request origin.' });
    response.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Live-Translate-Token',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    });
    response.end();
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/live/session') {
    return send(response, 404, { error: 'Not found.' }, allowedOrigin(origin) ? origin : null);
  }
  if (!allowedOrigin(origin)) return send(response, 403, { error: 'Unexpected request origin.' });
  if (!apiKey) return send(response, 503, { error: 'Set OPENAI_API_KEY on the GPT-Live server.' }, origin);
  if (!serverToken) return send(response, 503, { error: 'Set LIVE_TRANSLATE_SERVER_TOKEN on the GPT-Live server.' }, origin);
  if (!tokenMatches(request.headers['x-live-translate-token'])) {
    return send(response, 401, { error: 'Invalid GPT-Live server token.' }, origin);
  }

  let sessionRequest;
  try {
    sessionRequest = parseSessionRequest(await readJson(request));
  } catch {
    return send(response, 400, { error: 'Invalid session request.' }, origin);
  }
  if (!sessionRequest) return send(response, 400, { error: 'Invalid session request.' }, origin);

  let upstream;
  try {
    upstream = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createLiveSessionConfig(sessionRequest)),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    return send(response, 502, { error: 'OpenAI could not be reached.' }, origin);
  }
  if (!upstream.ok) {
    console.error(`[live-translate] OpenAI GPT-Live session failed (HTTP ${upstream.status}).`);
    const detail = upstream.status === 401
      ? 'OpenAI lehnt den API-Key ab (401). OPENAI_API_KEY in .env.local prüfen und Server neu starten. Der Server-Zugriffstoken ist gültig.'
      : upstream.status === 403
        ? 'OpenAI verweigert den Zugriff (403). Projektberechtigung für GPT-Live prüfen.'
        : upstream.status === 429
          ? 'OpenAI-Limit erreicht (429). API-Guthaben und Rate-Limit prüfen.'
          : `OpenAI hat die GPT-Live-Sitzung abgelehnt (HTTP ${upstream.status}).`;
    return send(response, 502, { error: detail }, origin);
  }
  let payload;
  try {
    payload = await upstream.text();
  } catch {
    return send(response, 502, { error: 'OpenAI-Sitzungsantwort wurde unterbrochen.' }, origin);
  }
  response.writeHead(201, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin'
  });
  response.end(payload);
});

server.listen(port, host, () => {
  console.log(`Live Translate GPT-Live server listening on http://${host}:${port}`);
});
