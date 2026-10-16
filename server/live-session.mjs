import { DUBBING_PROMPT, DUBBING_VOICE, TRANSLATION_PROFILE } from './dubbing-prompt.mjs';

export const LIVE_VOICES = new Set(TRANSLATION_PROFILE.voices);

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** SCTP stream IDs for a pre-negotiated data channel (RFC 8831). */
function validDcid(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65_534;
}

export function parseSessionRequest(value) {
  const request = asRecord(value);
  if (!request || typeof request.sdp !== 'string' || !request.sdp.trim() || request.sdp.length > 65_536) {
    return null;
  }
  if (request.voice !== undefined && !LIVE_VOICES.has(request.voice)) return null;
  if (request.dcid !== undefined && !validDcid(request.dcid)) return null;
  const parsed = { sdp: request.sdp };
  if (request.voice !== undefined) parsed.voice = request.voice;
  if (request.dcid !== undefined) parsed.dcid = request.dcid;
  return parsed;
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
    // dcid pre-negotiates the event channel (WARP), saving a round trip at startup.
    transport: request.dcid === undefined
      ? { type: 'webrtc', sdp: request.sdp }
      : { type: 'webrtc', sdp: request.sdp, dcid: request.dcid }
  };
}
