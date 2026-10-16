// Browser-only popup fixture. No credentials or external API requests are used.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const mock = `<script>
const listeners = [];
let settings = { settingsVersion: 11, liveServerUrl: 'http://127.0.0.1:8787', liveServerToken: 'test-token', liveVoice: 'meridian', subtitles: true, translationVolume: 1 };
let state = { running: false, tabId: null, sessionId: null, status: 'Bereit', error: null, ducking: null };
const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const broadcast = () => listeners.forEach(listener => listener({ type: 'session-state', state: { ...state } }, { id: extensionId, url: 'chrome-extension://' + extensionId + '/background.js' }));
globalThis.chrome = {
  storage: { local: {
    async get() { return { ...settings }; },
    async set(value) { settings = { ...settings, ...value }; },
    async remove(keys) { keys.forEach(key => delete settings[key]); }
  } },
  permissions: { async contains() { return true; }, async request() { return true; } },
  runtime: {
    id: extensionId,
    getURL(path) { return 'chrome-extension://' + extensionId + '/' + path; },
    lastError: null,
    async sendMessage(message) {
      if (message.type === 'get-state') return { ...state };
      if (message.type === 'start-session') {
        state = { ...state, running: true, tabId: 1, sessionId: 'fixture-session', status: 'Live-Übersetzung läuft', error: null };
        broadcast();
      }
      if (message.type === 'stop-session') {
        state = { running: false, tabId: null, sessionId: null, status: 'Gestoppt', error: null, ducking: null };
        broadcast();
      }
      return { ok: true };
    },
    onMessage: { addListener(listener) { listeners.push(listener); } }
  },
  tabs: { async query() { return [{ id: 1, url: 'https://example.com/video' }]; } }
};
</script>`;

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (path === '/' || path === '/popup.html') {
      const html = await readFile(new URL('../public/popup.html', import.meta.url), 'utf8');
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html.replace('<script src="popup.js"></script>', `${mock}<script src="/dist/popup.js"></script>`));
      return;
    }
    // Do not expose repository files or local credentials through the QA server.
    const assets = { '/popup.css': '../public/popup.css', '/dist/popup.js': '../dist/popup.js' };
    if (!Object.hasOwn(assets, path)) { response.writeHead(404); response.end('Not found'); return; }
    const types = { '.js': 'text/javascript', '.css': 'text/css' };
    response.setHeader('content-type', types[extname(path)]);
    response.end(await readFile(new URL(assets[path], import.meta.url)));
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log(`Popup QA server (simulated session): http://127.0.0.1:${port}`));
