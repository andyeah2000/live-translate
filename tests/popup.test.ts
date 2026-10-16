import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { Message, SessionState } from '../src/messages';
import type { initializePopup } from '../src/popup';

class ElementMock {
  value = '';
  textContent = '';
  title = '';
  disabled = false;
  checked = false;
  open = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: ElementMock[] = [];
  classes = new Set<string>();
  listeners = new Map<string, () => void>();
  classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  style = { setProperty: () => {} };
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(child: ElementMock) { this.children.push(child); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  dispatch(name: string) { this.listeners.get(name)?.(); }
}

function idleState(): SessionState {
  return { running: false, tabId: null, sessionId: null, status: 'Bereit', error: null, ducking: null };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Popup did not settle');
}

let popupModule: { initializePopup: typeof initializePopup } | undefined;
async function mount(options: {
  send?: (message: Message) => Promise<unknown>;
  permission?: boolean;
  alreadyGranted?: boolean;
  failStorage?: () => boolean;
  url?: string;
} = {}) {
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const elements = new Map<string, ElementMock>();
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new ElementMock());
    return elements.get(selector)!;
  };
  get('#toggle').disabled = true;
  const stored = { ...DEFAULT_SETTINGS, liveServerToken: 'test-token' };
  const messages: Message[] = [];
  const permissions: string[] = [];
  let listener: (message: Message, sender: chrome.runtime.MessageSender) => void = () => {};
  Object.assign(globalThis, {
    document: { querySelector: get, createElement: () => new ElementMock() },
    // Server health probe: never reach a real local server from unit tests.
    fetch: async () => new Response('{"ok":true}', { status: 200 }),
    chrome: {
      storage: { local: {
        get: async () => ({ ...stored }),
        set: async (settings: object) => {
          if (options.failStorage?.()) throw new Error('storage unavailable');
          Object.assign(stored, settings);
        },
        remove: async () => {}
      } },
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        onMessage: { addListener: (handler: typeof listener) => { listener = handler; } },
        sendMessage: async (message: Message) => {
          messages.push(message);
          if (options.send) return options.send(message);
          return message.type === 'get-state' ? idleState() : { ok: true };
        }
      },
      permissions: {
        contains: async () => options.alreadyGranted ?? false,
        request: async ({ origins }: { origins: string[] }) => {
          permissions.push(...origins);
          return options.permission ?? true;
        }
      },
      tabs: {
        query: async () => [{ id: 7, url: options.url ?? 'https://example.com/video' }],
        get: async (id: number) => ({ id, title: 'Keynote – Live', url: options.url ?? 'https://example.com/video' })
      },
      commands: { getAll: async () => [{ name: 'toggle-translation', shortcut: '⌥⇧T' }] }
    }
  });
  if (popupModule) popupModule.initializePopup();
  else popupModule = await import('../src/popup');
  return {
    get, stored, messages, permissions,
    ready: () => until(() => get('#toggle').listeners.has('click')),
    broadcast: (state: SessionState, trusted = true) => listener(
      { type: 'session-state', state },
      { url: trusted ? 'chrome-extension://test/background.js' : 'https://example.com/' }
    ),
    restore() {
      Object.assign(globalThis, { chrome: previousChrome, document: previousDocument, fetch: previousFetch });
    }
  };
}

test('popup renders healthy status and ignores foreign state messages', async () => {
  const popup = await mount();
  try {
    await popup.ready();
    assert.equal(popup.get('#status').textContent, 'Bereit');
    assert.equal(popup.get('#liveVoice').children.length, 13);
    popup.broadcast({ ...idleState(), error: 'foreign error' }, false);
    assert.equal(popup.get('#status').textContent, 'Bereit');
  } finally { popup.restore(); }
});

test('an initial get-state reply cannot overwrite a newer running broadcast', async () => {
  let resolve!: (state: SessionState) => void;
  const snapshot = new Promise<SessionState>(done => { resolve = done; });
  const popup = await mount({ send: async () => snapshot });
  try {
    await until(() => popup.messages.length > 0);
    popup.broadcast({ ...idleState(), running: true, status: 'Live verbunden' });
    resolve(idleState());
    await popup.ready();
    assert.equal(popup.get('#toggle').textContent, 'Stop');
    assert.equal(popup.get('#liveServerUrl').disabled, true);
    assert.equal(popup.get('#status').textContent, 'Live verbunden');
  } finally { popup.restore(); }
});

