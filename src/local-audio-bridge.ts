/** Local-only peer connection: no STUN/TURN servers and no external signaling. */
export async function gatherLocalDescription(peer: RTCPeerConnection): Promise<string> {
  if (peer.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Lokale Audioverbindung: ICE-Timeout.')), 5000);
      const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
      function finish(error?: Error) {
        clearTimeout(timer);
        peer.removeEventListener('icegatheringstatechange', changed);
        if (error) reject(error); else resolve();
      }
      peer.addEventListener('icegatheringstatechange', changed);
      changed();
    });
  }
  const sdp = peer.localDescription?.sdp;
  if (!sdp) throw new Error('Lokale Audioverbindung ohne SDP.');
  return sdp;
}

export function validAudioSdp(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('v=0') && value.length < 65_536;
}
