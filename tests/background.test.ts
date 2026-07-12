import assert from 'node:assert/strict';
import test from 'node:test';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const runningState = (tabId: number, sessionId: string, status = 'Läuft') => ({
  running: true,
  tabId,
  sessionId,
  status,
  error: null,
  ducking: null
});

const idleState = () => ({
  running: false,
  tabId: null,
  sessionId: null,
  status: 'Bereit',
  error: null,
  ducking: null
});

let sessionStore: Record<string, unknown> = {
  sessionState: runningState(1, 'session-a')
};
let runtimeListener!: (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | undefined;
let removedListener!: (tabId: number) => void;
let updatedListener!: (tabId: number, changeInfo: { status?: string }) => void;
let captureStatusListener!: (info: {
  tabId: number;
  status: string;
  fullscreen: boolean;
}) => void;

let sessionGetGate:
  | { snapshot: unknown; started: boolean; release: Deferred<void> }
  | null = null;
let subtitleSendGate: Deferred<void> | null = null;
let clearSendGate: Deferred<void> | null = null;
let tabMessages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
let runtimeMessages: Array<Record<string, unknown>> = [];
let lifecycleEvents: string[] = [];
let executeScriptCalls = 0;
let executeScriptFails = false;
let offscreenDocument = false;
let offscreenCloseAlwaysFails = false;
let offscreenCloseCalls = 0;
let captureStreamId = 'background-stream';
let capturedTabs: Array<{ tabId: number; status: string; fullscreen: boolean }> = [];

const chromeMock = {
  action: {
    setBadgeBackgroundColor: async () => undefined,
    setBadgeText: async () => undefined
  },
  storage: {
    session: {
      get: async (key: string) => {
        if (key === 'sessionState') {
          const gate = sessionGetGate;
          if (gate) {
            sessionGetGate = null;
            gate.started = true;
            await gate.release.promise;
            return { sessionState: gate.snapshot };
          }
        }
        return { [key]: sessionStore[key] };
      },
      set: async (values: Record<string, unknown>) => {
        Object.assign(sessionStore, values);
      }
    }
  },
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    getContexts: async () => (offscreenDocument ? [{}] : []),
    sendMessage: async (message: Record<string, unknown>) => {
      runtimeMessages.push(message);
      lifecycleEvents.push(`runtime:${String(message.type)}`);
      return typeof message.type === 'string' && message.type.startsWith('offscreen-')
        ? { ok: true }
        : undefined;
    },
    onMessage: {
      addListener: (listener: typeof runtimeListener) => {
        runtimeListener = listener;
      }
    },
    onStartup: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined }
  },
  offscreen: {
    Reason: { USER_MEDIA: 'USER_MEDIA' },
    hasDocument: async () => offscreenDocument,
    closeDocument: async () => {
      offscreenCloseCalls++;
      lifecycleEvents.push('offscreen:close');
      if (offscreenCloseAlwaysFails) throw new Error('mock close failed');
      offscreenDocument = false;
    },
    createDocument: async () => {
      lifecycleEvents.push('offscreen:create');
      offscreenDocument = true;
    }
  },
  tabCapture: {
    onStatusChanged: {
      addListener: (listener: typeof captureStatusListener) => {
        captureStatusListener = listener;
      }
    },
    getCapturedTabs: (
      callback: (captures: Array<{ tabId: number; status: string; fullscreen: boolean }>) => void
    ) => callback(capturedTabs),
    getMediaStreamId: (
      { targetTabId }: { targetTabId: number },
      callback: (streamId: string) => void
    ) => {
      lifecycleEvents.push(`capture:${targetTabId}`);
      callback(captureStreamId);
    }
  },
  scripting: {
    executeScript: async () => {
      executeScriptCalls++;
      if (executeScriptFails) throw new Error('injection failed');
      return [];
    }
  },
  tabs: {
    sendMessage: async (tabId: number, message: Record<string, unknown>) => {
      tabMessages.push({ tabId, message });
      if (message.type === 'subtitle' && subtitleSendGate) {
        const gate = subtitleSendGate;
        subtitleSendGate = null;
        await gate.promise;
      }
      if (message.type === 'subtitle-clear' && clearSendGate) {
        const gate = clearSendGate;
        clearSendGate = null;
        await gate.promise;
      }
      return undefined;
    },
    onRemoved: {
      addListener: (listener: typeof removedListener) => {
        removedListener = listener;
      }
    },
    onUpdated: {
      addListener: (listener: typeof updatedListener) => {
        updatedListener = listener;
      }
    }
  }
};

