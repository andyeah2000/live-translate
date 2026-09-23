import assert from 'node:assert/strict';
import test from 'node:test';
import { SubtitleState } from '../src/subtitle-state';

test('dual subtitles preserve a finalized target below the source lane', () => {
  const state = new SubtitleState();
  state.apply({ kind: 'chunk', lane: 'source', text: 'Liftoff' }, 0);
  state.apply({ kind: 'chunk', lane: 'target', text: 'Abheben' }, 10);
  state.apply({ kind: 'complete', lane: 'target' }, 20);

  assert.deepEqual(state.snapshot(), { upper: 'Liftoff', lower: 'Abheben' });
});

test('late chunks, a new turn and interrupts update only their own lane', () => {
  const state = new SubtitleState();
  state.apply({ kind: 'chunk', lane: 'target', text: 'Erster Satz' }, 0);
  state.apply({ kind: 'complete', lane: 'target' }, 1);
  state.apply({ kind: 'chunk', lane: 'source', text: 'late source' }, 2);
  state.apply({ kind: 'complete', lane: 'source' }, 3);
  state.apply({ kind: 'chunk', lane: 'target', text: 'Zweiter' }, 4);

  assert.deepEqual(state.snapshot(), { upper: 'late source', lower: 'Zweiter' });
  state.apply({ kind: 'interrupt', lane: 'target' }, 5);
  assert.deepEqual(state.snapshot(), { upper: 'late source', lower: 'Erster Satz' });
});

test('translation-only state keeps final and partial target lines separate', () => {
  const state = new SubtitleState();
  state.apply({ kind: 'chunk', lane: 'target', text: 'Fertig' }, 0);
  state.apply({ kind: 'complete', lane: 'target' }, 1);
  assert.deepEqual(state.snapshot(), { upper: '', lower: 'Fertig' });

  state.apply({ kind: 'chunk', lane: 'target', text: 'Neu' }, 2);
  assert.deepEqual(state.snapshot(), { upper: 'Fertig', lower: 'Neu' });
  state.hide();
  assert.deepEqual(state.snapshot(), { upper: '', lower: '' });
});

test('source tails and overlong target chunks stay bounded at word boundaries', () => {
  const state = new SubtitleState({ maxLineLength: 12, segmentGapMs: 10 });
  state.apply({ kind: 'chunk', lane: 'source', text: 'alpha beta gamma delta' }, 0);
  assert.equal(state.snapshot().upper, 'gamma delta');

  state.apply({ kind: 'interrupt', lane: 'source' }, 1);
  state.apply({ kind: 'chunk', lane: 'target', text: 'eins zwei drei vier fünf' }, 2);
  assert.ok(state.snapshot().upper.length <= 12);
  assert.ok(state.snapshot().lower.length <= 12);

  state.apply({ kind: 'chunk', lane: 'target', text: ' neu' }, 20);
  state.apply({ kind: 'complete', lane: 'source' }, 21);
  state.clear();
  assert.deepEqual(state.snapshot(), { upper: '', lower: '' });
});

test('timestamp gaps, not turn events, split GPT-Live transcript segments', () => {
  const state = new SubtitleState({ segmentGapMs: 100 });
  state.apply({ kind: 'chunk', lane: 'target', text: 'Hal', startMs: 0, endMs: 40 }, 0);
  state.apply({ kind: 'chunk', lane: 'target', text: 'lo', startMs: 40, endMs: 80 }, 1);
  assert.deepEqual(state.snapshot(), { upper: '', lower: 'Hallo' });

  state.apply({ kind: 'chunk', lane: 'target', text: ' Neuer Satz', startMs: 250, endMs: 300 }, 2);
  assert.deepEqual(state.snapshot(), { upper: 'Hallo', lower: ' Neuer Satz' });
});
