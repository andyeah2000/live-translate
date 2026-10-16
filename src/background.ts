import { isTrustedSender } from './messages';
import type {
  Message,
  SessionSettings,
  SessionState,
  SubtitleMode,
  TranscriptEvent
} from './messages';
import { sanitizeSettings } from './settings';
import { validAudioSdp } from './local-audio-bridge';
import { MessageTimeoutError, withMessageTimeout } from './message-timeout';

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
let voiceChangeRevision = 0;

const OFFSCREEN_CLOSE_ATTEMPTS = 3;
/** A deliberate Stop lets the German voice finish its sentence and collects final usage. */
const GRACEFUL_DRAIN_MS = 15_000;
const RESTART_DRAIN_MS = 1_500;
const TELEMETRY_MIN_INTERVAL_MS = 250;
const OFFSCREEN_CLOSE_RETRY_MS = 50;
let lastFinalizationError: string | null = null;

void chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' }).catch(() => {});

let badgeRunning: boolean | null = null;
let lastTelemetry: SessionState['ducking'] = null;

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
  lastTelemetry = state.ducking;
  await chrome.storage.session.set({ sessionState: state });
  if (badgeRunning !== state.running) {
    badgeRunning = state.running;
    void chrome.action.setBadgeText({ text: state.running ? 'ON' : '' }).catch(() => {});
  }
  broadcast({ type: 'session-state', state });
}

function broadcast(msg: Message): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Kein Empfänger (z. B. Popup geschlossen) – ignorieren.
  });
}

function sendToTab(tabId: number, message: object): Promise<unknown> {
  // A busy or frozen page can retain a message port indefinitely. Subtitle
  // delivery and cleanup share the session queue, so neither may block Stop.
  return withMessageTimeout(
    chrome.tabs.sendMessage(tabId, message),
    1_000,
    'Der Video-Tab antwortet nicht.'
  );
}

/**
 * Sendet an das Offscreen-Dokument und wartet auf dessen Bestätigung.
 * Direkt nach createDocument() ist der Message-Listener dort unter Umständen
 * noch nicht registriert – deshalb mit Wiederholungen.
 */
