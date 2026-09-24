import { DUBBING_PROMPT, DUBBING_VOICE, TRANSLATION_PROFILE } from './dubbing-prompt.mjs';

export const LIVE_VOICES = new Set(TRANSLATION_PROFILE.voices);

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
      model: TRANSLATION_PROFILE.model,
      instructions: DUBBING_PROMPT,
      store: false,
      audio: {
        output: {
          voice: LIVE_VOICES.has(request.voice) ? request.voice : DUBBING_VOICE
        }
      },
      delegation: { type: 'client' }
    },
    transport: { type: 'webrtc', sdp: request.sdp }
  };
}
