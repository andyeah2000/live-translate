import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { GptLiveTranslatorOptions } from '../src/offscreen/live';
import { LiveSession, SKIP_LAG_MS, TIGHTEN_LAG_MS, type LiveConnection, type LiveTelemetry } from '../src/offscreen/live-session';
import type { TranscriptEvent } from '../src/messages';

class Param {
  value = 1;
  events: string[] = [];
  cancelAndHoldAtTime() { this.events.push('hold'); }
  setValueAtTime(value: number) { this.value = value; this.events.push('set'); }
  linearRampToValueAtTime(value: number) { this.value = value; this.events.push(`ramp:${value}`); }
}

class Gain {
  gain = new Param();
  connected = true;
  connect() { return this; }
  disconnect() { this.connected = false; }
}

class FakeConnection implements LiveConnection {
  started = false;
  stopped = false;
  finished = 0;
  steered: Array<{ channel: string; content: string }> = [];
  inputs: MediaStream[] = [];
  constructor(readonly opts: GptLiveTranslatorOptions, private readonly outcome: () => Promise<void>) {}
  async start() {
    await this.outcome();
    this.started = true;
    this.opts.onReadyChange(true);
  }
  async finishInput() { this.finished++; }
  stop() { this.stopped = true; }
  audioHealth() { return { attached: true, live: true, muted: false, signal: false }; }
  steer(channel: 'instructions' | 'thinking', content: string) { this.steered.push({ channel, content }); return true; }
  async replaceInput(stream: MediaStream) { this.inputs.push(stream); }
  transcript(lane: 'source' | 'target', text: string, startMs: number, endMs = startMs + 200) {
    this.opts.onTranscript({ kind: 'chunk', lane, text, startMs, endMs });
  }
}

let clock = 0;
let connections: FakeConnection[] = [];
let outcomes: Array<() => Promise<void>> = [];
let errors: string[] = [];
let ready: boolean[] = [];
let transcripts: TranscriptEvent[] = [];
let telemetry: LiveTelemetry[] = [];
let gains: Gain[] = [];

function session(): LiveSession {
  return new LiveSession({
    ctx: { currentTime: 0, createGain: () => { const gain = new Gain(); gains.push(gain); return gain; } } as unknown as AudioContext,
    inputStream: {} as MediaStream,
    outputNode: {} as AudioNode,
    serverUrl: 'http://127.0.0.1:8787',
    serverToken: 'token',
    voice: 'meridian',
    inputTranscriptionEnabled: true,
    onTranscript: event => transcripts.push(event),
    onStatus: () => {},
    onReadyChange: value => ready.push(value),
    onError: detail => errors.push(detail),
    onTelemetry: value => telemetry.push(value),
    now: () => clock,
    createTranslator: options => {
      const connection = new FakeConnection(options, outcomes.shift() ?? (async () => {}));
      connections.push(connection);
      return connection;
    }
  });
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  clock = 0; connections = []; outcomes = []; errors = []; ready = []; transcripts = []; telemetry = []; gains = [];
});
afterEach(() => mock.timers.reset());

/** English speech with the same name rendered `lagMs` later in German, speaker still talking. */
function speakWithLag(connection: FakeConnection, atMs: number, lagMs: number, name: string, sentenceEnd = false) {
  connection.transcript('source', `we talked about ${name} today`, atMs, atMs + 1_000);
  connection.transcript('source', ' and more', atMs + lagMs - 500, atMs + lagMs);
  connection.transcript('target', ` wir sprachen über ${name}${sentenceEnd ? '.' : ''}`, atMs + lagMs, atMs + lagMs + 600);
}

test('a provider limit or network loss continues the translation in a new session', async () => {
  const live = session();
  await live.start();
  assert.deepEqual(ready, [true]);
  connections[0]!.opts.onError('GPT-Live hat das Sitzungslimit erreicht.', true);
  assert.equal(connections[0]!.stopped, true);
  assert.deepEqual(ready, [true, false], 'the mix fails open while reconnecting');
  // Open subtitle lines are closed: the new session restarts its timeline.
  assert.deepEqual(transcripts.slice(-2), [{ kind: 'complete', lane: 'source' }, { kind: 'complete', lane: 'target' }]);
  mock.timers.tick(0);
  await flush();
  assert.equal(connections.length, 2);
  assert.deepEqual(ready, [true, false, true]);
  assert.equal(telemetry.at(-1)?.reconnects, 1);
  assert.deepEqual(errors, []);
});

test('a configuration failure is reported instead of retried', async () => {
  const live = session();
  await live.start();
  connections[0]!.opts.onError('Chrome konnte die Zielstimme nicht starten.', false);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(connections.length, 1);
  assert.deepEqual(errors, ['Chrome konnte die Zielstimme nicht starten.']);
});

