import type { TranscriptEvent, TranscriptLane } from './messages';

export interface SubtitleSnapshot {
  upper: string;
  lower: string;
}

interface LaneState {
  current: string;
  final: string;
  lastUpdate: number;
  startMs: number | undefined;
  endMs: number | undefined;
}

export interface SubtitleStateOptions {
  maxLineLength?: number;
  segmentGapMs?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 140;
const DEFAULT_SEGMENT_GAP_MS = 2_500;

/**
 * Pure subtitle state shared by overlay and native fullscreen rendering.
 * Source and target never overwrite one another.
 */
export class SubtitleState {
  private readonly source: LaneState = {
    current: '',
    final: '',
    lastUpdate: 0,
    startMs: undefined,
    endMs: undefined
  };
  private readonly target: LaneState = {
    current: '',
    final: '',
    lastUpdate: 0,
    startMs: undefined,
    endMs: undefined
  };
  private readonly maxLineLength: number;
  private readonly segmentGapMs: number;

  constructor(options: SubtitleStateOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.segmentGapMs = options.segmentGapMs ?? DEFAULT_SEGMENT_GAP_MS;
  }

  apply(event: TranscriptEvent, now = Date.now()): SubtitleSnapshot {
    const lane = this.lane(event.lane);
    switch (event.kind) {
      case 'chunk':
        if (this.startsNewSegment(lane, event.startMs, now)) {
          this.finalizeLane(event.lane);
        }
        lane.lastUpdate = now;
        lane.current += event.text;
        if (typeof event.startMs === 'number' && Number.isFinite(event.startMs)) {
          lane.startMs = lane.startMs ?? event.startMs;
        }
        if (typeof event.endMs === 'number' && Number.isFinite(event.endMs)) {
          lane.endMs = Math.max(lane.endMs ?? event.endMs, event.endMs);
        } else if (lane.startMs !== undefined && lane.endMs === undefined) {
          lane.endMs = lane.startMs;
        }
        this.trimLane(event.lane);
        break;
      case 'complete':
        this.finalizeLane(event.lane);
        break;
      case 'interrupt':
        lane.current = '';
        lane.lastUpdate = 0;
        break;
    }
    return this.snapshot();
  }

  snapshot(): SubtitleSnapshot {
    const sourceLine = this.source.current || this.source.final;
    const targetCurrent = this.target.current;
    const targetFinal = this.target.final;

    if (sourceLine) {
      return { upper: sourceLine, lower: targetCurrent || targetFinal };
    }
    if (targetCurrent) {
      return { upper: targetFinal, lower: targetCurrent };
    }
    return { upper: '', lower: targetFinal };
  }

  hide(): void {
    this.clear();
  }

  clear(): void {
    this.resetLane(this.source);
    this.resetLane(this.target);
  }

  private lane(lane: TranscriptLane): LaneState {
    return lane === 'source' ? this.source : this.target;
  }

  private finalizeLane(laneName: TranscriptLane): void {
    const lane = this.lane(laneName);
    // Keep GPT-Live's exact delta concatenation. Do not trim or inject text at
    // a boundary; the transport already emitted the authoritative spacing.
    const text = lane.current;
    if (text) lane.final = text;
    lane.current = '';
    lane.lastUpdate = 0;
    lane.startMs = undefined;
    lane.endMs = undefined;
    this.trimLane(laneName);
  }

  private startsNewSegment(lane: LaneState, startMs: number | undefined, now: number): boolean {
    if (!lane.current) return false;
    if (typeof startMs === 'number' && Number.isFinite(startMs) && lane.endMs !== undefined) {
      return startMs - lane.endMs > this.segmentGapMs;
    }
    // Legacy/internal events without GPT-Live timestamps retain the old
    // inactivity fallback, but timestamped events are never grouped by turns.
    return now - lane.lastUpdate > this.segmentGapMs;
  }

  private trimLane(laneName: TranscriptLane): void {
    const lane = this.lane(laneName);
    if (laneName === 'source') {
      lane.current = this.keepTail(lane.current);
      lane.final = this.keepTail(lane.final);
      return;
    }

    while (lane.current.length > this.maxLineLength) {
      const boundary = lane.current.lastIndexOf(' ', this.maxLineLength);
      const cut = boundary > 0 ? boundary : this.maxLineLength;
      const head = lane.current.slice(0, cut).trim();
      if (head) lane.final = head;
      lane.current = lane.current.slice(cut).trimStart();
    }
    lane.final = this.keepTail(lane.final);
  }

  private keepTail(text: string): string {
    if (text.length <= this.maxLineLength) return text;
    const cutFrom = text.length - this.maxLineLength;
    const boundary = text.indexOf(' ', cutFrom);
    return text.slice(boundary >= 0 ? boundary + 1 : cutFrom).trimStart();
  }

  private resetLane(lane: LaneState): void {
    lane.current = '';
    lane.final = '';
    lane.lastUpdate = 0;
    lane.startMs = undefined;
    lane.endMs = undefined;
  }
}
