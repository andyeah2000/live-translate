import { OutputActivity } from './dubbing-mix';
import type { TranscriptEvent } from '../messages';
import {
  liveSessionEndpoint,
  parseLiveServerEvent,
  parseLiveSessionAnswer
} from './live-protocol';

const ICE_GATHER_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;

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
  onError: (detail: string) => void;
}

/**
 * Browserseitiger GPT-Live-WebRTC-Adapter. Der Standard-API-Key verbleibt beim
 * eigenen Server; diese Klasse kennt nur dessen Zugriffstoken und SDP-Antwort.
 */
export class GptLiveTranslator {
  private peer: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private remoteAudio: MediaStreamAudioSourceNode | null = null;
  private playback: HTMLAudioElement | null = null;
  private meter: AnalyserNode | null = null;
  private meterSamples = new Float32Array(2048);
  private readonly outputActivity = new OutputActivity();
  private readonly requestAbort = new AbortController();
  private startPoll: number | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private stopped = false;
  private closing = false;
  private ready = false;
  private startTimer: number | null = null;
  private receiverTimer: number | null = null;
  private audioWatchdog: number | null = null;
  private attachedTrackIds = new Set<string>();
  private closePromise: Promise<void> = Promise.resolve();
  private resolveClosed: (() => void) | null = null;
  private rejectClosed: ((reason?: unknown) => void) | null = null;
  private sessionClosed = false;
  private lastTrack: MediaStreamTrack | null = null;
  private finishPromise: Promise<void> | null = null;

  constructor(private readonly opts: GptLiveTranslatorOptions) {}

