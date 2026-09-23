import type { TranscriptEvent } from '../messages';

export interface LiveSessionAnswer {
  sessionId: string;
  sdp: string;
}

export type LiveServerEvent =
  | { kind: 'started'; sessionId: string }
  | { kind: 'closed' }
  | { kind: 'transcript'; event: TranscriptEvent }
  | { kind: 'error'; detail: string }
  | { kind: 'ignored' };

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestampValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Validiert die kleine, browserseitig benötigte Antwort des eigenen Backends. */
export function parseLiveSessionAnswer(value: unknown): LiveSessionAnswer | null {
  const result = recordValue(value);
  const session = result && recordValue(result.session);
  const transport = result && recordValue(result.transport);
  const sessionId = session && stringValue(session.id);
  const sdp = transport && stringValue(transport.sdp);
  return sessionId && sdp ? { sessionId, sdp } : null;
}

/** WebRTC trägt Audio; der Datenkanal liefert nur Status und Transkripte. */
export function parseLiveServerEvent(value: unknown): LiveServerEvent {
  const event = recordValue(value);
  const type = event && stringValue(event.type);
  if (!event || !type) return { kind: 'ignored' };
  if (type === 'session.started') {
    const session = recordValue(event.session);
    const sessionId = session && stringValue(session.id);
    return sessionId ? { kind: 'started', sessionId } : { kind: 'ignored' };
  }
  if (type === 'session.closed') return { kind: 'closed' };
  if (type === 'session.input_transcript.delta' || type === 'session.output_transcript.delta') {
    // Preserve the delta byte-for-byte. In particular, do not trim spaces at
    // chunk boundaries: GPT-Live emits exact incremental transcript text.
    if (typeof event.delta !== 'string' || event.delta.length === 0) return { kind: 'ignored' };
    return {
      kind: 'transcript',
      event: {
        kind: 'chunk',
        lane: type === 'session.input_transcript.delta' ? 'source' : 'target',
        text: event.delta,
        startMs: timestampValue(event.start_ms),
        endMs: timestampValue(event.end_ms)
      }
    };
  }
  if (type === 'error') {
    const error = recordValue(event.error);
    const detail = stringValue(error?.message) ?? stringValue(event.message);
    return detail ? { kind: 'error', detail } : { kind: 'error', detail: 'GPT-Live hat die Sitzung abgelehnt.' };
  }
  return { kind: 'ignored' };
}

export function liveSessionEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/api/live/session`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
