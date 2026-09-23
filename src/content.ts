import type { Message, TranscriptEvent } from './messages';
import { placeSubtitleHost, subtitleOverlayTarget } from './subtitle-placement';
import { SubtitleState } from './subtitle-state';
import { installMediaInput } from './media-input';

const flagged = window as unknown as { __liveTranslateLoaded?: boolean };
if (!flagged.__liveTranslateLoaded) {
  flagged.__liveTranslateLoaded = true;
  setup();
  installMediaInput();
}

function setup(): void {
  const HIDE_AFTER_MS = 5000;

  let host: HTMLDivElement | null = null;
  let previousLineEl: HTMLDivElement | null = null;
  let currentLineEl: HTMLDivElement | null = null;
  const subtitleState = new SubtitleState();
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
    const snapshot = subtitleState.snapshot();
    const text = [snapshot.upper, snapshot.lower].filter(Boolean).join('\n').trim();
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
    const snapshot = subtitleState.snapshot();
    if (previousLineEl) previousLineEl.textContent = snapshot.upper;
    if (currentLineEl) currentLineEl.textContent = snapshot.lower;
    if (host) host.style.opacity = '1';
  }

  function scheduleHide(): void {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (host) host.style.opacity = '0';
      clearNativeCue();
      subtitleState.hide();
    }, HIDE_AFTER_MS);
  }

  function applySubtitle(event: TranscriptEvent): void {
    subtitleState.apply(event);
    render();
    scheduleHide();
  }

  function clear(): void {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    host?.remove();
    host = null;
    previousLineEl = null;
    currentLineEl = null;
    subtitleState.clear();
    clearNativeTrack();
  }

  const onMessage = (msg: Message) => {
    if (msg.type === 'subtitle') {
      applySubtitle(msg.event);
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