  async start(): Promise<void> {
    try {
      await this.startConnection();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private async startConnection(): Promise<void> {
    if (this.stopped) throw new Error('Die GPT-Live-Sitzung wurde beendet.');
    this.opts.onStatus('Verbinde mit GPT-Live…');
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
      if (this.stopped) return;
      if (
        connection.connectionState === 'failed' ||
        (this.closing && connection.connectionState === 'disconnected')
      ) {
        const detail = this.closing
          ? 'Die GPT-Live-WebRTC-Verbindung wurde vor session.closed getrennt (unvollständige Finalisierung).'
          : 'Die GPT-Live-WebRTC-Verbindung ist fehlgeschlagen.';
        this.fail(detail);
      }
    });

    for (const track of this.opts.inputStream.getAudioTracks()) {
      connection.addTrack(track, this.opts.inputStream);
    }
    if (this.opts.inputStream.getAudioTracks().length === 0) {
      throw new Error('Der Quell-Tab enthält keine Audiospur für GPT-Live.');
    }

    const events = connection.createDataChannel('oai-events');
    this.events = events;
    events.addEventListener('message', ({ data }) => this.handleEvent(data));
    events.addEventListener('close', () => {
      if (this.stopped || this.sessionClosed) return;
      this.fail(
        this.closing
          ? 'Die GPT-Live-Ereignisverbindung wurde vor session.closed getrennt (unvollständige Finalisierung).'
          : 'Die GPT-Live-Ereignisverbindung wurde unerwartet geschlossen.'
      );
    });
    events.addEventListener('error', () => {
      if (this.stopped) return;
      this.fail(
        this.closing
          ? 'Die GPT-Live-Ereignisverbindung ist vor session.closed fehlgeschlagen (unvollständige Finalisierung).'
          : 'Die GPT-Live-Ereignisverbindung ist fehlgeschlagen.'
      );
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection, ICE_GATHER_TIMEOUT_MS, this.requestAbort.signal);
    if (this.stopped) throw new Error('Die GPT-Live-Sitzung wurde beendet.');
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error('Chrome konnte kein WebRTC-Angebot für GPT-Live erzeugen.');

    const answer = await this.createSession(sdp);
    if (this.stopped || connection !== this.peer) return;
    await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await this.waitForStart();
    this.watchReceivers();
  }

  finishInput(timeoutMs = 15_000): Promise<void> {
    this.finishPromise ??= this.closeSession(timeoutMs);
    return this.finishPromise;
  }

  private async closeSession(timeoutMs: number): Promise<void> {
    if (this.stopped || this.closing) return;
    this.closing = true;
    this.setReady(false);
    this.opts.onStatus('GPT-Live-Sitzung wird beendet…');
    const events = this.events;
    if (!events || events.readyState !== 'open') {
      const detail = 'GPT-Live konnte session.close nicht senden (unvollständige Finalisierung).';
      this.fail(detail);
      throw new Error(detail);
    }
    try {
      events.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      const detail = 'GPT-Live konnte session.close nicht senden (unvollständige Finalisierung).';
      this.fail(detail);
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
      const detail =
        'GPT-Live hat session.close nicht mit session.closed bestätigt (unvollständige Finalisierung).';
      this.fail(detail);
      throw new Error(detail);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.requestAbort.abort();
    this.rejectStart?.(new Error('Die GPT-Live-Sitzung wurde beendet.'));
    this.rejectStart = null;
    this.closing = true;
    this.clearTimers();
    this.setReady(false);
    if (!this.sessionClosed) this.rejectClosed?.(new Error('GPT-Live-Sitzung beendet.'));
    else this.resolveClosed?.();
    this.resolveClosed = null;
    this.rejectClosed = null;
    try {
      this.events?.close();
    } catch {
      // Bei einer bereits beendeten Verbindung gibt es nichts aufzuräumen.
    }
    this.events = null;
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
    if (this.playback) {
      this.playback.pause();
      this.playback.srcObject = null;
      this.playback.remove();
      this.playback = null;
    }
  }

  private async createSession(sdp: string): Promise<{ sessionId: string; sdp: string }> {
    const timeout = window.setTimeout(() => this.requestAbort.abort(), 30_000);
    try {
      return await this.requestSession(sdp);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async requestSession(sdp: string): Promise<{ sessionId: string; sdp: string }> {
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
        body: JSON.stringify({ sdp, voice: this.opts.voice })
      });
    } catch {
      throw new Error('Der GPT-Live-Server ist nicht erreichbar. Bitte Server-URL und Netzwerk prüfen.');
    }
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Der GPT-Live-Server hat keine gültige Sitzungsantwort geliefert.');
    }
    const answer = parseLiveSessionAnswer(payload);
    if (!answer) throw new Error('Der GPT-Live-Server hat eine unvollständige Sitzungsantwort geliefert.');
    return answer;
  }

  private attachRemoteAudio(event: RTCTrackEvent): void {
    if (this.stopped || event.track.kind !== 'audio') return;
    // Standardpfad: den vom Event gelieferten Stream nehmen, sonst einen
    // bauen. Nur so ist sicher, dass exakt der verhandelte Track spielt.
    const offered = event.streams.length > 0 ? event.streams[0] : undefined;
    const stream =
      offered !== undefined && offered.getAudioTracks().includes(event.track)
        ? offered
        : new MediaStream([event.track]);
    this.connectTrack(event.track, stream);
  }

