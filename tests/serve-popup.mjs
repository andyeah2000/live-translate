import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const mock = `<script>
globalThis.__messages = [];
globalThis.chrome = {
  storage: {
    local: {
      async get() { return { settingsVersion: 7, geminiKey: 'test-key', targetLanguage: 'de', subtitles: true, translationVolume: 1 }; },
      async set() {},
      async remove() {}
    }
  },
  runtime: {
    lastError: null,
    async sendMessage(message) {
      globalThis.__messages.push(message);
      if (message.type === 'get-state') return { running: false, tabId: null, sessionId: null, status: 'Bereit', error: null, ducking: null };
      return { ok: true };
    },
    onMessage: { addListener() {} }
  },
  tabs: { async query() { return [{ id: 1, url: 'https://example.com/video' }]; } },
  tabCapture: { getMediaStreamId(_options, callback) { callback('test-stream'); } }
};
</script>`;

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/favicon.ico') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.url === '/' || request.url === '/popup.html') {
      const html = await readFile(join(root, 'public/popup.html'), 'utf8');
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html.replace('<script src="popup.js"></script>', `${mock}<script src="/dist/popup.js"></script>`));
      return;
    }
    const path = join(root, request.url ?? '/');
    const types = { '.js': 'text/javascript', '.png': 'image/png' };
    response.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () =>
  console.log(`Popup QA server: http://127.0.0.1:${port}`)
);
