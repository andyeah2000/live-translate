import { OutputActivity } from './dubbing-mix';
import type { TranscriptEvent } from '../messages';
import {
  EVENTS_CHANNEL_ID,
  liveSessionEndpoint,
  parseLiveServerEvent,
  parseLiveSessionAnswer,
  type LiveCloseReason
} from './live-protocol';
import { TRANSLATION_PROFILE } from '../translation-profile';

const ICE_GATHER_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;
const DISCONNECT_TIMEOUT_MS = 10_000;
const SESSION_REQUEST_TIMEOUT_MS = 30_000;

export interface GptLiveTranslatorOptions {
  ctx: AudioContext;
  inputStream: MediaStream;
  outputNode: AudioNode;
  serverUrl: string;
  serverToken: string;
  voice?: string;
  inputTranscriptionEnabled: boolean;
  onTranscript: (event: TranscriptEvent) => void;
  onStatus: (status: string) => void;
  onReadyChange: (ready: boolean) => void;
  /** Terminal for this connection. `recoverable` failures may be retried with a new session. */
  onError: (detail: string, recoverable: boolean) => void;
  /** Non-fatal provider notices, e.g. a moderation cut-off or a rejected command. */
  onWarning?: (detail: string) => void;
  /** Cumulative billed voice seconds of this session. */
  onUsage?: (seconds: number) => void;
}

class SessionRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** A provider-side end of a running session that a fresh session can continue. */
function recoverableClose(reason: LiveCloseReason): boolean {
  return reason !== 'close_requested';
}

function closeDetail(reason: LiveCloseReason): string {
  switch (reason) {
    case 'expired': return 'GPT-Live hat das Sitzungslimit erreicht.';
    case 'content': return 'GPT-Live hat die Sitzung aus Sicherheitsgründen beendet.';
    case 'connection_lost': return 'GPT-Live hat die Verbindung verloren.';
    case 'remote_hangup': return 'GPT-Live hat die Sitzung beendet.';
    case 'close_requested': return 'GPT-Live hat die Sitzung auf Anfrage beendet.';
    default: return 'GPT-Live hat die Sitzung beendet.';
  }
}

/**
 * Browserseitiger GPT-Live-WebRTC-Adapter für genau eine Sitzung. Der
 * Standard-API-Key verbleibt beim eigenen Server; diese Klasse kennt nur
 * dessen Zugriffstoken und SDP-Antwort. Wiederverbindung und Aufholregelung
 * liegen eine Ebene darüber (live-session.ts).
 */
export class GptLiveTranslator {
  private peer: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private spareChannels: RTCDataChannel[] = [];
  private remoteAudio: MediaStreamAudioSourceNode | null = null;
  private playback: HTMLAudioElement | null = null;
  private meter: AnalyserNode | null = null;
  private meterSamples = new Float32Array(2048);
  private readonly outputActivity = new OutputActivity();
  private readonly requestAbort = new AbortController();
  private startPromise: Promise<void> | null = null;
  private failure: Error | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private stopped = false;
  private closing = false;
  private ready = false;
  private startTimer: number | null = null;
  private receiverTimer: number | null = null;
  private audioWatchdog: number | null = null;
  private disconnectTimer: number | null = null;
  private playbackGeneration = 0;
  private attachedTrackIds = new Set<string>();
  private closePromise: Promise<void> = Promise.resolve();
  private resolveClosed: (() => void) | null = null;
  private rejectClosed: ((reason?: unknown) => void) | null = null;
  private sessionClosed = false;
  private lastTrack: MediaStreamTrack | null = null;
  private finishPromise: Promise<void> | null = null;
  private rejectedDelegations = 0;
  private instructionCount = 0;
  /** start() resolved; from here on failures are reported through onError. */
  private started = false;

