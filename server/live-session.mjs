import { DUBBING_PROMPT, DUBBING_VOICE } from './dubbing-prompt.mjs';

export const LIVE_VOICES = new Set(['marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder']);

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function parseSessionRequest(value) {
  const request = asRecord(value);
  if (!request || typeof request.sdp !== 'string' || !request.sdp.trim() || request.sdp.length > 65_536) {
    return null;
  }
  if (request.voice !== undefined && !LIVE_VOICES.has(request.voice)) return null;
  return request.voice === undefined ? { sdp: request.sdp } : { sdp: request.sdp, voice: request.voice };
}

/** Server-owned configuration; browser content cannot override the interpreter. */
export function createLiveSessionConfig(request) {
  return {
    session: {
      model: 'gpt-live-1',
      instructions: DUBBING_PROMPT,
      audio: {
        output: {
          voice: LIVE_VOICES.has(request.voice) ? request.voice : DUBBING_VOICE
        }
      },
      delegation: {
        type: 'responses',
        responses: {
          parallel_tool_calls: false,
          model: 'gpt-5.6-terra',
          reasoning: {
            effort: 'medium'
          },
          tools: [
            {
              type: 'web_search'
            }
          ]
        }
      }
    },
    transport: { type: 'webrtc', sdp: request.sdp }
  };
}
