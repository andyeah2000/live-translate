import type { TranscriptEvent } from '../messages';
import { TRANSLATION_PROFILE } from '../translation-profile';
import { rampAudioParam } from './audio-envelope';
import { GptLiveTranslator, type GptLiveTranslatorOptions } from './live';
import { LagMonitor, type LagEstimate } from './lag-monitor';

/** Above this delay GPT-Live gets silent context to condense; it keeps speaking. */
export const TIGHTEN_LAG_MS = 5_000;
/** Above this delay the backlog is dropped at the next German sentence end. */
export const SKIP_LAG_MS = 9_000;
/** If a skip does not bring the delay down, a fresh session takes over. */
export const ROTATE_LAG_MS = 14_000;
const TIGHTEN_COOLDOWN_MS = 6_000;
const SKIP_COOLDOWN_MS = 10_000;
/** A pending skip accepts a clause boundary after this wait, and any word after the hard limit. */
const SKIP_CLAUSE_WAIT_MS = 1_500;
const SKIP_BOUNDARY_WAIT_MS = 5_000;
const ROTATE_AFTER_SKIP_MS = 8_000;
const ROTATE_COOLDOWN_MS = 30_000;
const SENTENCE_END = /[.!?…]["'»«“”)]*\s*$/;
const CLAUSE_END = /[,;:–—]\s*$/;
const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000];
/** A connection that ran this long proves the configuration; its failures restart the backoff. */
const STABLE_CONNECTION_MS = 60_000;
const MAX_RECONNECTS_PER_WINDOW = 8;
const RECONNECT_WINDOW_MS = 5 * 60_000;
const HANDOVER_FADE_S = 0.25;

export interface LiveTelemetry {
  /** Measured speech-to-speech delay, null without recent evidence. */
  lagMs: number | null;
  /** Billed GPT-Live voice seconds across all sessions of this translation. */
  usageSeconds: number;
  reconnects: number;
}

export interface LiveSessionOptions extends Omit<GptLiveTranslatorOptions, 'outputNode' | 'onError' | 'onUsage' | 'onWarning'> {
  outputNode: AudioNode;
  /** Terminal: the translation cannot continue without user action. */
  onError: (detail: string) => void;
  onTelemetry?: (telemetry: LiveTelemetry) => void;
  /** Test seam for the per-connection adapter. */
  createTranslator?: (options: GptLiveTranslatorOptions) => LiveConnection;
  now?: () => number;
}

/** The subset of GptLiveTranslator the manager relies on. */
export interface LiveConnection {
  start(): Promise<void>;
  finishInput(timeoutMs?: number): Promise<void>;
  stop(): void;
  audioHealth(): { attached: boolean; live: boolean; muted: boolean; signal: boolean };
  steer(channel: 'instructions' | 'thinking', content: string, purpose?: string, delegationId?: string | null): boolean;
  replaceInput(stream: MediaStream): Promise<void>;
}

interface Slot {
  connection: LiveConnection;
  gain: GainNode;
  readyAt: number | null;
  usageSeconds: number;
}

/**
 * Continuous translation over a sequence of GPT-Live sessions: reconnects
 * after provider limits or network loss and bounds the interpretation delay.
 */
