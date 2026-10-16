import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createLiveSessionConfig, parseSessionRequest } from './live-session.mjs';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

function send(response, status, body, origin = null) {
  // Tell the extension whether an identical retry can succeed (transient upstream state).
  if (body.error && body.retryable === undefined) body.retryable = status >= 500 && status !== 503;
  if (response.destroyed || response.writableEnded) return;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function tokenMatches(expectedToken, candidate) {
  if (!expectedToken || typeof candidate !== 'string') return false;
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function readJson(request) {
  // An async iterator destroys IncomingMessage when exited early. Drain an
  // oversized body instead so the caller receives the actionable HTTP 413.
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          reject(new RangeError('body-too-large'));
        }
      } else if (!tooLarge) chunks.push(chunk);
    });
    request.once('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid-json')); }
    });
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('request-aborted')));
  });
}

async function readSessionResponse(upstream, dcid) {
  if (!upstream.body) throw new Error('missing-body');
  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!payload || typeof payload.session?.id !== 'string' || !payload.session.id.trim() ||
        payload.transport?.type !== 'webrtc' || typeof payload.transport.sdp !== 'string' ||
        !payload.transport.sdp.trim() || payload.transport.sdp.length > 65_536) {
      throw new Error('invalid-session-response');
    }
    const transport = { type: 'webrtc', sdp: payload.transport.sdp };
    // Echo the channel ID so the browser knows this server forwarded it.
    if (dcid !== undefined) transport.dcid = dcid;
    return { session: { id: payload.session.id }, transport };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Options allow real HTTP regression tests without credentials or paid sessions. */
export function createLiveServer({
  apiKey = process.env.OPENAI_API_KEY || '',
  serverToken = process.env.LIVE_TRANSLATE_SERVER_TOKEN || '',
  configuredOrigin = process.env.LIVE_TRANSLATE_ALLOWED_ORIGIN || '',
  fetchImpl = globalThis.fetch,
  upstreamTimeoutMs = 30_000
} = {}) {
  apiKey = apiKey.trim();
  serverToken = serverToken.trim();
  configuredOrigin = configuredOrigin.trim().replace(/\/$/, '');
  const allowedOrigin = origin => Boolean(origin) && (configuredOrigin
    ? origin === configuredOrigin : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (request.method === 'OPTIONS' && request.url === '/api/live/session') {
      if (!allowedOrigin(origin)) return send(response, 403, { error: 'Unexpected request origin.' });
      response.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Live-Translate-Token',
        'Access-Control-Max-Age': '600', Vary: 'Origin'
      });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api/live/session') {
      return send(response, 404, { error: 'Not found.' }, allowedOrigin(origin) ? origin : null);
    }
    if (!allowedOrigin(origin)) return send(response, 403, { error: 'Unexpected request origin.' });
    if (!serverToken) return send(response, 503, { error: 'Set LIVE_TRANSLATE_SERVER_TOKEN on the GPT-Live server.' }, origin);
    if (!tokenMatches(serverToken, request.headers['x-live-translate-token'])) {
      return send(response, 401, { error: 'Invalid GPT-Live server token.' }, origin);
    }
    if (!apiKey) return send(response, 503, { error: 'Set OPENAI_API_KEY on the GPT-Live server.' }, origin);

    let sessionRequest;
    try {
      sessionRequest = parseSessionRequest(await readJson(request));
    } catch (error) {
      return send(response, error instanceof RangeError ? 413 : 400, { error: 'Invalid session request.' }, origin);
    }
    if (!sessionRequest) return send(response, 400, { error: 'Invalid session request.' }, origin);
    if (response.destroyed) return;

    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    const timeout = setTimeout(cancel, upstreamTimeoutMs);
    timeout.unref();
    try {
      const upstream = await fetchImpl('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(createLiveSessionConfig(sessionRequest)),
        signal: controller.signal,
        redirect: 'error'
      });
      if (!upstream.ok) {
        // Cancel error bodies too: unconsumed responses hold upstream sockets.
        await upstream.body?.cancel().catch(() => {});
        const retryable = upstream.status >= 500 || upstream.status === 408;
        const detail = upstream.status === 401
          ? 'OpenAI lehnt den API-Key ab (401). OPENAI_API_KEY in .env.local prüfen und Server neu starten. Der Server-Zugriffstoken ist gültig.'
          : upstream.status === 403
            ? 'OpenAI verweigert den Zugriff (403). Projektberechtigung für GPT-Live prüfen.'
            : upstream.status === 429
              ? 'OpenAI-Limit erreicht (429). API-Guthaben und Rate-Limit prüfen.'
              : `OpenAI hat die GPT-Live-Sitzung abgelehnt (HTTP ${upstream.status}).`;
        return send(response, 502, { error: detail, retryable }, origin);
      }
      let payload;
      try { payload = await readSessionResponse(upstream, sessionRequest.dcid); }
      catch { return send(response, 502, { error: 'OpenAI lieferte keine vollständige GPT-Live-Sitzungsantwort.' }, origin); }
      send(response, 201, payload, origin);
    } catch {
      send(response, 502, { error: 'OpenAI could not be reached.' }, origin);
    } finally {
      clearTimeout(timeout);
      response.removeListener('close', cancel);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.LIVE_TRANSLATE_HOST || '127.0.0.1';
  const portText = process.env.LIVE_TRANSLATE_PORT || '8787';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('LIVE_TRANSLATE_PORT must be an integer from 1 to 65535.');
  }
  const server = createLiveServer();
  server.listen(port, host, () => {
    console.log(`Live Translate GPT-Live server listening on http://${host}:${port}`);
  });
}