async function sendToOffscreen(msg: Message): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = (await withMessageTimeout(
        chrome.runtime.sendMessage(msg),
        // A graceful stop drains up to drainMs; allow its final acknowledgement.
        msg.type === 'offscreen-stop' ? (msg.drainMs ?? GRACEFUL_DRAIN_MS) + 2_000 : 3_000,
        'Die Audioverarbeitung antwortet nicht.'
      )) as { ok?: boolean; finalizationError?: string | null } | undefined;
      if (response?.ok) {
        if (msg.type === 'offscreen-stop' && response.finalizationError) lastFinalizationError = response.finalizationError;
        return;
      }
    } catch (error) {
      // A recipient that keeps its response port open must not multiply the
      // full deadline by the retry count. Closing the document remains an
      // independent way to stop a damaged audio engine.
      if (error instanceof MessageTimeoutError) throw error;
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

async function stopAndCloseOffscreenDocument(drainMs: number): Promise<void> {
  if (!(await hasOffscreenDocument())) return;

  let lastError: unknown = null;
  try {
    // Zuerst Audio, Capture, Worker und WebRTC im lebenden Dokument stoppen.
    // closeDocument bleibt danach die zweite, unabhängige Sicherheitsgrenze.
    await sendToOffscreen({ type: 'offscreen-stop', drainMs });
  } catch (error) {
    // Ein beschädigtes Dokument kann nicht mehr antworten. Trotzdem aktiv
    // schließen; erfolgreich verifiziertes Schließen ist ebenfalls ein
    // vollständiger Stop.
    lastError = error;
    lastFinalizationError = 'Audioverarbeitung nicht erreichbar: unvollständige Finalisierung.';
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

async function getSubtitleOutput(): Promise<{ enabled: boolean; mode: SubtitleMode }> {
  const stored = await chrome.storage.session.get(['subtitlesEnabled', 'subtitleMode']);
  return {
    enabled: (stored.subtitlesEnabled as boolean | undefined) ?? true,
    mode: stored.subtitleMode === 'dual' ? 'dual' : 'translation'
  };
}

async function setSubtitleOutput(enabled: boolean, mode: SubtitleMode): Promise<void> {
  await chrome.storage.session.set({ subtitlesEnabled: enabled, subtitleMode: mode });
}

/** A frozen renderer can keep injection pending forever; it must not block Stop. */
function injectContentScript(tabId: number): Promise<unknown> {
  return withMessageTimeout(
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'], injectImmediately: true }),
    3_000,
    'Die Seite reagiert nicht auf die Untertitel-Einbindung.'
  );
}

async function startSession(
  tabId: number,
  settings: SessionSettings
): Promise<{ ok: true } | { ok: false; error: string }> {
  const previous = await getState();
  if (previous.running || (await hasOffscreenDocument())) {
    // A replacement (voice change, new tab) needs no long drain of the old voice.
    await stopSession(null, { drainMs: RESTART_DRAIN_MS, restart: true });
  }
  const epoch = ++sessionEpoch;
  const sessionId = crypto.randomUUID();
  resetSubtitleDelivery();
  try {
    await setState({
      running: false,
      tabId: null,
      sessionId: null,
      status: 'Starte…',
      error: null,
      ducking: null
    });
    await injectContentScript(tabId);
    const inputOffer = await withMessageTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'media-input-offer', sessionId }),
      6_000,
      'Der direkte Videoeingang antwortet nicht.'
    )
      .catch(() => null) as { sdp?: unknown } | null;
    if (!validAudioSdp(inputOffer?.sdp)) {
      // A timed-out offer may still finish inside the page. Cancel its scoped
      // capture before using tab audio so the abandoned peer cannot remain
      // alive for the entire fallback session or affect a later replacement.
      await withMessageTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'media-input-stop', sessionId }),
        1_000,
        'Der direkte Videoeingang konnte nicht zurückgesetzt werden.'
      ).catch(() => {});
    }
    await ensureOffscreenDocument();
    await setSubtitleOutput(settings.subtitles, settings.subtitleMode);
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
    await sendToOffscreen({ type: 'offscreen-start', sessionId, streamId, settings,
      inputOffer: validAudioSdp(inputOffer?.sdp) ? inputOffer.sdp : undefined });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Nur aufräumen, wenn nicht inzwischen bewusst gestoppt/neu gestartet wurde.
    if (epoch === sessionEpoch) {
      await sendToTab(tabId, { type: 'media-input-stop', sessionId }).catch(() => {});
      await stopSession(detail, { drainMs: RESTART_DRAIN_MS });
    }
    return { ok: false, error: detail };
  }
}

interface StopOptions {
  /** Longest wait for GPT-Live's session.closed (final usage). */
  drainMs?: number;
  /** Replaced by a new session at once: do not publish an intermediate stopped state. */
  restart?: boolean;
}