test('start validates before requesting permission and sends the canonical URL', async () => {
  const popup = await mount();
  try {
    await popup.ready();
    popup.get('#liveServerUrl').value = 'http://remote.example';
    popup.get('#toggle').dispatch('click');
    await until(() => !popup.get('#toggle').disabled);
    assert.match(popup.get('#status').textContent, /HTTPS/);
    assert.equal(popup.permissions.length, 0);
    assert.equal(popup.messages.some(message => message.type === 'start-session'), false);
    popup.broadcast(idleState());
    assert.match(popup.get('#status').textContent, /HTTPS/, 'background telemetry must not erase validation errors');

    popup.get('#liveServerUrl').value = ' https://backend.example/translate/// ';
    popup.get('#toggle').dispatch('click');
    await until(() => !popup.get('#toggle').disabled);
    assert.deepEqual(popup.permissions, ['https://backend.example/*']);
    const start = popup.messages.find(message => message.type === 'start-session');
    assert.equal(start?.settings.liveServerUrl, 'https://backend.example/translate');
    assert.equal(popup.get('#liveServerUrl').disabled, false);
  } finally { popup.restore(); }
});

test('permission denial and unsupported tabs leave Start available with an error', async () => {
  for (const options of [{ permission: false }, { url: 'chrome://extensions' }]) {
    const popup = await mount(options);
    try {
      await popup.ready();
      popup.get('#toggle').dispatch('click');
      await until(() => !popup.get('#toggle').disabled);
      assert.equal(popup.get('#status').classes.has('error'), true);
      assert.equal(popup.messages.some(message => message.type === 'start-session'), false);
    } finally { popup.restore(); }
  }
});

test('output edits preserve validated credentials while connection fields are invalid', async () => {
  const popup = await mount();
  try {
    await popup.ready();
    popup.get('#liveServerUrl').value = 'ftp://invalid.example';
    popup.get('#liveServerToken').value = 'unsaved-token';
    popup.get('#liveServerUrl').dispatch('change');
    popup.get('#translationVolume').value = '35';
    popup.get('#translationVolume').dispatch('input');
    await until(() => popup.stored.translationVolume === 0.35);
    assert.equal(popup.stored.liveServerUrl, DEFAULT_SETTINGS.liveServerUrl);
    assert.equal(popup.stored.liveServerToken, 'test-token');
    assert.equal(popup.get('#translationValue').textContent, '35 %');
    popup.get('#subtitles').checked = false;
    popup.get('#subtitles').dispatch('change');
    await until(() => popup.stored.subtitles === false);
    assert.equal(popup.get('#dualSubtitles').disabled, true);
    assert.ok(popup.messages.some(message => message.type === 'update-output-settings'));
  } finally { popup.restore(); }
});

test('clearing the saved backend token persists the removal', async () => {
  const popup = await mount();
  try {
    await popup.ready();
    popup.get('#liveServerToken').value = '';
    popup.get('#liveServerToken').dispatch('change');
    await until(() => popup.stored.liveServerToken === '');
    popup.get('#toggle').dispatch('click');
    await until(() => !popup.get('#toggle').disabled);
    assert.match(popup.get('#status').textContent, /Zugriffstoken/);
  } finally { popup.restore(); }
});

test('stop and voice failures are shown and leave controls usable', async () => {
  const popup = await mount({ send: async message => message.type === 'get-state'
    ? { ...idleState(), running: true }
    : { ok: false, error: 'Backend nicht erreichbar' } });
  try {
    await popup.ready();
    popup.get('#toggle').dispatch('click');
    await until(() => !popup.get('#toggle').disabled);
    assert.equal(popup.get('#status').textContent, 'Backend nicht erreichbar');
    popup.get('#liveVoice').value = 'stone';
    popup.get('#liveVoice').dispatch('change');
    await until(() => popup.messages.some(message => message.type === 'restart-session'));
    assert.equal(popup.get('#liveVoice').disabled, false);
  } finally { popup.restore(); }
});

test('successful start, voice change and stop refresh the visible session', async () => {
  let state = idleState();
  const popup = await mount({ alreadyGranted: true, send: async message => {
    if (message.type === 'get-state') return state;
    if (message.type === 'start-session') state = {
      ...idleState(), running: true, tabId: 7, sessionId: 'test-session', status: 'Live verbunden',
      ducking: { ready: true, speaking: false, sourceGain: 0.42, probability: 0, error: null, translationReady: true, lagMs: 2_400, usageSeconds: 75 }
    };
    if (message.type === 'restart-session') state = { ...state, status: 'Stimme aktualisiert' };
    if (message.type === 'stop-session') state = idleState();
    return { ok: true };
  } });
  try {
    await popup.ready();
    popup.get('#toggle').dispatch('click');
    popup.get('#toggle').dispatch('click');
    await until(() => !popup.get('#toggle').disabled);
    assert.equal(popup.messages.filter(message => message.type === 'start-session').length, 1);
    assert.equal(popup.get('#toggle').textContent, 'Stop');
    assert.equal(popup.get('#monitor').textContent, 'Original · 42%');
    await until(() => popup.get('#tabInfo').textContent === '▶ Keynote – Live');
    assert.equal(popup.get('#liveStats').textContent, 'Verzögerung 2,4 s · 1:15 min · ≈ 0,06 $');
    assert.equal(popup.get('#shortcut').textContent, '⌥⇧T startet und stoppt im aktuellen Tab');
    assert.deepEqual(popup.permissions, []);
    popup.get('#liveVoice').value = 'marin';
    popup.get('#liveVoice').dispatch('change');
    await until(() => popup.get('#status').textContent === 'Stimme aktualisiert');
    popup.get('#toggle').dispatch('click');
    await until(() => !popup.get('#toggle').disabled);
    assert.equal(popup.get('#toggle').textContent, 'Start');
    assert.equal(popup.get('#liveServerToken').disabled, false);
  } finally { popup.restore(); }
});

