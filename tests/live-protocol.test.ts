import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLiveServerEvent, parseLiveSessionAnswer, liveSessionEndpoint } from '../src/offscreen/live-protocol';

test('parses the opaque Live session id and WebRTC SDP answer', () => {
  assert.deepEqual(
    parseLiveSessionAnswer({ session: { id: 'sess_123' }, transport: { sdp: 'v=0\r\n' } }),
    { sessionId: 'sess_123', sdp: 'v=0\r\n' }
  );
  assert.equal(parseLiveSessionAnswer({ session: { id: 'sess_123' } }), null);
});

test('preserves transcript delta text and media timestamps exactly', () => {
  assert.deepEqual(
    parseLiveServerEvent({
      type: 'session.output_transcript.delta',
      delta: ' hallo ',
      start_ms: 120,
      end_ms: 240
    }),
    {
      kind: 'transcript',
      event: { kind: 'chunk', lane: 'target', text: ' hallo ', startMs: 120, endMs: 240 }
    }
  );
  assert.equal(
    parseLiveServerEvent({ type: 'session.input_transcript.delta', delta: '' }).kind,
    'ignored'
  );
});

test('recognizes session lifecycle events', () => {
  assert.deepEqual(
    parseLiveServerEvent({ type: 'session.started', session: { id: 'sess_1' } }),
    { kind: 'started', sessionId: 'sess_1' }
  );
  assert.deepEqual(parseLiveServerEvent({ type: 'session.closed' }), { kind: 'closed' });
});

test('builds the extension backend endpoint without leaking query fragments', () => {
  assert.equal(
    liveSessionEndpoint('https://example.test/base/?old=secret#fragment'),
    'https://example.test/base/api/live/session'
  );
});

test('exposes only valid client delegations so the transport can reject tool work', () => {
  assert.deepEqual(parseLiveServerEvent({ type: 'session.delegation.created', delegation: { id: 'task_1' } }),
    { kind: 'delegation', id: 'task_1' });
  assert.deepEqual(parseLiveServerEvent({ type: 'session.delegation.created', delegation: {} }), { kind: 'ignored' });
});
