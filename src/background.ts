import type { Message, SessionSettings, SessionState } from './messages';
import { sanitizeSettings } from './settings';

const EMPTY_STATE: SessionState = {
  running: false,
  tabId: null,
  sessionId: null,
  status: 'Bereit',
  error: null
};

// Zählt Sitzungswechsel, damit ein fehlgeschlagener Start keine später
// gestartete/gestoppte Sitzung überschreibt (Stop während Start läuft).
let sessionEpoch = 0;
let sessionOperation: Promise<void> = Promise.resolve();
let transcriptQueue: Promise<void> = Promise.resolve();
let audioSettingsQueue: Promise<void> = Promise.resolve();

void chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' }).catch(() => {});

async function getState(): Promise<SessionState> {
  const { sessionState } = await chrome.storage.session.get('sessionState');
  if (!sessionState || typeof sessionState !== 'object') return EMPTY_STATE;
  const stored = sessionState as Partial<SessionState>;
  const validTabId = typeof stored.tabId === 'number' ? stored.tabId : null;
  const validSessionId = typeof stored.sessionId === 'string' ? stored.sessionId : null;
  const running = stored.running === true && validTabId !== null && validSessionId !== null;
  return {
    running,
    tabId: running ? validTabId : null,
    sessionId: running ? validSessionId : null,
    status: typeof stored.status === 'string' ? stored.status : EMPTY_STATE.status,
    error: typeof stored.error === 'string' ? stored.error : null
  };
}

function enqueueSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionOperation.then(operation, operation);
  sessionOperation = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function setState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ sessionState: state });
  void chrome.action.setBadgeText({ text: state.running ? 'ON' : '' }).catch(() => {});
  broadcast({ type: 'session-state', state });
}

function broadcast(msg: Message): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Kein Empfänger (z. B. Popup geschlossen) – ignorieren.
  });
}

/**
 * Sendet an das Offscreen-Dokument und wartet auf dessen Bestätigung.
 * Direkt nach createDocument() ist der Message-Listener dort unter Umständen
 * noch nicht registriert – deshalb mit Wiederholungen.
 */
async function sendToOffscreen(msg: Message): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = (await chrome.runtime.sendMessage(msg)) as { ok?: boolean } | undefined;
      if (response?.ok) return;
    } catch {
      // Offscreen-Dokument (noch) nicht erreichbar.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Die Audioverarbeitung reagiert nicht. Bitte erneut starten.');
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Tab-Audio aufnehmen und für die Live-Übersetzung verarbeiten'
  });
}

async function getSubtitlesEnabled(): Promise<boolean> {
  const { subtitlesEnabled } = await chrome.storage.session.get('subtitlesEnabled');
  return (subtitlesEnabled as boolean | undefined) ?? true;
}

async function startSession(
  tabId: number,
  streamId: string,
  settings: SessionSettings
): Promise<{ ok: true } | { ok: false; error: string }> {
  await stopSession();
  const epoch = sessionEpoch;
  const sessionId = crypto.randomUUID();
  try {
    if (settings.subtitles) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    }
    await ensureOffscreenDocument();
    await chrome.storage.session.set({ subtitlesEnabled: settings.subtitles });
    await setState({ running: true, tabId, sessionId, status: 'Verbinde…', error: null });
    await sendToOffscreen({ type: 'offscreen-start', sessionId, streamId, settings });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Nur aufräumen, wenn nicht inzwischen bewusst gestoppt/neu gestartet wurde.
    if (epoch === sessionEpoch) await stopSession(detail);
    return { ok: false, error: detail };
  }
}

async function stopSession(error: string | null = null): Promise<void> {
  sessionEpoch++;
  const state = await getState();
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch (err) {
    console.warn('[live-translate] Offscreen-Dokument konnte nicht sauber geschlossen werden:', err);
  }
  if (state.tabId !== null) {
    void chrome.tabs
      .sendMessage(state.tabId, { type: 'subtitle-clear' } satisfies Message)
      .catch(() => {});
  }
  await setState({
    running: false,
    tabId: null,
    sessionId: null,
    status: error ? 'Fehler' : 'Gestoppt',
    error
  });
}

