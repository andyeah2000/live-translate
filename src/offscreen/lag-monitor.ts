import type { TranscriptEvent } from '../messages';

/** Speech-to-speech delay of the German voice on GPT-Live's session timeline. */
export interface LagEstimate {
  lagMs: number;
  /** Target timeline position of the newest evidence. */
  atMs: number;
  basis: 'anchor' | 'pause';
}

interface SourceToken {
  key: string;
  exact: boolean;
  ms: number;
}

interface PendingTarget {
  word: string;
  ms: number;
}

/** Shared prefix that survives English→German inflection (robot/Roboter, Tesla/Teslas). */
const KEY_LENGTH = 5;
const SOURCE_WINDOW_MS = 30_000;
/** A translation cannot start before the source word was spoken. */
const MIN_REACTION_MS = 150;
/** Input transcription trails the audio; wait this long for a target's source word. */
const PENDING_TIMEOUT_MS = 4_000;
const ESTIMATE_WINDOW_MS = 10_000;
/** Longer than the input-transcription delay, so silence is real and not just pending text. */
const PAUSE_EVIDENCE_MS = 3_000;
const MAX_SAMPLES = 9;

export function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ph/g, 'f')
    .replace(/c/g, 'k');
}

/**
 * Words that tend to reappear unchanged in the German rendering: names and
 * other mid-sentence capitals, and long words, which are usually cognates.
 */
export function sourceAnchor(word: string, sentenceStart: boolean): { key: string; exact: boolean } | null {
  const normalized = normalizeWord(word);
  if (!/^\p{L}+$/u.test(normalized)) return null;
  const capitalized = !sentenceStart && /^\p{Lu}/u.test(word) && word !== 'I';
  if (normalized.length >= 7 || (capitalized && normalized.length >= KEY_LENGTH)) {
    return { key: normalized.slice(0, KEY_LENGTH), exact: false };
  }
  if (capitalized && normalized.length === 4) return { key: normalized, exact: true };
  return null;
}

function matches(token: SourceToken, target: string): boolean {
  if (!target.startsWith(token.key)) return false;
  // Four-letter names (Mars, Grok) allow a short German ending but not a new word (Marsch…).
  return !token.exact || target.length <= token.key.length + 1;
}

/**
 * Aligns the English input transcript with the German output transcript.
 * Both carry timestamps on the same session timeline, so a shared word yields a
 * direct lag sample. A long German tail after the source stopped is a lower bound.
 */
export class LagMonitor {
  private source: SourceToken[] = [];
  /** Source tokens before this index were matched or deliberately skipped. */
  private sourceCursor = 0;
  private pending: PendingTarget[] = [];
  private samples: LagEstimate[] = [];
  private sourceEndMs = -Infinity;
  private targetEndMs = -Infinity;
  private sourceSentenceStart = true;