  constructor(private readonly opts: GptLiveTranslatorOptions) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(this.failure ?? new Error('Die GPT-Live-Sitzung wurde beendet.'));
    this.startPromise ??= this.startConnection().catch((error: unknown) => {
      // A failure before session.started is reported through the rejection,
      // not through onError, so the caller decides how to present or retry it.
      const failure = this.failure ?? (error instanceof Error ? error : new Error(String(error)));
      this.failure = failure;
      this.stop();
      throw failure;
    });
    return this.startPromise;
  }

  /** Whether a failed start may succeed with an identical new attempt. */
  static isRetryable(error: unknown): boolean {
    return !(error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === false);
  }

  private async startConnection(): Promise<void> {
    if (this.stopped) throw new Error('Die GPT-Live-Sitzung wurde beendet.');
    this.opts.onStatus('Verbinde mit GPT-Live…');
    if (this.opts.inputStream.getAudioTracks().length === 0) {
      throw new SessionRequestError('Der Quell-Tab enthält keine Audiospur für GPT-Live.', false);
    }
    const connection = new RTCPeerConnection();
    this.peer = connection;
    this.sessionClosed = false;
    this.closePromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    // A transport failure can happen before finishInput() starts waiting. Keep
    // that rejection observable to finishInput while preventing an unhandled
    // promise rejection during ordinary startup teardown.
    void this.closePromise.catch(() => {});

    connection.addEventListener('track', (event) => this.attachRemoteAudio(event));
    connection.addEventListener('connectionstatechange', () => {
      if (this.stopped || this.sessionClosed) return;
      if (
        connection.connectionState === 'failed' ||
        connection.connectionState === 'closed' ||
        (this.closing && connection.connectionState === 'disconnected')
      ) {
        const detail = this.closing
          ? 'Die GPT-Live-WebRTC-Verbindung wurde vor session.closed getrennt (unvollständige Finalisierung).'
          : 'Die GPT-Live-WebRTC-Verbindung ist fehlgeschlagen.';
        this.fail(detail, true);
      } else if (connection.connectionState === 'disconnected') {
        // Disconnected can recover after a short network interruption. It must
        // not leave an indefinitely silent session marked ready if it cannot.
        this.disconnectTimer ??= window.setTimeout(() => {
          this.disconnectTimer = null;
          if (connection.connectionState === 'disconnected') {
            this.fail('Die GPT-Live-WebRTC-Verbindung wurde unterbrochen.', true);
          }
        }, DISCONNECT_TIMEOUT_MS);
      } else {
        this.clearDisconnectTimer();
      }
    });

    for (const track of this.opts.inputStream.getAudioTracks()) {
      connection.addTrack(track, this.opts.inputStream);
    }

    // Create and observe the channel before the offer so no early event is lost.
    this.bindEvents(connection.createDataChannel('oai-events', { negotiated: true, id: EVENTS_CHANNEL_ID }));

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection, ICE_GATHER_TIMEOUT_MS, this.requestAbort.signal);
    if (this.stopped) throw new Error('Die GPT-Live-Sitzung wurde beendet.');
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error('Chrome konnte kein WebRTC-Angebot für GPT-Live erzeugen.');

    const answer = await this.createSession(sdp);
    if (this.stopped || connection !== this.peer) throw this.failure ?? new Error('Die GPT-Live-Sitzung wurde beendet.');
    if (answer.dcid !== EVENTS_CHANNEL_ID) {
      // A server without pre-negotiation support created a standard session.
      // SCTP is already part of the offer, so an in-band channel needs no renegotiation.
      if (this.events) this.spareChannels.push(this.events);
      this.bindEvents(connection.createDataChannel('oai-events'));
    }
    await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await this.waitForStart();
    // The ready event and a terminal event can arrive in the same task before
    // this continuation runs. Never turn that failure into a successful start.
    if (this.stopped) throw this.failure ?? new Error('Die GPT-Live-Sitzung wurde beendet.');
    this.watchReceivers();
    this.started = true;
  }

  private bindEvents(events: RTCDataChannel): void {
    this.events = events;
    events.addEventListener('message', ({ data }) => {
      if (events === this.events) this.handleEvent(data);
    });
    events.addEventListener('close', () => {
      if (events !== this.events || this.stopped || this.sessionClosed) return;
      this.fail(
        this.closing
          ? 'Die GPT-Live-Ereignisverbindung wurde vor session.closed getrennt (unvollständige Finalisierung).'
          : 'Die GPT-Live-Ereignisverbindung wurde unerwartet geschlossen.',
        true
      );
    });
    events.addEventListener('error', () => {
      if (events !== this.events || this.stopped || this.sessionClosed) return;
      this.fail(
        this.closing
          ? 'Die GPT-Live-Ereignisverbindung ist vor session.closed fehlgeschlagen (unvollständige Finalisierung).'
          : 'Die GPT-Live-Ereignisverbindung ist fehlgeschlagen.',
        true
      );
    });
  }

  /**
   * Trusted mid-session steering. `instructions` redirects behaviour and may
   * cut the current utterance; `thinking` adds silent context the model uses
   * for later speech. Returns false when the session cannot accept commands.
   */
  steer(channel: 'instructions' | 'thinking', content: string, purpose = 'steer', delegationId: string | null = null): boolean {
    const events = this.events;
    if (!this.ready || this.closing || this.stopped || !events || events.readyState !== 'open') return false;
    try {
      events.send(JSON.stringify({
        type: channel === 'instructions' ? 'session.instructions.append' : 'session.thinking.append',
        event_id: `${purpose}_${++this.instructionCount}`,
        delegation_id: delegationId,
        content
      }));
      return true;
    } catch {
      return false;
    }
  }

  /** Swap the provider input (e.g. direct video audio → tab audio) inside the running session. */
  async replaceInput(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0];
    const sender = this.peer?.getSenders().find(candidate => candidate.track === null || candidate.track.kind === 'audio');
    if (!track || !sender || this.stopped) return;
    await sender.replaceTrack(track);
  }

  finishInput(timeoutMs = 15_000): Promise<void> {
    this.finishPromise ??= this.closeSession(timeoutMs);
    return this.finishPromise;
  }

  private async closeSession(timeoutMs: number): Promise<void> {
    if (this.sessionClosed) return;
    if (this.stopped) {
      throw this.failure ?? new Error('GPT-Live wurde ohne session.closed beendet (unvollständige Finalisierung).');
    }
    if (!this.ready) {
      // No commands are valid before session.started. Cancelling here must
      // settle startup too, rather than leave its waiter alive after close.
      this.stop();
      throw new Error('GPT-Live wurde vor session.started beendet (unvollständige Finalisierung).');
    }
    this.closing = true;
    this.setReady(false);
    this.opts.onStatus('GPT-Live-Sitzung wird beendet…');
    const events = this.events;
    const detail = 'GPT-Live konnte session.close nicht senden (unvollständige Finalisierung).';
    if (!events || events.readyState !== 'open') {
      this.fail(detail, false);
      throw new Error(detail);
    }
    try {
      events.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      this.fail(detail, false);
      throw new Error(detail);
    }
    const boundedTimeout = Math.max(250, Number.isFinite(timeoutMs) ? timeoutMs : 15_000);
    let timer: number | undefined;
    let closed: boolean;
    try {
      closed = await Promise.race([
        this.closePromise.then(() => true),
        new Promise<boolean>(resolve => { timer = window.setTimeout(() => resolve(false), boundedTimeout); })
      ]);
    } finally {
      window.clearTimeout(timer);
    }
    if (!closed && !this.sessionClosed) {
      const timeoutDetail =
        'GPT-Live hat session.close nicht mit session.closed bestätigt (unvollständige Finalisierung).';
      this.fail(timeoutDetail, false);
      throw new Error(timeoutDetail);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.requestAbort.abort();
    this.rejectStart?.(this.failure ?? new Error('Die GPT-Live-Sitzung wurde beendet.'));
    this.rejectStart = null;
    this.closing = true;
    this.clearTimers();
    this.setReady(false);
    if (!this.sessionClosed) this.rejectClosed?.(new Error('GPT-Live-Sitzung beendet.'));
    else this.resolveClosed?.();
    this.resolveClosed = null;
    this.rejectClosed = null;
    for (const channel of [this.events, ...this.spareChannels]) {
      try {
        channel?.close();
      } catch {
        // Bei einer bereits beendeten Verbindung gibt es nichts aufzuräumen.
      }
    }
    this.events = null;
    this.spareChannels = [];
    try {
      this.peer?.close();
    } catch {
      // Siehe oben.
    }
    this.peer = null;
    try {
      this.remoteAudio?.disconnect();
    } catch {
      // Siehe oben.
    }
    this.remoteAudio = null;
    this.meter?.disconnect();
    this.meter = null;
    if (this.lastTrack) {
      this.lastTrack.onunmute = null;
      this.lastTrack.onended = null;
    }
    this.lastTrack = null;
    this.attachedTrackIds.clear();
    this.playbackGeneration++;
    if (this.playback) {
      this.playback.pause();
      this.playback.srcObject = null;
      this.playback.remove();
      this.playback = null;
    }
  }

  private async createSession(sdp: string): Promise<{ sessionId: string; sdp: string; dcid: number | null }> {
    const timeout = window.setTimeout(() => this.requestAbort.abort(), SESSION_REQUEST_TIMEOUT_MS);
    try {
      return await this.requestSession(sdp);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async requestSession(sdp: string): Promise<{ sessionId: string; sdp: string; dcid: number | null }> {
    let response: Response;
    try {
      response = await fetch(liveSessionEndpoint(this.opts.serverUrl), {
        method: 'POST',
        credentials: 'omit',
        signal: this.requestAbort.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Live-Translate-Token': this.opts.serverToken
        },
        body: JSON.stringify({ sdp, voice: this.opts.voice, dcid: EVENTS_CHANNEL_ID })
      });
    } catch {
      if (this.stopped) throw this.failure ?? new Error('Die GPT-Live-Sitzung wurde beendet.');
      throw new SessionRequestError('Der GPT-Live-Server ist nicht erreichbar. Bitte Server-URL und Netzwerk prüfen.', true);
    }
    if (!response.ok) {
      const { detail, retryable } = await responseError(response);
      throw new SessionRequestError(detail, retryable);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SessionRequestError('Der GPT-Live-Server hat keine gültige Sitzungsantwort geliefert.', true);
    }
    const answer = parseLiveSessionAnswer(payload);
    if (!answer) throw new SessionRequestError('Der GPT-Live-Server hat eine unvollständige Sitzungsantwort geliefert.', true);
    return answer;
  }

  private attachRemoteAudio(event: RTCTrackEvent): void {
    if (this.stopped || this.sessionClosed || event.track.kind !== 'audio') return;
    // MediaStreamAudioSourceNode chooses one track from a multi-track stream.
    // Isolate the event track so another stream member can never be selected.
    this.connectTrack(event.track, new MediaStream([event.track]));
  }

  /**
   * Fallback für verlorene Track-Events: Falls die Verhandlung einen
   * Audiotrack liefert, dessen Event nie ankam, wird er hier nachträglich
   * angebunden. Ohne das bliebe die Sitzung bei laufenden Untertiteln stumm.
   */
  private watchReceivers(): void {
    if (this.receiverTimer !== null || this.stopped || this.closing || this.sessionClosed) return;
    this.receiverTimer = window.setInterval(() => {
      const peer = this.peer;
      if (this.stopped || this.closing || peer === null) {
        this.clearReceiverTimer();
        return;
      }
      for (const receiver of peer.getReceivers()) {
        const track = receiver.track;
        if (
          track.kind !== 'audio' ||
          track.readyState !== 'live' ||
          this.attachedTrackIds.has(track.id)
        ) {
          continue;
        }
        console.info('[live-translate] Audiotrack über Receiver-Fallback angebunden.');
        this.connectTrack(track, new MediaStream([track]));
      }
    }, 2_000);
  }

  private connectTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.stopped || (this.lastTrack === track && this.remoteAudio !== null)) return;
    try {
      if (this.lastTrack) {
        this.lastTrack.onunmute = null;
        this.lastTrack.onended = null;
      }
      this.remoteAudio?.disconnect();
      this.remoteAudio = this.opts.ctx.createMediaStreamSource(stream);
      this.meter?.disconnect();
      this.meter = this.opts.ctx.createAnalyser();
      this.meter.fftSize = 2048;
      // The meter is a passive tap; audio reaches the output without passing it.
      this.remoteAudio.connect(this.meter);
      this.remoteAudio.connect(this.opts.outputNode);
      // Keep Chrome's remote media playback active. Only Web Audio is audible,
      // so volume control and mixing have exactly one output path.
      this.playback ??= document.createElement('audio');
      this.playback.autoplay = true;
      this.playback.muted = true;
      this.playback.srcObject = stream;
      if (!this.playback.isConnected) document.body.append(this.playback);
      const playbackGeneration = ++this.playbackGeneration;
      void this.playback.play().catch(() => {
        // Replacing srcObject can reject the previous play() with AbortError.
        // Only the current playback attempt may terminate this session.
        if (this.stopped || this.sessionClosed || playbackGeneration !== this.playbackGeneration) return;
        this.fail('Chrome konnte die Zielstimme nicht starten. Bitte die Übersetzung neu starten.', false);
      });
      this.attachedTrackIds.add(track.id);
      this.lastTrack = track;
      track.onended = () => {
        if (this.lastTrack !== track || this.stopped || this.closing || this.sessionClosed) return;
        this.fail('Die GPT-Live-Zielstimme wurde unerwartet beendet.', true);
      };
      if (track.readyState === 'ended') {
        track.onended(new Event('ended'));
        return;
      }
      this.opts.onStatus(`GPT-Live aktiv · Zielstimme verbunden · Spur ${this.attachedTrackIds.size}`);
    } catch (error) {
      this.fail(`Die GPT-Live-Audiospur konnte nicht wiedergegeben werden: ${errorMessage(error)}`, false);
    }
  }

  private handleEvent(data: unknown): void {
    if (this.stopped || this.sessionClosed || typeof data !== 'string' || data.length > 262_144) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const event = parseLiveServerEvent(payload);
    if (event.kind === 'started') {
      if (this.closing || this.ready) return;
      this.setReady(true);
      // onReadyChange may synchronously stop a failed AudioContext. Do not
      // resurrect its status or install a watchdog after resource teardown.
      if (this.stopped || this.closing || this.sessionClosed) return;
      this.resolveStart?.();
      this.clearStartTimer();
      const audioTracks = this.peer
        ?.getReceivers()
        .filter((receiver) => receiver.track.kind === 'audio').length ?? 0;
      this.opts.onStatus(`GPT-Live aktiv · Übersetzung läuft · Audio-Spuren: ${audioTracks}`);
      // Der Audiotrack kommt meist mit oder kurz nach session.started. Falls
      // nach 10 s immer noch keiner da ist, liegt der Fehler im Audiopfad –
      // das wird jetzt als Status sichtbar, statt still zu bleiben.
      this.audioWatchdog = window.setTimeout(() => {
        if (!this.stopped && this.ready && this.remoteAudio === null) {
          this.opts.onStatus('Verbunden, aber kein Zielton vom Server · Untertitel laufen weiter');
        }
      }, 10_000);
    } else if (event.kind === 'transcript') {
      if (event.event.lane === 'source' && !this.opts.inputTranscriptionEnabled) return;
      this.opts.onTranscript(event.event);
    } else if (event.kind === 'usage') {
      this.opts.onUsage?.(event.seconds);
    } else if (event.kind === 'closed') {
      const expected = this.closing;
      this.sessionClosed = true;
      if (event.usageSeconds !== null) this.opts.onUsage?.(event.usageSeconds);
      const detail = closeDetail(event.reason);
      if (!expected) {
        this.failure = new Error(detail);
        // clearTimers also clears the startup callbacks. Settle its promise
        // first when the server closes before session.started.
        this.rejectStart?.(this.failure);
      }
      this.clearTimers();
      this.setReady(false);
      this.resolveClosed?.();
      this.resolveClosed = null;
      this.rejectClosed = null;
      if (!expected) {
        this.stop();
        // Until start() resolves, its rejection carries the failure.
        if (this.started) this.opts.onError(detail, recoverableClose(event.reason));
      }
    } else if (event.kind === 'delegation') {
      this.rejectedDelegations += 1;
      if (this.rejectedDelegations > 2) {
        this.fail('GPT-Live verlässt den Übersetzungsmodus wiederholt.', true);
        return;
      }
      if (!this.steer('instructions', TRANSLATION_PROFILE.delegationRecovery, 'translation_only', event.id)) {
        this.fail('Der Übersetzungsmodus konnte nicht wiederhergestellt werden.', true);
      }
    } else if (event.kind === 'error') {
      if (!this.ready) {
        // Before session.started an error means the session never became usable.
        this.fail(event.detail, false);
      } else {
        // Rejected commands and moderation cut-offs leave the session running.
        // A real termination still arrives as session.closed or a transport end.
        console.warn('[live-translate] GPT-Live meldet:', event.code ?? '', event.detail);
        this.opts.onWarning?.(event.detail);
      }
    }
  }

  private waitForStart(): Promise<void> {
    if (this.stopped) return Promise.reject(this.failure ?? new Error('Die GPT-Live-Sitzung wurde beendet.'));
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.startTimer = window.setTimeout(() => {
        this.clearStartTimer();
        reject(new SessionRequestError('GPT-Live hat die Sitzung nicht rechtzeitig gestartet.', true));
      }, START_TIMEOUT_MS);
    });
  }

  /** Zustandsbild für den Ton-Monitor im Popup (nur Flags, kein Audio-Zugriff). */
  audioHealth(): { attached: boolean; live: boolean; muted: boolean; signal: boolean } {
    if (this.meter) this.meter.getFloatTimeDomainData(this.meterSamples);
    const signal = this.meter !== null && this.outputActivity.update(this.meterSamples, performance.now());
    const track = this.lastTrack;
    if (track === null || this.remoteAudio === null) {
      return { attached: false, live: false, muted: false, signal: false };
    }
    return { attached: true, live: track.readyState === 'live', muted: track.muted,
      signal: track.readyState === 'live' && !track.muted && signal };
  }

  isReady(): boolean {
    return this.ready;
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.opts.onReadyChange(ready);
  }

  private fail(detail: string, recoverable: boolean): void {
    if (this.stopped) return;
    this.failure = recoverable ? new Error(detail) : new SessionRequestError(detail, false);
    this.rejectClosed?.(this.failure);
    this.rejectClosed = null;
    this.resolveClosed = null;
    this.stop();
    // Until start() resolves, its rejection carries the failure; reporting it
    // twice would let a caller retry and fail the same attempt at once.
    if (this.started) this.opts.onError(detail, recoverable);
  }

  private clearStartTimer(): void {
    this.rejectStart = null;
    this.resolveStart = null;
    if (this.startTimer === null) return;
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearTimers(): void {
    this.clearStartTimer();
    this.clearReceiverTimer();
    this.clearDisconnectTimer();
    if (this.audioWatchdog !== null) window.clearTimeout(this.audioWatchdog);
    this.audioWatchdog = null;
  }

  private clearReceiverTimer(): void {
    if (this.receiverTimer === null) return;
    window.clearInterval(this.receiverTimer);
    this.receiverTimer = null;
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer === null) return;
    window.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }
}

function waitForIceGathering(connection: RTCPeerConnection, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Die GPT-Live-Sitzung wurde beendet.'));
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('WebRTC konnte keine ICE-Kandidaten für GPT-Live sammeln.'));
    }, timeoutMs);
    const onState = () => {
      if (connection.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Die GPT-Live-Sitzung wurde beendet.'));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', onState);
      signal.removeEventListener('abort', onAbort);
    };
    connection.addEventListener('icegatheringstatechange', onState);
    signal.addEventListener('abort', onAbort, { once: true });
    onState();
  });
}

async function responseError(response: Response): Promise<{ detail: string; retryable: boolean }> {
  let detail = '';
  let retryable: boolean | null = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      if ('error' in body && typeof body.error === 'string') detail = body.error;
      if ('retryable' in body && typeof body.retryable === 'boolean') retryable = body.retryable;
    }
  } catch {
    // Ein nicht-JSON-Fehler wird absichtlich nicht ungefiltert ins Popup gegeben.
  }
  return {
    detail: detail || `Der GPT-Live-Server hat die Sitzung abgelehnt (HTTP ${response.status}).`,
    // Without an explicit verdict, only gateway/server failures are worth retrying.
    retryable: retryable ?? (response.status >= 500 || response.status === 429)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