export class LiveSession {
  private active: Slot | null = null;
  private standby: Slot | null = null;
  private readonly monitor = new LagMonitor();
  private inputStream: MediaStream;
  private stopped = false;
  private finishing = false;
  private ready = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failedAttempts = 0;
  private reconnectTimes: number[] = [];
  private reconnects = 0;
  private finishedUsageSeconds = 0;
  private lagMs: number | null = null;
  private lastTighten = -Infinity;
  private lastSkip = -Infinity;
  /** Target-timeline time since which a skip waits for a sentence boundary. */
  private skipPendingSince: number | null = null;
  private lastRotation = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: LiveSessionOptions) {
    this.inputStream = opts.inputStream;
    this.now = opts.now ?? (() => performance.now());
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Die GPT-Live-Sitzung wurde beendet.');
    const slot = this.createSlot();
    this.active = slot;
    try {
      await slot.connection.start();
    } catch (error) {
      if (this.active === slot) this.active = null;
      this.disposeSlot(slot);
      throw error;
    }
    if (this.stopped || this.active !== slot) throw new Error('Die GPT-Live-Sitzung wurde beendet.');
  }

  async finishInput(timeoutMs = 15_000): Promise<void> {
    this.finishing = true;
    this.clearReconnect();
    const standby = this.standby;
    this.standby = null;
    if (standby) this.disposeSlot(standby);
    const active = this.active;
    if (!active) throw new Error('GPT-Live wurde ohne aktive Sitzung beendet (unvollständige Finalisierung).');
    await active.connection.finishInput(timeoutMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    for (const slot of [this.active, this.standby]) if (slot) this.disposeSlot(slot);
    this.active = null;
    this.standby = null;
    this.setReady(false);
  }

  audioHealth(): { attached: boolean; live: boolean; muted: boolean; signal: boolean } {
    return this.active?.connection.audioHealth() ?? { attached: false, live: false, muted: false, signal: false };
  }

  /** Switch the provider input, e.g. from direct video audio to tab audio, without a new session. */
  async replaceInput(stream: MediaStream): Promise<void> {
    this.inputStream = stream;
    await Promise.all([this.active, this.standby].map(slot => slot?.connection.replaceInput(stream)));
  }

  telemetry(): LiveTelemetry {
    const current = (this.active?.usageSeconds ?? 0) + (this.standby?.usageSeconds ?? 0);
    return { lagMs: this.lagMs, usageSeconds: this.finishedUsageSeconds + current, reconnects: this.reconnects };
  }

  private createSlot(): Slot {
    const gain = this.opts.ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.opts.outputNode);
    const slot: Slot = { connection: null as unknown as LiveConnection, gain, readyAt: null, usageSeconds: 0 };
    const isCurrent = () => !this.stopped && this.active === slot;
    const options: GptLiveTranslatorOptions = {
      ctx: this.opts.ctx,
      inputStream: this.inputStream,
      outputNode: gain,
      serverUrl: this.opts.serverUrl,
      serverToken: this.opts.serverToken,
      voice: this.opts.voice,
      inputTranscriptionEnabled: this.opts.inputTranscriptionEnabled,
      onTranscript: event => {
        if (isCurrent()) this.handleTranscript(event);
      },
      onStatus: status => {
        if (isCurrent()) this.opts.onStatus(status);
      },
      onReadyChange: ready => {
        if (ready) slot.readyAt = this.now();
        if (ready && this.standby === slot) {
          this.handOver(slot);
          return;
        }
        if (isCurrent()) this.setReady(ready);
      },
      onError: (detail, recoverable) => this.handleConnectionEnd(slot, detail, recoverable),
      onWarning: detail => {
        if (isCurrent()) this.opts.onStatus(`GPT-Live-Hinweis: ${detail}`);
      },
      onUsage: seconds => {
        slot.usageSeconds = Math.max(slot.usageSeconds, seconds);
        if (isCurrent()) this.publishTelemetry();
      }
    };
    slot.connection = (this.opts.createTranslator ?? (o => new GptLiveTranslator(o)))(options);
    return slot;
  }

  private disposeSlot(slot: Slot): void {
    this.finishedUsageSeconds += slot.usageSeconds;
    slot.usageSeconds = 0;
    // Teardown of one slot must never prevent releasing the other.
    try {
      slot.connection.stop();
    } catch (error) {
      console.warn('[live-translate] GPT-Live-Verbindung konnte nicht sauber beendet werden:', error);
    }
    try {
      slot.gain.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  private handleTranscript(event: TranscriptEvent): void {
    this.opts.onTranscript(event);
    const estimate = this.monitor.observe(event);
    if (event.kind !== 'chunk' || event.lane !== 'target') return;
    if (estimate) this.updateLag(estimate.lagMs);
    const boundary = SENTENCE_END.test(event.text) ? 'sentence' : CLAUSE_END.test(event.text) ? 'clause' : null;
    this.regulate(estimate, boundary, event.endMs ?? event.startMs ?? 0);
  }

  private updateLag(lagMs: number): void {
    const previous = this.lagMs;
    this.lagMs = lagMs;
    if (previous === null || Math.abs(previous - lagMs) >= 250) this.publishTelemetry();
  }

  /**
   * Three-stage delay control while the source keeps talking:
   * 1. silent context makes GPT-Live condense without cutting its sentence,
   * 2. a backlog is dropped exactly at a German sentence end,
   * 3. a fresh session takes over if the delay still does not shrink.
   */
  private regulate(estimate: LagEstimate | null, boundary: 'sentence' | 'clause' | null, targetMs: number): void {
    const active = this.active;
    if (!active || this.finishing || this.standby) return;
    if (!this.monitor.sourceActive()) {
      // The speaker paused: never cut the German that finishes the last sentences.
      this.skipPendingSince = null;
      return;
    }
    const now = this.now();
    const lagMs = estimate?.lagMs ?? 0;
    if (this.skipPendingSince !== null) {
      const waited = targetMs - this.skipPendingSince;
      if (
        boundary === 'sentence' ||
        (boundary === 'clause' && waited >= SKIP_CLAUSE_WAIT_MS) ||
        waited >= SKIP_BOUNDARY_WAIT_MS
      ) {
        this.skip(active, now);
      }
      return;
    }
    if (
      lagMs >= ROTATE_LAG_MS &&
      now - this.lastSkip >= ROTATE_AFTER_SKIP_MS &&
      this.lastSkip > this.lastRotation &&
      now - this.lastRotation >= ROTATE_COOLDOWN_MS
    ) {
      this.rotate();
    } else if (lagMs >= SKIP_LAG_MS && now - this.lastSkip >= SKIP_COOLDOWN_MS) {
      if (boundary === 'sentence') this.skip(active, now);
      else this.skipPendingSince = targetMs;
    } else if (lagMs >= TIGHTEN_LAG_MS && now - this.lastTighten >= TIGHTEN_COOLDOWN_MS) {
      const seconds = String(Math.round(lagMs / 1000));
      if (active.connection.steer('thinking', TRANSLATION_PROFILE.catchUpTighten.replace('{seconds}', seconds), 'pace')) {
        this.lastTighten = now;
      }
    }
  }

  private skip(active: Slot, now: number): void {
    this.skipPendingSince = null;
    if (!active.connection.steer('instructions', TRANSLATION_PROFILE.catchUpSkip, 'catch_up')) return;
    this.lastSkip = now;
    this.lastTighten = now;
    this.monitor.skipBacklog();
    this.lagMs = null;
  }

  /** Start a replacement while the lagging session keeps speaking; switch at session.started. */
  private rotate(): void {
    this.lastRotation = this.now();
    const slot = this.createSlot();
    this.standby = slot;
    this.opts.onStatus('Übersetzung holt auf · neue GPT-Live-Sitzung startet');
    void slot.connection.start().catch((error: unknown) => {
      if (this.standby !== slot) return;
      this.standby = null;
      this.disposeSlot(slot);
      console.warn('[live-translate] Aufhol-Sitzung konnte nicht starten:', error);
    });
  }

  private handOver(slot: Slot): void {
    const previous = this.active;
    this.standby = null;
    this.active = slot;
    this.reconnects++;
    this.resetTimeline();
    this.setReady(true);
    if (previous) {
      const ctx = this.opts.ctx;
      rampAudioParam(previous.gain.gain, 0, ctx.currentTime, HANDOVER_FADE_S);
      // Close gracefully for final usage; the faded session can no longer be heard.
      void previous.connection.finishInput(3_000).catch(() => {}).finally(() => this.disposeSlot(previous));
    }
    this.publishTelemetry();
  }

  private handleConnectionEnd(slot: Slot, detail: string, recoverable: boolean): void {
    if (this.stopped) return;
    if (this.standby === slot) {
      this.standby = null;
      this.disposeSlot(slot);
      return;
    }
    if (this.active !== slot) return;
    this.active = null;
    this.disposeSlot(slot);
    this.setReady(false);
    if (this.finishing) return;
    const stable = slot.readyAt !== null && this.now() - slot.readyAt >= STABLE_CONNECTION_MS;
    if (stable) this.failedAttempts = 0;
    if (!recoverable) {
      this.fail(detail);
      return;
    }
    console.warn('[live-translate] GPT-Live-Sitzung endete, verbinde neu:', detail);
    this.scheduleReconnect(detail);
  }

  private scheduleReconnect(lastDetail: string): void {
    const now = this.now();
    this.reconnectTimes = this.reconnectTimes.filter(time => now - time < RECONNECT_WINDOW_MS);
    if (this.failedAttempts >= RECONNECT_DELAYS_MS.length || this.reconnectTimes.length >= MAX_RECONNECTS_PER_WINDOW) {
      this.fail(`${lastDetail} Automatische Wiederverbindung fehlgeschlagen. Bitte neu starten.`);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.failedAttempts]!;
    this.failedAttempts++;
    this.reconnectTimes.push(now);
    this.resetTimeline();
    this.opts.onStatus('Verbindung wird erneuert…');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(lastDetail);
    }, delay);
  }

  private async reconnect(lastDetail: string): Promise<void> {
    if (this.stopped || this.finishing) return;
    const slot = this.createSlot();
    this.active = slot;
    try {
      await slot.connection.start();
      if (this.active !== slot || this.stopped) return;
      this.reconnects++;
      this.publishTelemetry();
    } catch (error) {
      if (this.active !== slot || this.stopped) return;
      this.active = null;
      this.disposeSlot(slot);
      const detail = error instanceof Error ? error.message : String(error);
      if (!GptLiveTranslator.isRetryable(error)) {
        this.fail(detail);
        return;
      }
      this.scheduleReconnect(detail || lastDetail);
    }
  }

  /** Close open subtitle lines and forget alignment; a new session restarts its timeline at zero. */
  private resetTimeline(): void {
    this.monitor.reset();
    this.lagMs = null;
    this.skipPendingSince = null;
    this.opts.onTranscript({ kind: 'complete', lane: 'source' });
    this.opts.onTranscript({ kind: 'complete', lane: 'target' });
  }

  private fail(detail: string): void {
    this.stop();
    this.opts.onError(detail);
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.opts.onReadyChange(ready);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private publishTelemetry(): void {
    this.opts.onTelemetry?.(this.telemetry());
  }
}