async function stopSession(error: string | null = null, options: StopOptions = {}): Promise<void> {
  sessionEpoch++;
  lastFinalizationError = null;
  const state = await getState();
  if (state.running && !options.restart) {
    // Show the drain immediately; the offscreen status is dropped while stopping.
    await setState({ ...state, status: 'Beende…' });
  }
  try {
    await stopAndCloseOffscreenDocument(options.drainMs ?? GRACEFUL_DRAIN_MS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[live-translate] Offscreen-Dokument konnte nicht sauber geschlossen werden:', err);
    // Ein nicht verifiziert beendetes Dokument darf niemals als gestoppte
    // Sitzung dargestellt werden. Der Nutzer kann Stop erneut auslösen.
    await setState({ ...state, status: 'Stop fehlgeschlagen', error: detail });
    throw err;
  }
  if (state.tabId !== null) {
    resetSubtitleDelivery();
    await sendToTab(state.tabId, { type: 'media-input-stop', sessionId: state.sessionId }).catch(() => {});
    await sendToTab(state.tabId, { type: 'subtitle-clear', sessionId: state.sessionId ?? undefined, final: true } satisfies Message)
      .catch(() => {});
  }
  if (options.restart) return;
  // An unconfirmed final usage after a deliberate Stop is a note, not a failure.
  const finalizationNote = lastFinalizationError && !/vor session\.started/.test(lastFinalizationError)
    ? 'Gestoppt · Abschluss von GPT-Live unbestätigt'
    : null;
  await setState({
    running: false,
    tabId: null,
    sessionId: null,
    status: error ? 'Fehler' : (finalizationNote ?? 'Gestoppt'),
    error,
    ducking: null
  });
}

// Subtitle delivery: at most one tabs.sendMessage in flight; everything that
// arrives meanwhile goes out as one ordered batch. The display lag therefore
// stays at a single round trip even when the page's main thread is busy.
let subtitleBatch: TranscriptEvent[] = [];
let subtitleTarget: { tabId: number; sessionId: string } | null = null;
let subtitleSending = false;
let subtitleGeneration = 0;

function resetSubtitleDelivery(): void {
  subtitleGeneration++;
  subtitleBatch = [];
  subtitleTarget = null;
  subtitleSending = false;
}

async function forwardTranscript(sessionId: string, event: TranscriptEvent): Promise<void> {
  const output = await getSubtitleOutput();
  if (!output.enabled) return;
  // Both transcript lanes arrive continuously; visibility can change live.
  if (event.lane === 'source' && output.mode !== 'dual') return;
  const state = await getState();
  if (!state.running || state.tabId === null || state.sessionId !== sessionId) return;
  if (subtitleTarget?.sessionId !== sessionId || subtitleTarget.tabId !== state.tabId) {
    resetSubtitleDelivery();
    subtitleTarget = { tabId: state.tabId, sessionId };
  }
  subtitleBatch.push(event);
  if (!subtitleSending) void flushSubtitles();
}

async function flushSubtitles(): Promise<void> {
  const generation = subtitleGeneration;
  subtitleSending = true;
  try {
    while (generation === subtitleGeneration && subtitleTarget && subtitleBatch.length > 0) {
      const { tabId, sessionId } = subtitleTarget;
      const events = subtitleBatch;
      subtitleBatch = [];
      await sendToTab(tabId, { type: 'subtitle-batch', sessionId, events } satisfies Message).catch(() => {});
    }
  } finally {
    if (generation === subtitleGeneration) subtitleSending = false;
  }
}

async function updateOutputSettings(
  msg: Extract<Message, { type: 'update-output-settings' }>
): Promise<void> {
  const previousOutput = await getSubtitleOutput();
  const nextMode: SubtitleMode = msg.settings.subtitleMode === 'dual' ? 'dual' : 'translation';
  await setSubtitleOutput(msg.settings.subtitles, nextMode);
  const observedState = await getState();
  if (
    !observedState.running ||
    observedState.tabId === null ||
    observedState.sessionId === null
  ) {
    return;
  }
  // Beim Abschalten und beim Moduswechsel sauber neu beginnen, damit keine
  // veraltete Original-Zeile aus dem vorherigen Modus stehen bleibt. Noch nicht
  // gesendete Untertitel verfallen; ein bereits gesendetes Bündel erreicht die
  // Seite über denselben Kanal vor dem Clear.
  if (!msg.settings.subtitles || previousOutput.mode !== nextMode) {
    resetSubtitleDelivery();
    await sendToTab(observedState.tabId, { type: 'subtitle-clear' } satisfies Message)
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

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // Steuer- und Statusnachrichten nur aus Extension-eigenen Kontexten
  // akzeptieren, niemals aus dem Renderer-Prozess einer Webseite.
  if (!isTrustedSender(sender)) return undefined;
  switch (msg.type) {
    case 'offscreen-input-answer':
      void getState().then(async state => {
        if (state.running && state.sessionId === msg.sessionId && state.tabId !== null && validAudioSdp(msg.sdp)) {
          try {
            const answer = await withMessageTimeout(
              chrome.tabs.sendMessage(state.tabId, { type: 'media-input-answer', sessionId: msg.sessionId, sdp: msg.sdp }),
              6_000,
              'Der direkte Videoeingang antwortet nicht.'
            ) as { ok?: boolean; error?: string } | undefined;
            if (!answer?.ok) throw new Error(answer?.error || 'Der direkte Videoeingang konnte nicht verbunden werden.');
          } catch (error) {
            await enqueueSessionOperation(async () => {
              const current = await getState();
              if (current.running && current.sessionId === msg.sessionId) {
                await stopSession(error instanceof Error ? error.message : String(error));
              }
            });
          }
        }
      }).catch(() => {});
      break;
    case 'start-session':
      voiceChangeRevision++;
      void enqueueSessionOperation(() =>
        startSession(msg.tabId, sanitizeSettings(msg.settings))
      ).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
      return true;
    case 'change-voice': {
      const revision = ++voiceChangeRevision;
      void enqueueSessionOperation(async () => {
        if (revision !== voiceChangeRevision) return { ok: true };
        const current = await getState();
        if (revision !== voiceChangeRevision) return { ok: true };
        if (!current.running || current.tabId === null) return { ok: true };
        return startSession(current.tabId, sanitizeSettings(msg.settings));
      }).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
      return true;
    }
    case 'stop-session':
      voiceChangeRevision++;
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
        .then(() => sendResponse({ ok: true }), (err) => {
          console.warn('[live-translate] Ausgabe-Einstellung fehlgeschlagen:', err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    case 'transcript':
      // Ordered but independent of the session queue: a Stop drain or a slow
      // status write must never hold back subtitles of the running session.
      transcriptQueue = transcriptQueue
        .catch(() => {})
        .then(() => forwardTranscript(msg.sessionId, msg.event))
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
      queueTelemetry(msg.sessionId, parseDuckingTelemetry(msg.telemetry));
      break;
    default:
      break;
  }
  return undefined;
});

// Telemetry (mix level, delay, usage) arrives several times per second. Write
// readiness changes at once and coalesce the rest, so storage writes and
// popup broadcasts stay bounded.
let pendingTelemetry: { sessionId: string; telemetry: SessionState['ducking'] } | null = null;
let telemetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastTelemetryWrite = 0;

function queueTelemetry(sessionId: string, telemetry: SessionState['ducking']): void {
  pendingTelemetry = { sessionId, telemetry };
  const current = lastTelemetry;
  const urgent = !current || current.ready !== telemetry?.ready ||
    current.translationReady !== telemetry?.translationReady || current.error !== telemetry?.error;
  const wait = urgent ? 0 : Math.max(0, TELEMETRY_MIN_INTERVAL_MS - (Date.now() - lastTelemetryWrite));
  if (telemetryTimer !== null) {
    if (!urgent) return;
    clearTimeout(telemetryTimer);
  }
  telemetryTimer = setTimeout(() => {
    telemetryTimer = null;
    const next = pendingTelemetry;
    pendingTelemetry = null;
    if (!next) return;
    lastTelemetryWrite = Date.now();
    void enqueueSessionOperation(async () => {
      const state = await getState();
      if (state.running && state.sessionId === next.sessionId) await setState({ ...state, ducking: next.telemetry });
    }).catch((err) => console.warn('[live-translate] Ducking-Status fehlgeschlagen:', err));
  }, wait);
}

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
    translationReady: candidate.translationReady === true,
    inputIndependent: candidate.inputIndependent === true,
    lagMs: typeof candidate.lagMs === 'number' && Number.isFinite(candidate.lagMs) && candidate.lagMs >= 0
      ? Math.min(candidate.lagMs, 600_000)
      : null,
    usageSeconds: typeof candidate.usageSeconds === 'number' && Number.isFinite(candidate.usageSeconds) && candidate.usageSeconds >= 0
      ? candidate.usageSeconds
      : 0,
    reconnects: typeof candidate.reconnects === 'number' && Number.isInteger(candidate.reconnects) && candidate.reconnects >= 0
      ? candidate.reconnects
      : 0
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
// Die Audio-Aufnahme läuft über die Navigation hinweg weiter; ein getrennter
// direkter Videoeingang fällt im Offscreen-Dokument auf Tab-Audio zurück.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void getState()
    .then(async (observedState) => {
      if (
        !observedState.running ||
        observedState.tabId !== tabId ||
        observedState.sessionId === null
      ) {
        return;
      }
      const observedSessionId = observedState.sessionId;
      // Injection runs outside the session queue: a hanging page must not
      // delay Stop. Only a failed injection enqueues the stop.
      try {
        await injectContentScript(tabId);
      } catch {
        await enqueueSessionOperation(async () => {
          const failedState = await getState();
          if (
            failedState.running &&
            failedState.tabId === tabId &&
            failedState.sessionId === observedSessionId
          ) {
            await stopSession('Die Seite hat gewechselt – bitte die Übersetzung neu starten.');
          }
        });
      }
    })
    .catch((err) => console.warn('[live-translate] Navigation konnte nicht verarbeitet werden:', err));
});
