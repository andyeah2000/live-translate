import { gatherLocalDescription, validAudioSdp } from './local-audio-bridge';

/** Captures the main playing media before its volume/mute, without altering the player. */
export function installMediaInput(): void {
  let peer: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let id: string | null = null;
  let generation = 0;
  const stop = () => {
    generation++;
    peer?.close(); peer = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    id = null;
  };
  const createOffer = async (sessionId: string) => {
    stop();
    const media = [...document.querySelectorAll('video,audio')]
      .filter((element): element is HTMLMediaElement => element instanceof HTMLMediaElement)
      .filter(element => !element.paused && !element.ended && element.readyState >= 2)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const capturable = media as (HTMLMediaElement & { captureStream?: () => MediaStream }) | undefined;
    if (!capturable?.captureStream) throw new Error('Kein direkt zugängliches laufendes Video.');
    id = sessionId;
    stream = capturable.captureStream();
    // Never transfer video frames; stop their capture immediately.
    stream.getVideoTracks().forEach(track => { track.stop(); stream?.removeTrack(track); });
    if (!stream.getAudioTracks().length) throw new Error('Video liefert keine direkte Audiospur.');
    const connection = new RTCPeerConnection({ iceServers: [] });
    peer = connection;
    stream.getAudioTracks().forEach(track => {
      connection.addTrack(track, stream!);
      // A media source replacement can end captured tracks without changing ICE.
      // Close the bridge so the receiver's connection watchdog sees the loss.
      track.onended = () => { if (peer === connection) stop(); };
    });
    await connection.setLocalDescription(await connection.createOffer());
    const sdp = await gatherLocalDescription(connection);
    if (peer !== connection) throw new Error('Audioaufnahme ersetzt.');
    return { sdp };
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'media-input-offer' && typeof message.sessionId === 'string') {
      const pending = createOffer(message.sessionId);
      const expected = generation;
      void pending.then(respond, () => {
        if (generation === expected) stop();
        respond({ unavailable: true });
      });
      return true;
    }
    if (message.type === 'media-input-answer') {
      if (message.sessionId !== id || !validAudioSdp(message.sdp)) {
        respond({ ok: false, error: 'Ungültige oder veraltete direkte Audioverbindung.' });
        return;
      }
      const expected = generation;
      const connection = peer;
      if (!connection) {
        respond({ ok: false, error: 'Die direkte Audioaufnahme wurde beendet.' });
        return;
      }
      void connection.setRemoteDescription({ type: 'answer', sdp: message.sdp }).then(
        () => respond(generation === expected && peer === connection
          ? { ok: true }
          : { ok: false, error: 'Die direkte Audioaufnahme wurde ersetzt.' }),
        () => {
          if (generation === expected) stop();
          respond({ ok: false, error: 'Die direkte Audioverbindung konnte nicht hergestellt werden.' });
        }
      );
      return true;
    }
    if (message.type === 'media-input-stop') {
      if (message.sessionId === undefined || message.sessionId === id) stop();
      respond({ ok: true });
    }
    return;
  });
  window.addEventListener('pagehide', stop);
  const health = setInterval(() => {
    try {
      if (chrome.runtime?.id) return;
    } catch { /* Extension reload invalidates this isolated world. */ }
    stop(); clearInterval(health);
  }, 2000);
}