test('reconnects back off and give up after repeated failures', async () => {
  const live = session();
  await live.start();
  for (let i = 0; i < 10; i++) outcomes.push(async () => { throw new Error('Der GPT-Live-Server ist nicht erreichbar.'); });
  connections[0]!.opts.onError('Die GPT-Live-WebRTC-Verbindung ist fehlgeschlagen.', true);
  for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
    mock.timers.tick(delay);
    await flush();
  }
  assert.equal(connections.length, 6);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Automatische Wiederverbindung fehlgeschlagen/);
});

test('a rejected token during reconnect stops at once', async () => {
  const live = session();
  await live.start();
  outcomes.push(async () => { throw Object.assign(new Error('Invalid GPT-Live server token.'), { retryable: false }); });
  connections[0]!.opts.onError('GPT-Live hat die Verbindung verloren.', true);
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(errors, ['Invalid GPT-Live server token.']);
  mock.timers.tick(20_000);
  await flush();
  assert.equal(connections.length, 2);
});

test('a deliberate stop or finish never reconnects', async () => {
  const live = session();
  await live.start();
  await live.finishInput(1_000);
  connections[0]!.opts.onError('GPT-Live hat die Verbindung verloren.', true);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(connections.length, 1);
  assert.deepEqual(errors, []);
});

test('moderate delay adds silent pacing context without cutting the current sentence', async () => {
  const live = session();
  await live.start();
  const connection = connections[0]!;
  clock = 10_000;
  speakWithLag(connection, 10_000, TIGHTEN_LAG_MS + 500, 'Starbase');
  assert.equal(connection.steered.length, 1);
  assert.equal(connection.steered[0]!.channel, 'thinking');
  assert.match(connection.steered[0]!.content, /etwa [56] Sekunden/);
  assert.equal(telemetry.at(-1)?.lagMs !== null, true);
});

test('a large backlog is dropped at the next German sentence end', async () => {
  const live = session();
  await live.start();
  const connection = connections[0]!;
  clock = 20_000;
  speakWithLag(connection, 20_000, SKIP_LAG_MS + 1_000, 'Monterrey');
  assert.equal(connection.steered.filter(entry => entry.channel === 'instructions').length, 0, 'waits for a boundary');
  connection.transcript('source', ' still talking', 30_000, 30_400);
  connection.transcript('target', ' und das war gut.', 30_200, 30_500);
  const skips = connection.steered.filter(entry => entry.channel === 'instructions');
  assert.equal(skips.length, 1);
  assert.match(skips[0]!.content, /lass alles noch nicht Gedolmetschte weg/);
});

test('the German tail after the speaker stops is never cut', async () => {
  const live = session();
  await live.start();
  const connection = connections[0]!;
  clock = 5_000;
  connection.transcript('source', 'that is all from Toronto', 1_000, 2_000);
  connection.transcript('target', ' das ist alles aus Toronto', 9_000, 9_800);
  connection.transcript('target', ' und danke.', 14_000, 14_500);
  assert.deepEqual(connection.steered, []);
});

test('a session that cannot catch up is replaced by a fresh one with a crossfade', async () => {
  const live = session();
  await live.start();
  const first = connections[0]!;
  clock = 30_000;
  // A skip was sent, but the delay stays far above the limit.
  speakWithLag(first, 30_000, SKIP_LAG_MS + 500, 'Neuralink', true);
  assert.equal(first.steered.at(-1)?.channel, 'instructions');
  clock = 40_000;
  speakWithLag(first, 40_000, 15_000, 'Colossus');
  assert.equal(connections.length, 2, 'a standby session starts while the old one keeps speaking');
  await flush();
  // Standby became ready: hand over.
  assert.equal(first.finished, 1, 'the old session is closed for its final usage');
  assert.ok(gains[0]!.gain.events.includes('ramp:0'), 'the old voice fades out');
  assert.equal(telemetry.at(-1)?.reconnects, 1);
  // Only the new session reaches subtitles now.
  const before = transcripts.length;
  first.transcript('target', ' alt', 60_000);
  assert.equal(transcripts.length, before);
  connections[1]!.transcript('target', ' neu', 1_000);
  assert.equal(transcripts.length, before + 1);
});

test('the provider input can switch to tab audio inside the running session', async () => {
  const live = session();
  await live.start();
  const tabAudio = { id: 'tab' } as unknown as MediaStream;
  await live.replaceInput(tabAudio);
  assert.deepEqual(connections[0]!.inputs, [tabAudio]);
});
