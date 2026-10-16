import assert from 'node:assert/strict';
import test from 'node:test';

class ElementMock {
  style = {
    cssText: '', opacity: '', left: '', right: '', width: '', bottom: '',
    setProperty() {}, removeProperty() {}
  };
  textContent = '';
  className = '';
  parentNode: ElementMock | null = null;
  children: ElementMock[] = [];
  shadow: ElementMock | null = null;
  constructor(public tagName: string) {}
  get isConnected() { return this.parentNode !== null; }
  setAttribute() {}
  append(...children: ElementMock[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: ElementMock) { child.remove(); child.parentNode = this; this.children.push(child); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  attachShadow() { this.shadow = new ElementMock('SHADOW'); return this.shadow; }
}

test('fullscreen subtitles create tracks only for visible text and reuse and disable them', async () => {
  const names = ['chrome', 'document', 'window', 'VTTCue', 'setInterval', 'clearInterval', 'clearTimeout'] as const;
  const previous = Object.fromEntries(names.map(name => [name, (globalThis as Record<string, unknown>)[name]]));
  const messages: Array<(message: unknown, sender?: unknown) => void> = [];
  const documentEvents = new Map<string, () => void>();
  const videoEvents = new Map<string, () => void>();
  const windowEvents = new Map<string, Array<() => void>>();
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let timerId = 0;
  const body = new ElementMock('BODY');
  const root = new ElementMock('HTML');
  const tracks: Array<{ mode: string; cues: unknown[]; addCue(cue: unknown): void; removeCue(cue: unknown): void }> = [];
  const video = {
    tagName: 'VIDEO', currentTime: 12, playbackRate: 2,
    addEventListener: (name: string, callback: () => void) => videoEvents.set(name, callback),
    removeEventListener: (name: string) => videoEvents.delete(name),
    addTextTrack() {
      const track = {
        mode: 'disabled', cues: [] as unknown[],
        addCue(cue: unknown) { this.cues.push(cue); },
        removeCue(cue: unknown) { this.cues = this.cues.filter(item => item !== cue); }
      };
      tracks.push(track);
      return track;
    }
  };
  const documentMock = {
    fullscreenElement: video as typeof video | null,
    body, documentElement: root,
    createElement: (tag: string) => new ElementMock(tag.toUpperCase()),
    // No inline video outside fullscreen: the overlay keeps the viewport placement.
    querySelectorAll: () => [],
    addEventListener: (name: string, callback: () => void) => documentEvents.set(name, callback),
    removeEventListener: (name: string) => documentEvents.delete(name)
  };
  const runtime = {
    id: 'test',
    onMessage: {
      addListener: (callback: typeof messages[number]) => messages.push(callback),
      removeListener: (callback: typeof messages[number]) => messages.splice(messages.indexOf(callback), 1)
    }
  };
  const setIntervalMock = (callback: () => void) => { const id = ++timerId; intervals.set(id, callback); return id; };
  Object.assign(globalThis, {
    chrome: { runtime }, document: documentMock,
    window: {
      setTimeout: (callback: () => void) => { const id = ++timerId; timeouts.set(id, callback); return id; },
      setInterval: setIntervalMock,
      clearInterval: (id: number) => intervals.delete(id),
      addEventListener: (name: string, callback: () => void) => windowEvents.set(name, [...(windowEvents.get(name) ?? []), callback]),
      removeEventListener: (name: string, callback: () => void) => windowEvents.set(name, (windowEvents.get(name) ?? []).filter(listener => listener !== callback))
    },
    setInterval: setIntervalMock,
    clearInterval: (id: number) => intervals.delete(id),
    clearTimeout: (id: number) => timeouts.delete(id),
    VTTCue: class {
      line = 0;
      align = '';
      constructor(public startTime: number, public endTime: number, public text: string) {}
    }
  });
  try {
    await import('../src/content');
    const send = (message: unknown) => messages[0]!(message);
    documentEvents.get('fullscreenchange')!();
    assert.equal(tracks.length, 0, 'empty subtitles must not create or activate native tracks');
    assert.equal(body.children.length, 0);

    send({ type: 'subtitle', event: { kind: 'chunk', lane: 'target', text: '<b>A & B' } });
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.mode, 'showing');
    assert.equal((tracks[0]!.cues[0] as { text: string }).text, '&lt;b>A &amp; B');
    assert.equal((tracks[0]!.cues[0] as { endTime: number }).endTime, 22, '2x playback keeps captions visible for the same wall-clock duration');
    video.currentTime = 100;
    videoEvents.get('seeking')!();
    assert.equal((tracks[0]!.cues[0] as { startTime: number }).startTime, 99.9, 'seeking reanchors the current caption to the new media time');
    video.playbackRate = 1;
    videoEvents.get('ratechange')!();
    assert.equal((tracks[0]!.cues[0] as { endTime: number }).endTime, 105);
    send({ type: 'subtitle-clear' });
    assert.equal(tracks[0]!.mode, 'disabled');
    assert.equal(tracks[0]!.cues.length, 0);
    assert.equal(videoEvents.size, 0, 'inactive videos must release timeline listeners');
    documentEvents.get('fullscreenchange')!();
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.mode, 'disabled');

    send({ type: 'subtitle', event: { kind: 'chunk', lane: 'target', text: 'Wieder da' } });
    assert.equal(tracks.length, 1, 'the video must reuse its existing subtitle track');
    for (const callback of timeouts.values()) callback();
    assert.equal(tracks[0]!.mode, 'disabled', 'expired native subtitles release the track');

    documentMock.fullscreenElement = null;
    send({ type: 'subtitle', event: { kind: 'chunk', lane: 'target', text: '<script>literal</script>' } });
    const host = body.children[0]!;
    const box = host.shadow!.children[1]!;
    assert.equal(box.children[1]!.textContent, '<script>literal</script>');
    windowEvents.get('pagehide')!.forEach(listener => listener());
    assert.equal(body.children.length, 0, 'pagehide must not retain subtitles in the back/forward cache');
    send({ type: 'subtitle', event: { kind: 'chunk', lane: 'target', text: 'new caption' } });
    runtime.id = '';
    for (const callback of intervals.values()) callback();
    assert.equal(body.children.length, 0, 'extension invalidation removes the overlay');
    assert.equal(documentEvents.has('fullscreenchange'), false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = previous[name];
    }
  }
});