async function forwardTranscript(sessionId: string, text: string, final: boolean): Promise<void> {
  const state = await getState();
  if (!state.running || state.tabId === null || state.sessionId !== sessionId) return;
  if (!(await getSubtitlesEnabled())) return;
  void chrome.tabs
    .sendMessage(state.tabId, { type: 'subtitle', text, final } satisfies Message)
    .catch(() => {});
}

async function updateAudioSettings(msg: Extract<Message, { type: 'update-audio-settings' }>): Promise<void> {
  const state = await getState();
  const wasEnabled = await getSubtitlesEnabled();
  let subtitlesEnabled = msg.settings.subtitles;
  if (subtitlesEnabled && !wasEnabled && state.running && state.tabId !== null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ['content.js'] });
    } catch {
      subtitlesEnabled = false;
      const latestState = await getState();
      if (latestState.running && latestState.sessionId === state.sessionId) {
        await setState({
          ...latestState,
          status: 'Übersetzung läuft – Untertitel sind auf dieser Seite nicht verfügbar.'
        });
      }
    }
  }
  await chrome.storage.session.set({ subtitlesEnabled });
  const latestState = await getState();
  if (!subtitlesEnabled && latestState.running && latestState.tabId !== null) {
    void chrome.tabs
      .sendMessage(latestState.tabId, { type: 'subtitle-clear' } satisfies Message)
      .catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'start-session':
      void enqueueSessionOperation(() =>
        startSession(msg.tabId, msg.streamId, sanitizeSettings(msg.settings))
      ).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
      return true;
    case 'stop-session':
      void enqueueSessionOperation(() => stopSession()).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
      return true;
    case 'get-state':
      void getState().then(sendResponse, () => sendResponse(EMPTY_STATE));
      return true;
    case 'update-audio-settings':
      audioSettingsQueue = audioSettingsQueue
        .catch(() => {})
        .then(() => updateAudioSettings(msg))
        .catch((err) => console.warn('[live-translate] Audio-Einstellung fehlgeschlagen:', err));
      break;
    case 'transcript':
      transcriptQueue = transcriptQueue
        .catch(() => {})
        .then(() => forwardTranscript(msg.sessionId, msg.text, msg.final))
        .catch((err) => console.warn('[live-translate] Untertitel-Weiterleitung fehlgeschlagen:', err));
      break;
    case 'offscreen-status':
      void enqueueSessionOperation(async () => {
        const state = await getState();
        if (state.running && state.sessionId === msg.sessionId) {
          await setState({ ...state, status: msg.status });
        }
      }).catch((err) => console.warn('[live-translate] Status-Update fehlgeschlagen:', err));
      break;
    case 'offscreen-error':
      void enqueueSessionOperation(async () => {
        const state = await getState();
        if (state.running && state.sessionId === msg.sessionId) await stopSession(msg.detail);
      }).catch((err) => console.warn('[live-translate] Fehlerbehandlung fehlgeschlagen:', err));
      break;
    default:
      break;
  }
  return undefined;
});

// Nach Browser-Neustart oder Extension-Update: eventuell übrig gebliebene
// Offscreen-Dokumente schließen und den Zustand zurücksetzen.
chrome.runtime.onStartup.addListener(() => {
  void enqueueSessionOperation(() => stopSession()).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  void enqueueSessionOperation(() => stopSession()).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getState()
    .then((state) => {
      if (state.running && state.tabId === tabId) {
        void enqueueSessionOperation(() => stopSession()).catch(() => {});
      }
    })
    .catch(() => {});
});

// Nach einem Seiten-Reload ist das Untertitel-Overlay weg – neu injizieren.
// Die Audio-Aufnahme läuft über die Navigation hinweg weiter.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void getState()
    .then(async (state) => {
      if (!state.running || state.tabId !== tabId) return;
      if (!(await getSubtitlesEnabled())) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch {
        await enqueueSessionOperation(() =>
          stopSession('Die Seite hat gewechselt – bitte die Übersetzung neu starten.')
        );
      }
    })
    .catch((err) => console.warn('[live-translate] Navigation konnte nicht verarbeitet werden:', err));
});