  observe(event: TranscriptEvent): LagEstimate | null {
    if (event.kind !== 'chunk' || event.startMs === undefined) return null;
    const startMs = event.startMs;
    const endMs = Math.max(startMs, event.endMs ?? startMs);
    const words = [...event.text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?|[.!?]/gu)];
    const textLength = Math.max(1, event.text.length);
    for (const match of words) {
      const word = match[0];
      const ms = startMs + (endMs - startMs) * ((match.index ?? 0) / textLength);
      if (event.lane === 'source') {
        if (/^[.!?]$/.test(word)) {
          this.sourceSentenceStart = true;
          continue;
        }
        const anchor = sourceAnchor(word, this.sourceSentenceStart);
        this.sourceSentenceStart = false;
        if (anchor) this.source.push({ ...anchor, ms });
      } else if (!/^[.!?]$/.test(word)) {
        const normalized = normalizeWord(word);
        if (normalized.length >= 4) this.pending.push({ word: normalized, ms });
      }
    }
    if (event.lane === 'source') this.sourceEndMs = Math.max(this.sourceEndMs, endMs);
    else this.targetEndMs = Math.max(this.targetEndMs, endMs);
    this.matchPending();
    this.prune();
    if (event.lane === 'target') this.addPauseEvidence();
    return this.estimate();
  }

  /**
   * The source is still talking: its newest transcript is about as recent as
   * the German output. Catch-up only makes sense while the backlog can grow;
   * after the speaker stops, the German must finish the pending sentences.
   */
  sourceActive(): boolean {
    return this.targetEndMs - this.sourceEndMs < PAUSE_EVIDENCE_MS - 500;
  }

  /** Newest robust estimate, or null without recent evidence. */
  estimate(): LagEstimate | null {
    const recent = this.samples.filter(sample => sample.atMs >= this.targetEndMs - ESTIMATE_WINDOW_MS);
    if (!recent.length) return null;
    const anchors = recent.filter(sample => sample.basis === 'anchor').map(sample => sample.lagMs).sort((a, b) => a - b);
    const pause = recent.filter(sample => sample.basis === 'pause').at(-1);
    const median = anchors.length ? anchors[Math.floor(anchors.length / 2)]! : null;
    const newest = recent.at(-1)!;
    if (pause && (median === null || pause.lagMs > median)) return { ...pause, atMs: newest.atMs };
    return { lagMs: median!, atMs: newest.atMs, basis: 'anchor' };
  }

  /**
   * After a catch-up instruction the model skips its backlog. Earlier evidence
   * and not yet rendered source words must not be matched against later output.
   */
  skipBacklog(): void {
    const cutoff = this.sourceEndMs - 1_000;
    while (this.sourceCursor < this.source.length && this.source[this.sourceCursor]!.ms < cutoff) this.sourceCursor++;
    this.samples = [];
    this.pending = [];
  }

  /** A new GPT-Live session starts a new timeline. */
  reset(): void {
    this.source = [];
    this.sourceCursor = 0;
    this.pending = [];
    this.samples = [];
    this.sourceEndMs = -Infinity;
    this.targetEndMs = -Infinity;
    this.sourceSentenceStart = true;
  }

  private matchPending(): void {
    const remaining: PendingTarget[] = [];
    for (const target of this.pending) {
      let found = -1;
      // Prefer the newest candidate: after a skip, an older homonym would
      // overstate the delay, while a newer one can at most understate it.
      for (let index = this.source.length - 1; index >= this.sourceCursor; index--) {
        const token = this.source[index]!;
        if (token.ms > target.ms - MIN_REACTION_MS) continue;
        if (token.ms < target.ms - SOURCE_WINDOW_MS) break;
        if (matches(token, target.word)) {
          found = index;
          break;
        }
      }
      if (found >= 0) {
        this.sourceCursor = found + 1;
        this.addSample({ lagMs: target.ms - this.source[found]!.ms, atMs: target.ms, basis: 'anchor' });
      } else if (this.sourceEndMs < target.ms + PENDING_TIMEOUT_MS && target.ms > this.targetEndMs - PENDING_TIMEOUT_MS) {
        remaining.push(target);
      }
    }
    this.pending = remaining;
  }

  private addPauseEvidence(): void {
    const silence = this.targetEndMs - this.sourceEndMs;
    if (Number.isFinite(silence) && silence >= PAUSE_EVIDENCE_MS) {
      this.addSample({ lagMs: silence, atMs: this.targetEndMs, basis: 'pause' });
    }
  }

  private addSample(sample: LagEstimate): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  private prune(): void {
    const horizon = Math.max(this.sourceEndMs, this.targetEndMs) - SOURCE_WINDOW_MS * 2;
    let drop = 0;
    while (drop < this.source.length && this.source[drop]!.ms < horizon) drop++;
    if (drop > 0) {
      this.source.splice(0, drop);
      this.sourceCursor = Math.max(0, this.sourceCursor - drop);
    }
  }
}
