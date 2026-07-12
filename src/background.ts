import type { Message, SessionSettings, SessionState } from './messages';
import { sanitizeSettings } from './settings';

const EMPTY_STATE: SessionState = {
  running: false,
  tabId: null,
  sessionId: null,
  status: 'Bereit',
  error: null,
  ducking: null
};

// Zählt Sitzungswechsel, damit ein fehlgeschlagener Start keine später
// gestartete/gestoppte Sitzung überschreibt (Stop während Start läuft).
let sessionEpoch = 0;
let sessionOperation: Promise<void> = Promise.resolve();
let transcriptQueue: Promise<void> = Promise.resolve();

const OFFSCREEN_CLOSE_ATTEMPTS = 3;
const OFFSCREEN_CLOSE_RETRY_MS = 50;

void chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' }).catch(() => {});

async function getState(): Promise<SessionState> {
  const { sessionState } = await chrome.storage.session.get('sessionState');
  if (!sessionState || typeof sessionState !== 'object') return EMPTY_STATE;
  const stored = sessionState as Partial<SessionState>;
  const validTabId = typeof stored.tabId === 'number' ? stored.tabId : null;
  const validSessionId = typeof stored.sessionId === 'string' ? stored.sessionId : null;
  const running = stored.running === true && validTabId !== null && validSessionId !== null;
  const ducking = parseDuckingTelemetry(stored.ducking);
  return {
    running,
    tabId: running ? validTabId : null,
    sessionId: running ? validSessionId : null,
    status: typeof stored.status === 'string' ? stored.status : EMPTY_STATE.status,
    error: typeof stored.error === 'string' ? stored.error : null,
    ducking: running ? ducking : null
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
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Tab-Audio aufnehmen und für die Live-Übersetzung verarbeiten'
  });
}

/**
 * `chrome.offscreen.hasDocument()` existiert erst ab Chrome 150. Die Extension
 * unterstützt bewusst Chrome 116+, wo `runtime.getContexts()` der offizielle
 * Weg ist. Auf neuen Browsern bleibt der direkte Fast-Path erhalten.
 */
async function hasOffscreenDocument(): Promise<boolean> {
  const hasDocument = chrome.offscreen.hasDocument as (() => Promise<boolean>) | undefined;
  if (typeof hasDocument === 'function') return hasDocument.call(chrome.offscreen);
  const contexts = await chrome.runtime.getContexts({
    // Als String senden: Das Schema kennt den Typ seit Chrome 116, das
    // `ContextType`-Enum muss dort aber nicht als Runtime-Objekt existieren.
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });
  return contexts.length > 0;
}

async function getTabCaptureStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) {
        reject(new Error(error?.message ?? 'Tab-Audio konnte nicht angefordert werden.'));
      } else {
        resolve(streamId);
      }
    });
  });
}

async function tabCaptureIsStillActive(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabCapture.getCapturedTabs((captures) => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.warn('[live-translate] Aktive Tab-Aufnahmen konnten nicht gelesen werden:', error);
        // Bei unklarem Status niemals eine womöglicherweise neue Sitzung
        // beenden. Ein echter Offscreen-Fehler meldet sich zusätzlich selbst.
        resolve(true);
        return;
      }
      resolve(
        captures.some(
          (capture) =>
            capture.tabId === tabId &&
            (capture.status === 'pending' || capture.status === 'active')
        )
      );
    });
  });
}