  /**
   * Fallback für verlorene Track-Events: Falls die Verhandlung einen
   * Audiotrack liefert, dessen Event nie ankam, wird er hier nachträglich
   * angebunden. Ohne das bliebe die Sitzung bei laufenden Untertiteln stumm.
   */
  private watchReceivers(): void {
    if (this.receiverTimer !== null || this.stopped) return;
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
    if (this.stopped) return;
    try {
      this.remoteAudio?.disconnect();
      console.info(
        `[live-translate] Remote-Audiotrack: readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled}`
      );
      this.remoteAudio = this.opts.ctx.createMediaStreamSource(stream);
      this.meter?.disconnect();
      this.meter = this.opts.ctx.createAnalyser();
      this.meter.fftSize = 2048;
      this.remoteAudio.connect(this.meter).connect(this.opts.outputNode);
      // Keep Chrome's remote media playback active. Only Web Audio is audible,
      // so volume control and mixing have exactly one output path.
      this.playback ??= document.createElement('audio');
      this.playback.autoplay = true;
      this.playback.muted = true;
      this.playback.srcObject = stream;
      if (!this.playback.isConnected) document.body.append(this.playback);
      void this.playback.play().catch(() => {
        if (this.stopped) return;
        this.fail('Chrome konnte die Zielstimme nicht starten. Bitte die Übersetzung neu starten.');
      });
      this.attachedTrackIds.add(track.id);
      this.lastTrack = track;
      this.opts.onStatus(`GPT-Live aktiv · Zielstimme verbunden · Spur ${this.attachedTrackIds.size}`);
      // Manche Tracks starten stumm und liefern erst später Frames. Falls der
      // Track dauerhaft stumm bleibt, wird das sichtbar statt still.
      track.onunmute = () => {
        console.info('[live-translate] Remote-Audiotrack liefert Frames.');
      };
    } catch (error) {
      this.fail(`Die GPT-Live-Audiospur konnte nicht wiedergegeben werden: ${errorMessage(error)}`);
    }
  }

  private handleEvent(data: unknown): void {
    if (this.stopped || typeof data !== 'string' || data.length > 262_144) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const event = parseLiveServerEvent(payload);
    if (event.kind === 'started') {
      if (this.closing) return;
      this.setReady(true);
      // Empfängerstand direkt in den Status: So ist ohne Devtools sichtbar,
      // ob die Antwort überhaupt eine Audiospur enthält.
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
    } else if (event.kind === 'closed') {
      const expected = this.closing;
      this.sessionClosed = true;
      this.clearTimers();
      this.setReady(false);
      this.resolveClosed?.();
      this.resolveClosed = null;
      this.rejectClosed = null;
      if (!expected) {
        this.stop();
        this.opts.onError('GPT-Live hat die Sitzung beendet. Bitte neu starten.');
      }
    } else if (event.kind === 'error') {
      this.fail(event.detail);
    }
  }

  private waitForStart(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.rejectStart = reject;
      this.startTimer = window.setTimeout(() => {
        this.clearStartTimer();
        reject(new Error('GPT-Live hat die Sitzung nicht rechtzeitig gestartet.'));
      }, START_TIMEOUT_MS);
      const wait = () => {
        if (this.ready) {
          this.clearStartTimer();
          resolve();
          return;
        }
        if (this.stopped) {
          this.clearStartTimer();
          reject(new Error('Die GPT-Live-Sitzung wurde beendet.'));
          return;
        }
        this.startPoll = window.setTimeout(wait, 25);
      };
      wait();
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

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.opts.onReadyChange(ready);
  }

  private fail(detail: string): void {
    if (this.stopped) return;
    this.rejectClosed?.(new Error(detail));
    this.rejectClosed = null;
    this.resolveClosed = null;
    this.stop();
    this.opts.onError(detail);
  }

  private clearStartTimer(): void {
    if (this.startPoll !== null) window.clearTimeout(this.startPoll);
    this.startPoll = null;
    if (this.startTimer === null) return;
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearTimers(): void {
    this.clearStartTimer();
    this.clearReceiverTimer();
    if (this.audioWatchdog !== null) window.clearTimeout(this.audioWatchdog);
    this.audioWatchdog = null;
  }

  private clearReceiverTimer(): void {
    if (this.receiverTimer === null) return;
    window.clearInterval(this.receiverTimer);
    this.receiverTimer = null;
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

async function responseError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      detail = body.error;
    }
  } catch {
    // Ein nicht-JSON-Fehler wird absichtlich nicht ungefiltert ins Popup gegeben.
  }
  return detail || `Der GPT-Live-Server hat die Sitzung abgelehnt (HTTP ${response.status}).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
