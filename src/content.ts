import type { Message, TranscriptLane } from './messages';
import { placeSubtitleHost, subtitleOverlayTarget } from './subtitle-placement';

const flagged = window as unknown as { __liveTranslateLoaded?: boolean };
if (!flagged.__liveTranslateLoaded) {
  flagged.__liveTranslateLoaded = true;
  setup();
}

function setup(): void {
  const MAX_LINE_LENGTH = 140;
  const SEGMENT_GAP_MS = 2500;
  const HIDE_AFTER_MS = 5000;

  let host: HTMLDivElement | null = null;
  let previousLineEl: HTMLDivElement | null = null;
  let currentLineEl: HTMLDivElement | null = null;
  let previousText = '';
  let currentText = '';
  // Dual-Modus: Das Original läuft als eigene Zeile über der Übersetzung mit.
  let sourceText = '';
  let lastSourceUpdate = 0;
  let lastUpdate = 0;
  let hideTimer: number | undefined;
  let nativeVideo: HTMLVideoElement | null = null;
  let nativeTrack: TextTrack | null = null;
  let nativeCue: VTTCue | null = null;
  // addTextTrack kann Tracks nie wieder entfernen. Einmal angelegte Tracks
  // werden deshalb pro Video wiederverwendet, statt bei jedem Vollbildwechsel
  // einen weiteren toten Eintrag in der nativen Untertitelliste zu hinterlassen.
  const nativeTracks = new WeakMap<HTMLVideoElement, TextTrack>();

  function fullscreenVideo(): HTMLVideoElement | null {
    const fullscreen = document.fullscreenElement;
    return fullscreen?.tagName === 'VIDEO' ? (fullscreen as HTMLVideoElement) : null;
  }

  function clearNativeCue(): void {
    if (nativeTrack && nativeCue) {
      try {
        nativeTrack.removeCue(nativeCue);
      } catch {
        // Der Browser kann den Cue beim Fullscreen-Ende bereits entfernt haben.
      }
    }
    nativeCue = null;
  }

  function clearNativeTrack(): void {
    clearNativeCue();
    if (nativeTrack) nativeTrack.mode = 'disabled';
    nativeTrack = null;
    nativeVideo = null;
  }

  // VTTCue interpretiert "<" als Beginn von Cue-Markup. Transkripttext soll
  // dagegen immer wörtlich erscheinen.
  function escapeVttText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }

  function renderNativeSubtitle(video: HTMLVideoElement): boolean {
    if (typeof VTTCue !== 'function') return false;
    if (nativeVideo !== video || !nativeTrack) {
      clearNativeTrack();
      nativeVideo = video;
      const existingTrack = nativeTracks.get(video);
      nativeTrack = existingTrack ?? video.addTextTrack('subtitles', 'Live Translation', 'und');
      nativeTracks.set(video, nativeTrack);
      nativeTrack.mode = 'showing';
    }
    clearNativeCue();
    const text = [sourceText || previousText, currentText].filter(Boolean).join('\n').trim();
    if (!text) return true;
    const now = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
    const cue = new VTTCue(Math.max(0, now - 0.1), now + HIDE_AFTER_MS / 1_000, escapeVttText(text));
    cue.line = -3;
    cue.align = 'center';
    nativeTrack.addCue(cue);
    nativeCue = cue;
    return true;
  }

  function ensureOverlay(): void {
    if (!host?.isConnected) {
      previousLineEl = null;
      currentLineEl = null;
      host = document.createElement('div');
      host.style.cssText = [
        'position: fixed',
        'left: 0',
        'right: 0',
        'bottom: 7%',
        'display: flex',
        'justify-content: center',
        'z-index: 2147483647',
        'pointer-events: none',
        'transition: opacity 0.4s'
      ].join(';');

      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        .box { display: flex; flex-direction: column; gap: 5px; align-items: center; }
        .line {
          background: rgba(0, 0, 0, 0.75);
          color: #fff;
          font: 600 20px/1.35 system-ui, sans-serif;
          padding: 4px 14px;
          border-radius: 6px;
          max-width: 70vw;
          text-align: center;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
        }
        .line.prev { opacity: 0.75; font-size: 17px; }
        .line:empty { display: none; }
      `;
      const box = document.createElement('div');
      box.className = 'box';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      previousLineEl = document.createElement('div');
      previousLineEl.className = 'line prev';
      currentLineEl = document.createElement('div');
      currentLineEl.className = 'line';
      box.append(previousLineEl, currentLineEl);
      shadow.append(style, box);
    }

    const target = subtitleOverlayTarget(
      document.fullscreenElement,
      document.body,
      document.documentElement
    );
    placeSubtitleHost(host, target);
  }

  function render(): void {
    const video = fullscreenVideo();
    if (video && renderNativeSubtitle(video)) {
      if (host) host.style.opacity = '0';
      return;
    }
    clearNativeTrack();
    ensureOverlay();
    // Im Dual-Modus zeigt die obere Zeile das live mitlaufende Original;
    // sonst wie gehabt den zuletzt abgeschlossenen Übersetzungssatz.
    if (previousLineEl) previousLineEl.textContent = sourceText || previousText;
    if (currentLineEl) currentLineEl.textContent = currentText;
    if (host) host.style.opacity = '1';
  }

  function finalizeSegment(): void {
    const trimmed = currentText.trim();
    if (trimmed) previousText = trimmed;
    currentText = '';
  }

  function scheduleHide(): void {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (host) host.style.opacity = '0';
      clearNativeCue();
      finalizeSegment();
      sourceText = '';
    }, HIDE_AFTER_MS);
  }

  // Hält die aktuelle Zeile auch bei einem einzelnen langen Transkript-Chunk
  // begrenzt: Der Anfang wandert an einer Wortgrenze in die vorherige Zeile,
  // der Rest läuft als aktuelle Zeile weiter.
  function rotateOverlongLine(): void {
    while (currentText.length > MAX_LINE_LENGTH) {
      const boundary = currentText.lastIndexOf(' ', MAX_LINE_LENGTH);
      const cut = boundary > 0 ? boundary : MAX_LINE_LENGTH;
      const head = currentText.slice(0, cut).trim();
      if (head) previousText = head;
      currentText = currentText.slice(cut).trimStart();
    }
  }

  // Das Original behält nur das frischeste Zeilenende – ältere Wörter laufen
  // an einer Wortgrenze hinaus, damit die Zeile mit dem Sprecher Schritt hält.
  function trimOverlongSource(): void {
    if (sourceText.length <= MAX_LINE_LENGTH) return;
    const cutFrom = sourceText.length - MAX_LINE_LENGTH;
    const boundary = sourceText.indexOf(' ', cutFrom);
    sourceText = sourceText.slice(boundary > -1 ? boundary + 1 : cutFrom).trimStart();
  }

  function appendSourceSubtitle(text: string): void {
    const now = Date.now();
    if (sourceText && now - lastSourceUpdate > SEGMENT_GAP_MS) sourceText = '';
    lastSourceUpdate = now;
    sourceText += text;
    trimOverlongSource();
    render();
    scheduleHide();
  }

  function appendSubtitle(text: string, final: boolean, lane: TranscriptLane): void {
    if (lane === 'source') {
      appendSourceSubtitle(text);
      return;
    }
    const now = Date.now();
    if (currentText && now - lastUpdate > SEGMENT_GAP_MS) finalizeSegment();
    lastUpdate = now;
    currentText += text;
    rotateOverlongLine();
    if (final) finalizeSegment();
    render();
    scheduleHide();
  }

  function clear(): void {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    host?.remove();
    host = null;
    previousLineEl = null;
    currentLineEl = null;
    previousText = '';
    currentText = '';
    sourceText = '';
    clearNativeTrack();
  }

  const onMessage = (msg: Message) => {
    if (msg.type === 'subtitle') {
      appendSubtitle(msg.text, msg.final, msg.lane === 'source' ? 'source' : 'target');
    } else if (msg.type === 'subtitle-clear') clear();
  };
  chrome.runtime.onMessage.addListener(onMessage);

  const onFullscreenChange = () => render();
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Wurde die Extension neu geladen/entfernt, ist dieser Skript-Kontext
  // verwaist – Overlay aufräumen statt es für immer stehen zu lassen.
  const healthTimer = window.setInterval(() => {
    let alive = false;
    try {
      alive = Boolean(chrome.runtime?.id);
    } catch {
      alive = false;
    }
    if (!alive) {
      clear();
      window.clearInterval(healthTimer);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        // Der Extension-Kontext ist bereits ungültig.
      }
      flagged.__liveTranslateLoaded = false;
    }
  }, 5000);
}