async function stopAndCloseOffscreenDocument(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;

  let lastError: unknown = null;
  try {
    // Zuerst Audio, Capture, Worker und WebSocket im lebenden Dokument stoppen.
    // closeDocument bleibt danach die zweite, unabhängige Sicherheitsgrenze.
    await sendToOffscreen({ type: 'offscreen-stop' });
  } catch (error) {
    // Ein beschädigtes Dokument kann nicht mehr antworten. Trotzdem aktiv
    // schließen; erfolgreich verifiziertes Schließen ist ebenfalls ein
    // vollständiger Stop.
    lastError = error;
  }

  for (let attempt = 0; attempt < OFFSCREEN_CLOSE_ATTEMPTS; attempt++) {
    if (!(await hasOffscreenDocument())) return;
    try {
      await chrome.offscreen.closeDocument();
    } catch (error) {
      lastError = error;
    }
    if (!(await hasOffscreenDocument())) return;
    if (attempt + 1 < OFFSCREEN_CLOSE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, OFFSCREEN_CLOSE_RETRY_MS));
    }
  }

  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Die Audioverarbeitung konnte nicht beendet werden${reason}`);
}

async function getSubtitlesEnabled(): Promise<boolean> {
  const { subtitlesEnabled } = await chrome.storage.session.get('subtitlesEnabled');
  return (subtitlesEnabled as boolean | undefined) ?? true;
}

async function startSession(
  tabId: number,
  settings: SessionSettings
): Promise<{ ok: true } | { ok: false; error: string }> {
  await stopSession();
  const epoch = sessionEpoch;
  const sessionId = crypto.randomUUID();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await ensureOffscreenDocument();
    await chrome.storage.session.set({ subtitlesEnabled: settings.subtitles });
    await setState({
      running: true,
      tabId,
      sessionId,
      status: 'Verbinde…',
      error: null,
      ducking: {
        ready: false,
        speaking: false,
        sourceGain: 1,
        probability: 0,
        error: null,
        translationReady: false
      }
    });
    // Die one-shot Capture-ID erst erzeugen, wenn das Offscreen-Dokument
    // existiert und alle anderen asynchronen Startschritte abgeschlossen sind.
    // Chrome 116+ garantiert genau den Service-Worker→Offscreen-Transfer.
    const streamId = await getTabCaptureStreamId(tabId);
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
    await stopAndCloseOffscreenDocument();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[live-translate] Offscreen-Dokument konnte nicht sauber geschlossen werden:', err);
    // Ein nicht verifiziert beendetes Dokument darf niemals als gestoppte
    // Sitzung dargestellt werden. Der Nutzer kann Stop erneut auslösen.
    await setState({ ...state, status: 'Stop fehlgeschlagen', error: detail });
    throw err;
  }
  if (state.tabId !== null) {
    await chrome.tabs
      .sendMessage(state.tabId, { type: 'subtitle-clear' } satisfies Message)
      .catch(() => {});
  }
  await setState({
    running: false,
    tabId: null,
    sessionId: null,
    status: error ? 'Fehler' : 'Gestoppt',
    error,
    ducking: null
  });
}

async function forwardTranscript(sessionId: string, text: string, final: boolean): Promise<void> {
  const observedState = await getState();
  if (
    !observedState.running ||
    observedState.tabId === null ||
    observedState.sessionId !== sessionId
  ) {
    return;
  }
  if (!(await getSubtitlesEnabled())) return;
  // Zwischen Zustandsprüfung und Versand kann eine Sitzung ersetzt worden
  // sein. Nur der weiterhin identische Tab und die identische Session dürfen
  // einen Untertitel erhalten.
  const currentState = await getState();
  if (
    !currentState.running ||
    currentState.tabId === null ||
    currentState.tabId !== observedState.tabId ||
    currentState.sessionId !== sessionId
  ) {
    return;
  }
  // Das Senden wird bewusst abgewartet. Dadurch kann die serialisierte
  // Stop-Operation `subtitle-clear` garantiert erst danach zustellen.
  await chrome.tabs
    .sendMessage(currentState.tabId, { type: 'subtitle', text, final } satisfies Message)
    .catch(() => {});
}

async function updateOutputSettings(
  msg: Extract<Message, { type: 'update-output-settings' }>
): Promise<void> {
  await chrome.storage.session.set({ subtitlesEnabled: msg.settings.subtitles });
  const observedState = await getState();
  if (
    !observedState.running ||
    observedState.tabId === null ||
    observedState.sessionId === null
  ) {
    return;
  }
  if (!msg.settings.subtitles) {
    await chrome.tabs
      .sendMessage(observedState.tabId, { type: 'subtitle-clear' } satisfies Message)
      .catch(() => {});
  }
  // Auch nach dem asynchronen Clear nur die weiterhin identische Sitzung
  // verändern. Das ist zusätzlich zur gemeinsamen Session-Queue eine harte
  // Grenze gegen verspätete Ereignisse oder extern veränderten Session-Storage.
  const currentState = await getState();
  if (
    !currentState.running ||
    currentState.tabId !== observedState.tabId ||
    currentState.sessionId !== observedState.sessionId
  ) {
    return;
  }
  await sendToOffscreen({
    type: 'offscreen-update-output',
    sessionId: observedState.sessionId,
    settings: msg.settings
  });
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'start-session':
      void enqueueSessionOperation(() =>
        startSession(msg.tabId, sanitizeSettings(msg.settings))
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
    case 'update-output-settings':
      void enqueueSessionOperation(() => updateOutputSettings(msg))
        .catch((err) => console.warn('[live-translate] Ausgabe-Einstellung fehlgeschlagen:', err));
      break;
    case 'transcript':
      transcriptQueue = transcriptQueue
        .catch(() => {})
        .then(() =>
          enqueueSessionOperation(() => forwardTranscript(msg.sessionId, msg.text, msg.final))
        )
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
    case 'ducking-telemetry':
      void enqueueSessionOperation(async () => {
        const state = await getState();
        if (state.running && state.sessionId === msg.sessionId) {
          await setState({ ...state, ducking: parseDuckingTelemetry(msg.telemetry) });
        }
      }).catch((err) => console.warn('[live-translate] Ducking-Status fehlgeschlagen:', err));
      break;
    default:
      break;
  }
  return undefined;
});

function parseDuckingTelemetry(value: unknown): SessionState['ducking'] {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  return {
    ready: candidate.ready === true,
    speaking: candidate.speaking === true,
    sourceGain:
      typeof candidate.sourceGain === 'number' && Number.isFinite(candidate.sourceGain)
        ? Math.min(1, Math.max(0, candidate.sourceGain))
        : 1,
    probability:
      typeof candidate.probability === 'number' && Number.isFinite(candidate.probability)
        ? Math.min(1, Math.max(0, candidate.probability))
        : 0,
    error: typeof candidate.error === 'string' ? candidate.error : null,
    translationReady: candidate.translationReady === true
  };
}

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
    .then((observedState) => {
      if (
        !observedState.running ||
        observedState.tabId !== tabId ||
        observedState.sessionId === null
      ) {
        return;
      }
      const observedSessionId = observedState.sessionId;
      void enqueueSessionOperation(async () => {
        const currentState = await getState();
        if (
          currentState.running &&
          currentState.tabId === tabId &&
          currentState.sessionId === observedSessionId
        ) {
          await stopSession();
        }
      }).catch(() => {});
    })
    .catch(() => {});
});

// Ein harter Offscreen-/Capture-Abbruch erreicht nicht zwingend noch den
// Message-Handler des Dokuments. Chrome stellt dieses Event genau für den
// UI-Abgleich bereit; Session-ID und Tab werden vor dem Stop erneut geprüft,
// damit ein verspätetes Event nie eine Ersatzsitzung beendet.
chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (info.status !== 'stopped' && info.status !== 'error') return;
  void getState()
    .then((observedState) => {
      if (
        !observedState.running ||
        observedState.tabId !== info.tabId ||
        observedState.sessionId === null
      ) {
        return;
      }
      const observedSessionId = observedState.sessionId;
      return enqueueSessionOperation(async () => {
        const currentState = await getState();
        if (
          currentState.running &&
          currentState.tabId === info.tabId &&
          currentState.sessionId === observedSessionId
        ) {
          // Ein stopped-Event der alten Capture kann nach einem Stop→Start im
          // selben Tab eintreffen. Die neue pending/active Capture ist die
          // belastbare Identitätsgrenze, die das Event selbst nicht mitliefert.
          if (await tabCaptureIsStillActive(info.tabId)) return;
          await stopSession('Die Tab-Audioaufnahme wurde unerwartet beendet.');
        }
      });
    })
    .catch((err) => console.warn('[live-translate] Capture-Status konnte nicht verarbeitet werden:', err));
});

// Nach einem Seiten-Reload ist das Untertitel-Overlay weg – neu injizieren.
// Die Audio-Aufnahme läuft über die Navigation hinweg weiter.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void getState()
    .then((observedState) => {
      if (
        !observedState.running ||
        observedState.tabId !== tabId ||
        observedState.sessionId === null
      ) {
        return;
      }
      const observedSessionId = observedState.sessionId;
      return enqueueSessionOperation(async () => {
        const currentState = await getState();
        if (
          !currentState.running ||
          currentState.tabId !== tabId ||
          currentState.sessionId !== observedSessionId
        ) {
          return;
        }
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        } catch {
          const failedState = await getState();
          if (
            failedState.running &&
            failedState.tabId === tabId &&
            failedState.sessionId === observedSessionId
          ) {
            await stopSession('Die Seite hat gewechselt – bitte die Übersetzung neu starten.');
          }
        }
      });
    })
    .catch((err) => console.warn('[live-translate] Navigation konnte nicht verarbeitet werden:', err));
});
