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

let sessionGetGate:
  | { snapshot: unknown; started: boolean; release: Deferred<void> }
  | null = null;
let subtitleSendGate: Deferred<void> | null = null;
let clearSendGate: Deferred<void> | null = null;
let tabMessages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
let executeScriptCalls = 0;
let executeScriptFails = false;

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
    sendMessage: async () => undefined,
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
    hasDocument: async () => false,
    closeDocument: async () => undefined,
    createDocument: async () => undefined
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
  executeScriptCalls = 0;
  executeScriptFails = false;
}

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