test('start failures and runtime exceptions are actionable without disabling retry', async () => {
  for (const result of [undefined, { ok: false, error: 'Keine Audiospur' }, new Error('Worker offline')]) {
    const popup = await mount({ send: async message => {
      if (message.type === 'get-state') return idleState();
      if (result instanceof Error) throw result;
      return result;
    } });
    try {
      await popup.ready();
      popup.get('#toggle').dispatch('click');
      await until(() => !popup.get('#toggle').disabled);
      assert.equal(popup.get('#status').classes.has('error'), true);
      assert.match(popup.get('#status').textContent, /Start fehlgeschlagen|Keine Audiospur|Worker offline/);
    } finally { popup.restore(); }
  }
});

test('storage and live output failures are visible', async () => {
  let failStorage = false;
  const popup = await mount({ failStorage: () => failStorage, send: async message => {
    if (message.type === 'get-state') return idleState();
    return { ok: false, error: 'Ausgabe getrennt' };
  } });
  try {
    await popup.ready();
    failStorage = true;
    popup.get('#liveServerToken').value = 'new-token';
    popup.get('#liveServerToken').dispatch('change');
    await until(() => popup.get('#status').textContent === 'Speichern fehlgeschlagen.');
    failStorage = false;
    popup.get('#translationVolume').value = '80';
    popup.get('#translationVolume').dispatch('input');
    await until(() => popup.get('#status').textContent === 'Ausgabe getrennt');
    await until(() => popup.stored.translationVolume === 0.8);
  } finally { popup.restore(); }
});

test('service worker startup failure is visible and a later broadcast recovers the UI', async () => {
  const popup = await mount({ send: async () => { throw new Error('offline'); } });
  try {
    await popup.ready();
    assert.equal(popup.get('#status').textContent, 'Erweiterungsdienst nicht erreichbar.');
    popup.broadcast(idleState());
    assert.equal(popup.get('#status').textContent, 'Bereit');
    assert.equal(popup.get('#status').classes.has('error'), false);
  } finally { popup.restore(); }
});

test('output controls are locked while a start or voice snapshot is being applied', async () => {
  for (const action of ['start-session', 'restart-session'] as const) {
    let finish!: (value: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
    const popup = await mount({ send: async message => {
      if (message.type === action) return pending;
      return message.type === 'get-state' ? idleState() : { ok: true };
    } });
    try {
      await popup.ready();
      if (action === 'start-session') popup.get('#toggle').dispatch('click');
      else popup.get('#liveVoice').dispatch('change');
      await until(() => popup.messages.some(message => message.type === action));
      assert.equal(popup.get('#translationVolume').disabled, true, 'volume cannot race the session settings snapshot');
      assert.equal(popup.get('#subtitles').disabled, true);
      assert.equal(popup.get('#dualSubtitles').disabled, true);
      popup.get('#translationVolume').dispatch('input');
      assert.equal(popup.messages.some(message => message.type === 'update-output-settings'), false);
      finish({ ok: true });
      await until(() => !popup.get('#translationVolume').disabled);
      assert.equal(popup.get('#subtitles').disabled, false);
      assert.equal(popup.get('#dualSubtitles').disabled, false);
    } finally { finish({ ok: true }); popup.restore(); }
  }
});

test('an active session can still be stopped during a pending voice change', async () => {
  let finish!: (value: { ok: boolean }) => void;
  const pending = new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
  let state = { ...idleState(), running: true, tabId: 7, sessionId: 'active' };
  const popup = await mount({ send: async message => {
    if (message.type === 'get-state') return state;
    if (message.type === 'restart-session') return pending;
    if (message.type === 'stop-session') state = { ...state, running: false };
    return { ok: true };
  } });
  try {
    await popup.ready();
    popup.get('#liveVoice').dispatch('change');
    await until(() => popup.messages.some(message => message.type === 'restart-session'));
    assert.equal(popup.get('#toggle').disabled, false, 'Stop remains available during voice negotiation');
    popup.get('#toggle').dispatch('click');
    await until(() => popup.messages.some(message => message.type === 'stop-session'));
    finish({ ok: true });
    await until(() => !popup.get('#toggle').disabled && !popup.get('#liveVoice').disabled);
    assert.equal(popup.get('#toggle').textContent, 'Start');
  } finally { finish({ ok: true }); popup.restore(); }
});