(globalThis as { chrome?: unknown }).chrome = chromeMock;
await import('../src/background');

function emit(message: Record<string, unknown>): void {
  runtimeListener(message, {}, () => undefined);
}

function request(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    runtimeListener(message, {}, resolve);
  });
}

async function waitFor(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Zeitüberschreitung: ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function sessionBarrier(sessionId: string, status: string): Promise<void> {
  emit({ type: 'offscreen-status', sessionId, status });
  await waitFor(
    () => (sessionStore.sessionState as { status?: string } | undefined)?.status === status,
    `Session-Barriere ${status}`
  );
}

function reset(state = runningState(1, 'session-a')): void {
  sessionStore = { sessionState: state };
  sessionGetGate = null;
  subtitleSendGate = null;
  clearSendGate = null;
  tabMessages = [];
  runtimeMessages = [];
  lifecycleEvents = [];
  executeScriptCalls = 0;
  executeScriptFails = false;
  offscreenDocument = false;
  offscreenCloseAlwaysFails = false;
  offscreenCloseCalls = 0;
  captureStreamId = 'background-stream';
  capturedTabs = [];
}

test('output controls update subtitles and forward live Gemini volume', async () => {
  reset();
  emit({
    type: 'update-output-settings',
    settings: { subtitles: false, translationVolume: 0.55 }
  });
  await waitFor(
    () => sessionStore.subtitlesEnabled === false,
    'Untertitel-Einstellung wurde nicht gespeichert'
  );
  await waitFor(
    () => runtimeMessages.some((message) => message.type === 'offscreen-update-output'),
    'Lautstärke wurde nicht zum Audiographen weitergeleitet'
  );

  assert.equal(
    tabMessages.some(({ message }) => message.type === 'subtitle-clear'),
    true
  );
  assert.deepEqual(
    runtimeMessages.find((message) => message.type === 'offscreen-update-output'),
    {
      type: 'offscreen-update-output',
      sessionId: 'session-a',
      settings: { subtitles: false, translationVolume: 0.55 }
    }
  );

  tabMessages = [];
  emit({ type: 'transcript', sessionId: 'session-a', text: 'unsichtbar', final: false });
  await sessionBarrier('session-a', 'barrier-subtitles-off');
  assert.equal(tabMessages.some(({ message }) => message.type === 'subtitle'), false);
});

test('tab capture ID is created in the background immediately before offscreen start', async () => {
  reset(idleState());
  const settings = {
    settingsVersion: 7,
    geminiKey: 'AIza-test',
    targetLanguage: 'de',
    subtitles: true,
    translationVolume: 1
  };

  assert.deepEqual(
    await request({ type: 'start-session', tabId: 12, settings }),
    { ok: true }
  );

  const startMessage = runtimeMessages.find((message) => message.type === 'offscreen-start');
  assert.equal(startMessage?.streamId, 'background-stream');
  assert.deepEqual(startMessage?.settings, settings);
  assert.deepEqual(
    lifecycleEvents.filter(
      (event) =>
        event === 'offscreen:create' || event.startsWith('capture:') || event === 'runtime:offscreen-start'
    ),
    ['offscreen:create', 'capture:12', 'runtime:offscreen-start']
  );
});

test('subtitle disable waits for an in-flight transcript before clearing', async () => {
  reset();
  const releaseSubtitle = deferred<void>();
  subtitleSendGate = releaseSubtitle;
  emit({ type: 'transcript', sessionId: 'session-a', text: 'noch sichtbar', final: false });
  await waitFor(
    () => tabMessages.some(({ message }) => message.type === 'subtitle'),
    'Untertitelversand startete nicht'
  );

  emit({
    type: 'update-output-settings',
    settings: { subtitles: false, translationVolume: 0.6 }
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    tabMessages.some(({ message }) => message.type === 'subtitle-clear'),
    false,
    'Disable darf einen bereits laufenden Untertitel nicht überholen'
  );

  releaseSubtitle.resolve(undefined);
  await waitFor(
    () => runtimeMessages.some((message) => message.type === 'offscreen-update-output'),
    'Output-Update wurde nicht serialisiert abgeschlossen'
  );
  assert.deepEqual(
    tabMessages.map(({ message }) => message.type),
    ['subtitle', 'subtitle-clear']
  );
});

test('output update rechecks session identity after asynchronous subtitle clear', async () => {
  reset();
  const releaseClear = deferred<void>();
  clearSendGate = releaseClear;
  emit({
    type: 'update-output-settings',
    settings: { subtitles: false, translationVolume: 0.4 }
  });
  await waitFor(
    () => tabMessages.some(({ message }) => message.type === 'subtitle-clear'),
    'Untertitel-Clear startete nicht'
  );

  sessionStore.sessionState = runningState(2, 'session-b');
  releaseClear.resolve(undefined);
  await sessionBarrier('session-b', 'barrier-output-recheck');

  assert.equal(
    runtimeMessages.some((message) => message.type === 'offscreen-update-output'),
    false
  );
});

test('stop confirms offscreen shutdown before closing and then clears state', async () => {
  reset();
  offscreenDocument = true;

  assert.deepEqual(await request({ type: 'stop-session' }), { ok: true });
  assert.equal(offscreenDocument, false);
  assert.equal((sessionStore.sessionState as { running: boolean }).running, false);
  assert.deepEqual(
    lifecycleEvents.filter(
      (event) => event === 'runtime:offscreen-stop' || event === 'offscreen:close'
    ),
    ['runtime:offscreen-stop', 'offscreen:close']
  );
});

test('Chrome 116 discovers the offscreen document through runtime.getContexts', async () => {
  reset();
  offscreenDocument = true;
  const offscreenApi = chromeMock.offscreen as typeof chromeMock.offscreen & {
    hasDocument?: () => Promise<boolean>;
  };
  const originalHasDocument = offscreenApi.hasDocument;
  offscreenApi.hasDocument = undefined;
  try {
    assert.deepEqual(await request({ type: 'stop-session' }), { ok: true });
    assert.equal(offscreenDocument, false);
    assert.equal(offscreenCloseCalls, 1);
  } finally {
    offscreenApi.hasDocument = originalHasDocument;
  }
});

test('verified stop failure preserves the running state and reports failure', async () => {
  reset();
  offscreenDocument = true;
  offscreenCloseAlwaysFails = true;

  const response = (await request({ type: 'stop-session' })) as {
    ok: boolean;
    error?: string;
  };
  assert.equal(response.ok, false);
  assert.match(response.error ?? '', /konnte nicht beendet werden/);
  assert.equal(offscreenCloseCalls, 3);
  assert.equal(offscreenDocument, true);
  assert.deepEqual(sessionStore.sessionState, {
    ...runningState(1, 'session-a'),
    status: 'Stop fehlgeschlagen',
    error: 'Die Audioverarbeitung konnte nicht beendet werden: mock close failed'
  });
});

test('forwardTranscript rechecks the session after an asynchronous state read', async () => {
  reset();
  const release = deferred<void>();
  const gate = {
    snapshot: runningState(1, 'session-a'),
    started: false,
    release
  };
  sessionGetGate = gate;

  emit({ type: 'transcript', sessionId: 'session-a', text: 'alt', final: false });
  await waitFor(() => gate.started, 'Sitzungszustand wurde nicht gelesen');
  sessionStore.sessionState = runningState(1, 'session-b');
  release.resolve(undefined);
  await sessionBarrier('session-b', 'barrier-forward');

  assert.equal(tabMessages.some(({ message }) => message.type === 'subtitle'), false);
});

test('subtitle delivery and stop clearing are strictly ordered', async () => {
  reset();
  const releaseSubtitle = deferred<void>();
  const releaseClear = deferred<void>();
  subtitleSendGate = releaseSubtitle;
  clearSendGate = releaseClear;

  emit({ type: 'transcript', sessionId: 'session-a', text: 'geordnet', final: false });
  await waitFor(
    () => tabMessages.some(({ message }) => message.type === 'subtitle'),
    'Untertitelversand startete nicht'
  );

  let stopSettled = false;
  const stopRequest = request({ type: 'stop-session' }).then((response) => {
    stopSettled = true;
    return response;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tabMessages.some(({ message }) => message.type === 'subtitle-clear'), false);

  releaseSubtitle.resolve(undefined);
  await waitFor(
    () => tabMessages.some(({ message }) => message.type === 'subtitle-clear'),
    'Untertitel-Clear startete nicht'
  );
  assert.equal(stopSettled, false, 'Stop darf vor abgeschlossenem subtitle-clear nicht antworten');
  releaseClear.resolve(undefined);
  assert.deepEqual(await stopRequest, { ok: true });
  assert.deepEqual(
    tabMessages.map(({ message }) => message.type),
    ['subtitle', 'subtitle-clear']
  );
});

test('a stale tab removal cannot stop a replacement session', async () => {
  reset();
  const releaseSubtitle = deferred<void>();
  subtitleSendGate = releaseSubtitle;
  emit({ type: 'transcript', sessionId: 'session-a', text: 'blocker', final: false });
  await waitFor(
    () => tabMessages.some(({ message }) => message.type === 'subtitle'),
    'Session-Queue wurde nicht blockiert'
  );

  const releaseObservedState = deferred<void>();
  const gate = {
    snapshot: runningState(1, 'session-a'),
    started: false,
    release: releaseObservedState
  };
  sessionGetGate = gate;
  removedListener(1);
  await waitFor(() => gate.started, 'Tab-Removal las keinen Zustand');
  releaseObservedState.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  sessionStore.sessionState = runningState(2, 'session-b');
  releaseSubtitle.resolve(undefined);
  await sessionBarrier('session-b', 'barrier-removed');

  assert.deepEqual(sessionStore.sessionState, runningState(2, 'session-b', 'barrier-removed'));
  assert.equal(tabMessages.some(({ message }) => message.type === 'subtitle-clear'), false);
});

test('a hard tab-capture failure clears the matching running session and badge state', async () => {
  reset();
  captureStatusListener({ tabId: 1, status: 'error', fullscreen: false });
  await waitFor(
    () => (sessionStore.sessionState as { running?: boolean }).running === false,
    'Capture-Fehler wurde nicht bereinigt'
  );
  assert.deepEqual(sessionStore.sessionState, {
    running: false,
    tabId: null,
    sessionId: null,
    status: 'Fehler',
    error: 'Die Tab-Audioaufnahme wurde unerwartet beendet.',
    ducking: null
  });
  assert.equal(
    tabMessages.some(({ message }) => message.type === 'subtitle-clear'),
    true
  );
});

test('a stale stopped event cannot kill a replacement capture in the same tab', async () => {
  reset(runningState(1, 'session-b'));
  capturedTabs = [{ tabId: 1, status: 'active', fullscreen: false }];
  captureStatusListener({ tabId: 1, status: 'stopped', fullscreen: false });
  await sessionBarrier('session-b', 'barrier-capture-replacement');
  assert.deepEqual(
    sessionStore.sessionState,
    runningState(1, 'session-b', 'barrier-capture-replacement')
  );
  assert.equal(
    tabMessages.some(({ message }) => message.type === 'subtitle-clear'),
    false
  );
});

test('a stale completed-navigation event cannot touch a replacement session', async () => {
  reset();
  const releaseSubtitle = deferred<void>();
  subtitleSendGate = releaseSubtitle;
  emit({ type: 'transcript', sessionId: 'session-a', text: 'blocker', final: false });
  await waitFor(
    () => tabMessages.some(({ message }) => message.type === 'subtitle'),
    'Session-Queue wurde nicht blockiert'
  );

  const releaseObservedState = deferred<void>();
  const gate = {
    snapshot: runningState(1, 'session-a'),
    started: false,
    release: releaseObservedState
  };
  sessionGetGate = gate;
  executeScriptFails = true;
  updatedListener(1, { status: 'complete' });
  await waitFor(() => gate.started, 'Navigation las keinen Zustand');
  releaseObservedState.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  sessionStore.sessionState = runningState(1, 'session-b');
  releaseSubtitle.resolve(undefined);
  await sessionBarrier('session-b', 'barrier-updated');

  assert.deepEqual(sessionStore.sessionState, runningState(1, 'session-b', 'barrier-updated'));
  assert.equal(executeScriptCalls, 0);
});
