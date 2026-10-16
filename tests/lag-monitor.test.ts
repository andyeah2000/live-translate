import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { LagMonitor, normalizeWord, sourceAnchor } from '../src/offscreen/lag-monitor';
import type { TranscriptEvent } from '../src/messages';

const chunk = (lane: 'source' | 'target', text: string, startMs: number, endMs = startMs + 200): TranscriptEvent =>
  ({ kind: 'chunk', lane, text, startMs, endMs });

test('anchors are names and long cognates, never short common words', () => {
  assert.deepEqual(sourceAnchor('Starbase', false), { key: 'starb', exact: false });
  assert.deepEqual(sourceAnchor('Mars', false), { key: 'mars', exact: true });
  assert.deepEqual(sourceAnchor('demonstrate', false), { key: 'demon', exact: false });
  assert.equal(sourceAnchor('Mars', true), null, 'a sentence-initial capital is no name');
  assert.equal(sourceAnchor('there', false), null);
  assert.equal(sourceAnchor('I', false), null);
  assert.equal(normalizeWord('Aktuator'), normalizeWord('actuator'));
  assert.equal(normalizeWord('Physik').slice(0, 4), normalizeWord('physics').slice(0, 4));
});

test('a shared name on both lanes yields the speech-to-speech delay', () => {
  const monitor = new LagMonitor();
  monitor.observe(chunk('source', 'We flew from Starbase', 1_000, 2_000));
  const estimate = monitor.observe(chunk('target', ' Wir flogen von Starbase', 4_000, 5_000));
  assert.equal(estimate?.basis, 'anchor');
  assert.ok(Math.abs((estimate?.lagMs ?? 0) - 3_000) < 300, String(estimate?.lagMs));
});

test('input transcription that arrives after the German word is still aligned', () => {
  const monitor = new LagMonitor();
  assert.equal(monitor.observe(chunk('target', ' Optimus', 2_500, 2_700)), null);
  // The pending German word is matched once its source word is transcribed.
  const estimate = monitor.observe(chunk('source', 'about Optimus', 800, 1_200));
  assert.ok(Math.abs((estimate?.lagMs ?? 0) - 1_540) < 100, String(estimate?.lagMs));
});

test('German speech long after the speaker stopped is a lower bound and marks the source idle', () => {
  const monitor = new LagMonitor();
  monitor.observe(chunk('source', 'and that was it', 1_000, 2_000));
  monitor.observe(chunk('target', ' und das', 2_500));
  assert.equal(monitor.sourceActive(), true);
  const estimate = monitor.observe(chunk('target', ' war es', 6_000, 6_200));
  assert.equal(estimate?.basis, 'pause');
  assert.equal(estimate?.lagMs, 4_200);
  assert.equal(monitor.sourceActive(), false);
});

test('after a skip, older homonyms cannot inflate the delay', () => {
  const monitor = new LagMonitor();
  monitor.observe(chunk('source', 'the Model one', 1_000, 1_500));
  monitor.observe(chunk('source', 'and later the Model two', 9_000, 10_000));
  monitor.skipBacklog();
  const estimate = monitor.observe(chunk('target', ' Model zwei', 11_000, 11_400));
  assert.ok((estimate?.lagMs ?? 0) < 3_000, String(estimate?.lagMs));
});

test('reset forgets the previous session timeline', () => {
  const monitor = new LagMonitor();
  monitor.observe(chunk('source', 'Toronto', 50_000));
  monitor.reset();
  assert.equal(monitor.observe(chunk('target', ' Toronto', 2_000)), null);
  assert.equal(monitor.estimate(), null);
});

test('a real GPT-Live recording reproduces the measured reference delays', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/gpt-live-fast-speech.json', import.meta.url), 'utf8')) as {
    chunks: Array<{ lane: 'source' | 'target'; text: string; startMs?: number; endMs?: number }>;
  };
  const monitor = new LagMonitor();
  const timeline: Array<{ atSec: number; lagSec: number }> = [];
  for (const recorded of fixture.chunks) {
    const estimate = monitor.observe({ kind: 'chunk', ...recorded });
    if (estimate && recorded.lane === 'target') timeline.push({ atSec: estimate.atMs / 1_000, lagSec: estimate.lagMs / 1_000 });
  }
  const at = (sec: number) => timeline.filter(point => point.atSec <= sec).at(-1)?.lagSec ?? NaN;
  // Reference: Starship 3.6 s @8.6 s, Palo Alto 13.2 s @49 s, Toronto 20.0 s @73 s (target time).
  assert.ok(Math.abs(at(9) - 3.6) < 1.5, `early ${at(9)}`);
  assert.ok(Math.abs(at(50) - 13.2) < 2.5, `middle ${at(50)}`);
  assert.ok(Math.abs(at(74) - 20.0) < 2.5, `late ${at(74)}`);
});
