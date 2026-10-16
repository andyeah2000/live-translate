/** Reine Guards für idempotente Offscreen-Nachrichten. */
export function shouldStartOffscreenSession(
  activeSessionId: string | null,
  pendingSessionId: string | null,
  incomingSessionId: string
): boolean {
  return incomingSessionId !== activeSessionId && incomingSessionId !== pendingSessionId;
}

export function belongsToActiveSession(
  activeSessionId: string | null,
  incomingSessionId: string
): boolean {
  return activeSessionId !== null && activeSessionId === incomingSessionId;
}

/** Do not begin a paid translation session until its local audio input connects. */
export function waitForLocalAudioConnection(
  peer: RTCPeerConnection,
  timeoutMs = 6_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Der direkte Videoeingang konnte nicht rechtzeitig verbunden werden.')),
      timeoutMs
    );
    function finish(error?: Error) {
      clearTimeout(timer);
      peer.removeEventListener('connectionstatechange', changed);
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      if (peer.connectionState === 'connected') finish();
      else if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        finish(new Error('Der direkte Videoeingang wurde unterbrochen. Bitte neu starten.'));
      }
    }
    peer.addEventListener('connectionstatechange', changed);
    changed();
  });
}
