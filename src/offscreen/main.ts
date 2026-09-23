import { isTrustedSender } from '../messages';
import type { Message, OutputSettings, SessionSettings, TranscriptEvent } from '../messages';
import {
  CONTROL_FADE_S,
  SOURCE_DUCK_FADE_DOWN_S,
  SOURCE_DUCK_FADE_UP_S,
  SOURCE_FAIL_OPEN_S,
  rampAudioParam
} from './audio-envelope';
import { resumeAudioContextWithTimeout } from './audio-context-state';
import { GptLiveTranslator } from './live';
import { NeuralVoiceDetector } from './neural-vad';
import { belongsToActiveSession, shouldStartOffscreenSession } from './session-routing';
import { createSoftLimiterCurve } from './soft-limiter';
import { dubbingSourceGain } from './dubbing-mix';
import { gatherLocalDescription, validAudioSdp } from '../local-audio-bridge';

// Decode-driven sidechain: original audio is reduced only while German plays.
const TICK_MS = 25;
const MANUAL_STOP_DRAIN_MS = 15_000;
// Ein resume() ohne Antwort darf die Sitzung nicht stumm weiterlaufen lassen.
const RESUME_TIMEOUT_MS = 5_000;

interface ActiveSession {
  sessionId: string;
  ctx: AudioContext;
  media: MediaStream;
  inputPeer: RTCPeerConnection | null;
  inputIndependent: boolean;
  captureTrack: MediaStreamTrack;
  sourceGain: GainNode;
  translatedGain: GainNode;
  vad: NeuralVoiceDetector;
  client: TranslatorClient;
  tickTimer: number;
  translationVolume: number;
  lastDuckGain: number;
  lastTranslatedTarget: number;
  lastAudioHealthKey: string | null;
  sourceSpeaking: boolean;
  resumePending: boolean;
  vadReady: boolean;
  vadProbability: number;
  vadError: string | null;
  providerReady: boolean;
  translatedAudioEnabled: boolean;
}

interface TranslatorClient {
  start(): Promise<void>;
  finishInput(timeoutMs?: number): Promise<void>;
  stop(): void;
  audioHealth(): { attached: boolean; live: boolean; muted: boolean; signal: boolean };
}

let session: ActiveSession | null = null;
let tickCount = 0;
// Schützt gegen parallele Starts (z. B. wiederholte Start-Nachrichten):
// Nur die jüngste start()-Ausführung darf eine Session anlegen.
let startGeneration = 0;
let pendingStartSessionId: string | null = null;
let gracefulStopPromise: Promise<void> | null = null;
let finalizationError: string | null = null;

function send(msg: Message): void {
  void chrome.runtime.sendMessage(msg).catch(() => {});
}

// Globale Fehler-Hooks: Jeder unbehandelte Fehler landet mit vollständiger
// Meldung in der Konsole statt nur als Zeilennummer in chrome://extensions.
window.addEventListener('error', (event) => {
  console.error('[live-translate] Unbehandelter Fehler:', event.message, event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[live-translate] Unbehandelte Promise-Ablehnung:', event.reason);
});

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // Start/Stop steuern Tab-Capture und API-Key-Nutzung; solche Nachrichten
  // kommen ausschließlich aus Extension-eigenen Kontexten.
  if (!isTrustedSender(sender)) return undefined;
  if (msg.type === 'offscreen-start') {
    sendResponse({ ok: true });
    // sendToOffscreen darf nach einem verlorenen Ack dieselbe Nachricht erneut
    // zustellen. Die tabCapture-ID ist one-shot; derselbe Start muss deshalb
    // strikt idempotent sein.
    if (!shouldStartOffscreenSession(session?.sessionId ?? null, pendingStartSessionId, msg.sessionId)) {
      return undefined;
    }
    pendingStartSessionId = msg.sessionId;
    void start(msg.sessionId, msg.streamId, msg.settings, msg.inputOffer).finally(() => {
      if (pendingStartSessionId === msg.sessionId) pendingStartSessionId = null;
    });
  } else if (msg.type === 'offscreen-stop') {
    void stopGracefully().then(
      () => sendResponse({ ok: true, finalizationError }),
      (error) => {
        console.warn('[live-translate] Graceful Stop fehlgeschlagen:', error);
        stop();
        sendResponse({ ok: true, finalizationError: 'Sitzungsende fehlgeschlagen: unvollständige Finalisierung.' });
      }
    );
    return true;
  } else if (msg.type === 'offscreen-update-output') {
    sendResponse({ ok: true });
    if (belongsToActiveSession(session?.sessionId ?? null, msg.sessionId)) {
      applyOutputSettings(msg.settings);
    }
  }
  return undefined;
});

async function start(sessionId: string, streamId: string, settings: SessionSettings, inputOffer?: string): Promise<void> {
  stop();
  const generation = ++startGeneration;
  let pendingMedia: MediaStream | null = null;
  let pendingContext: AudioContext | null = null;
  let pendingInputPeer: RTCPeerConnection | null = null;
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
      }
    } as MediaStreamConstraints);
    pendingMedia = media;
    if (generation !== startGeneration) {
      // Inzwischen wurde neu gestartet oder gestoppt – nichts doppelt aufbauen.
      for (const track of media.getTracks()) track.stop();
      return;
    }

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    pendingContext = ctx;
    if (ctx.state !== 'running') await resumeAudioContextWithTimeout(ctx, RESUME_TIMEOUT_MS);
    if (ctx.state !== 'running') {
      throw new Error(`Chrome konnte die Audio-Engine nicht starten (Status: ${ctx.state}).`);
    }
    if (generation !== startGeneration) {
      for (const track of media.getTracks()) track.stop();
      void ctx.close().catch(() => {});
      return;
    }

    const captureTrack = media.getAudioTracks()[0];
    if (!captureTrack) throw new Error('Der Tab-Audiostream enthält keine Audiospur.');
    const source = ctx.createMediaStreamSource(media);
    let agentInput = media;
    if (validAudioSdp(inputOffer)) {
      const inputPeer = new RTCPeerConnection({ iceServers: [] });
      pendingInputPeer = inputPeer;
      const tracks: MediaStreamTrack[] = [];
      inputPeer.ontrack = event => { if (event.track.kind === 'audio') tracks.push(event.track); };
      await inputPeer.setRemoteDescription({ type: 'offer', sdp: inputOffer });
      await inputPeer.setLocalDescription(await inputPeer.createAnswer());
      const sdp = await gatherLocalDescription(inputPeer);
      if (generation !== startGeneration) throw new Error('Start abgebrochen.');
      if (!tracks.length) throw new Error('Direkter Videoeingang enthält keine Audiospur.');
      agentInput = new MediaStream(tracks);
      send({ type: 'offscreen-input-answer', sessionId, sdp });
      inputPeer.onconnectionstatechange = () => {
        if (session?.sessionId !== sessionId) return;
        if (inputPeer.connectionState === 'failed' || inputPeer.connectionState === 'disconnected') {
          stop();
          send({ type: 'offscreen-error', sessionId, detail: 'Direkter Videoeingang unterbrochen. Bitte neu starten.' });
        }
      };
    }
    const analysisSource = agentInput === media ? source : ctx.createMediaStreamSource(agentInput);

    // Ein Originalpfad; der Sidechain folgt ausschließlich hörbarem Dubbing.
    // DynamicsCompressorNode besitzt in Chrome automatisches Makeup-Gain und
    // verfärbte deshalb selbst den vermeintlich unberührten Originalton. Beide
    // Pfade summieren direkt in diesen deterministischen Soft-Knee-Waveshaper:
    // normale Atmo bleibt unverändert, nur die obersten 1,94 dB werden sicher
    // begrenzt. 4x-Oversampling kostet konstante 4 ms, verhindert aber Aliasing.
    const masterCeiling = ctx.createWaveShaper();
    masterCeiling.curve = createSoftLimiterCurve();
    masterCeiling.oversample = '4x';
    masterCeiling.connect(ctx.destination);
    const sourceGain = ctx.createGain();
    sourceGain.gain.value = 1;
    source.connect(sourceGain).connect(masterCeiling);

    // GPT-Live verhandelt Audio direkt über WebRTC. Der Quelltrack bleibt daher
    // unverändert; Resampling, PCM-Packaging und TTS-Playback im Extension-Code
    // entfallen vollständig.
    // Die übersetzte Spur läuft immer mit dem kalibrierten Unity-Pegel und
    // bekommt einen live regelbaren Gain und einen Sicherheits-Limiter.
    const translatedInput = ctx.createGain();
    const translatedGain = ctx.createGain();
    translatedGain.gain.value = settings.translationVolume;
    const translatedLimiter = ctx.createDynamicsCompressor();
    translatedLimiter.threshold.value = -3;
    translatedLimiter.knee.value = 3;
    translatedLimiter.ratio.value = 8;
    translatedLimiter.attack.value = 0.003;
    translatedLimiter.release.value = 0.15;
    translatedInput.connect(translatedGain).connect(translatedLimiter).connect(masterCeiling);

    const commonCallbacks = {
      onTranscript: (event: TranscriptEvent) => {
        if (session?.sessionId !== sessionId) return;
        send({ type: 'transcript', sessionId, event });
      },
      onStatus: (status: string) => {
        if (session?.sessionId !== sessionId) return;
        send({ type: 'offscreen-status', sessionId, status: withDuckingWarning(status) });
      },
      onReadyChange: (ready: boolean) => {
        if (session?.sessionId !== sessionId) return;
        session.providerReady = ready;
        session.lastDuckGain = Number.NaN;
        tick();
        publishDuckingTelemetry(sessionId);
      },
      onError: (detail: string) => {
        console.error('[live-translate] GPT-Live-Fehler:', detail);
        if (session?.sessionId !== sessionId) return;
        stop();
        send({ type: 'offscreen-error', sessionId, detail });
      }
    };
    // Forward both transcript lanes; subtitle selection can change live.
    const inputTranscriptionEnabled = true;
    const client: TranslatorClient = new GptLiveTranslator({
      ctx,
      inputStream: agentInput,
      outputNode: translatedInput,
      serverUrl: settings.liveServerUrl,
      serverToken: settings.liveServerToken,
      voice: settings.liveVoice,
      inputTranscriptionEnabled,
      ...commonCallbacks
    });
    const vad = new NeuralVoiceDetector({
      ctx,
      source: analysisSource,
      onSpeechChange: (speaking, probability) => {
        if (session?.sessionId !== sessionId) return;
        session.sourceSpeaking = speaking;
        session.vadProbability = probability;
        session.lastDuckGain = Number.NaN;
        tick();
        publishDuckingTelemetry(sessionId);
      },
      onError: (detail) => {
        if (session?.sessionId !== sessionId) return;
        handleVadFailure(sessionId, detail);
      }
    });

    session = {
      sessionId,
      ctx,
      media,
      inputPeer: pendingInputPeer,
      inputIndependent: agentInput !== media,
      captureTrack,
      sourceGain,
      translatedGain,
      vad,
      client,
      tickTimer: setInterval(() => {
        try {
          tick();
        } catch (err) {
          console.error('[live-translate] Tick-Fehler:', err);
        }
      }, TICK_MS) as unknown as number,
      translationVolume: settings.translationVolume,
      lastDuckGain: Number.NaN,
      lastTranslatedTarget: settings.translationVolume,
      lastAudioHealthKey: null,
      sourceSpeaking: false,
      resumePending: false,
      vadReady: false,
      vadProbability: 0,
      vadError: null,
      providerReady: false,
      // GPT-Live liefert den Zielton über den WebRTC-Remote-Track.
      translatedAudioEnabled: true
    };
    pendingMedia = null;
    pendingContext = null;
    pendingInputPeer = null;
    const handleCaptureEnded = () => {
      if (session?.sessionId !== sessionId) return;
      captureTrack.onended = null;
      void client
        .finishInput()
        .catch((error) =>
          console.warn('[live-translate] Letzter Audio-Turn konnte nicht geleert werden:', error)
        )
        .finally(() => {
          if (session?.sessionId !== sessionId) return;
          stop();
          send({
            type: 'offscreen-error',
            sessionId,
            detail: 'Die Audioaufnahme des Quell-Tabs wurde beendet. Bitte die Übersetzung neu starten.'
          });
        });
    };
    captureTrack.onended = handleCaptureEnded;
    if (captureTrack.readyState === 'ended') {
      handleCaptureEnded();
      return;
    }
    // Den gewählten Provider sofort starten; die schwere lokale Silero-Initialisierung darf
    // den Beginn des laufenden Videos nicht mehr blockieren.
    const [, vadError] = await Promise.all([
      // Promise.all verwirft sofort, wenn der Provider nicht starten kann. Ein bis zu
      // 20 s dauernder Silero-Start darf diesen Fehler nicht mehr verdecken.
      client.start(),
      vad.start().then(
        () => null,
        (error: unknown) => error
      )
    ]);
    if (session?.sessionId !== sessionId) return;
    if (vadError === null) {
      session.vadReady = true;
      publishDuckingTelemetry(sessionId);
    } else {
      handleVadFailure(sessionId, vadError instanceof Error ? vadError.message : String(vadError));
    }
  } catch (err) {
    console.error('[live-translate] Start fehlgeschlagen:', err);
    if (pendingMedia) {
      for (const track of pendingMedia.getTracks()) track.stop();
    }
    if (pendingContext) void pendingContext.close().catch(() => {});
    pendingInputPeer?.close();
    if (generation === startGeneration) {
      stop();
      send({
        type: 'offscreen-error',
        sessionId,
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

function tick(): void {
  if (!session) return;
  const { ctx } = session;
  // Selbstheilung mit sichtbarem Fehler statt stumm geschluckter Resume-Probleme.
  // Auch ein resume(), das weder auflöst noch ablehnt, endet über den Timeout
  // in einem sichtbaren Fehler statt in einer dauerhaft stummen Sitzung.
  if (ctx.state === 'suspended' && !session.resumePending) {
    session.resumePending = true;
    const sessionId = session.sessionId;
    void resumeAudioContextWithTimeout(ctx, RESUME_TIMEOUT_MS)
      .then(() => {
        if (session?.sessionId === sessionId) session.resumePending = false;
      })
      .catch((error: unknown) => {
        if (session?.sessionId !== sessionId) return;
        stop();
        send({
          type: 'offscreen-error',
          sessionId,
          detail: `Chrome hat die Audio-Engine angehalten: ${error instanceof Error ? error.message : String(error)}`
        });
      });
  }

  const health = session.client.audioHealth();
  const duckGain = dubbingSourceGain(session.sourceSpeaking, health.signal, session.translationVolume);

  if (duckGain !== session.lastDuckGain) {
    session.lastDuckGain = duckGain;
    publishDuckingTelemetry(session.sessionId);
    const failOpen =
      duckGain === 1 &&
      (!session.providerReady || !session.translatedAudioEnabled || session.vadError !== null);
    rampParam(
      session.sourceGain.gain,
      duckGain,
      ctx,
      duckGain === 1
        ? failOpen
          ? SOURCE_FAIL_OPEN_S
          : SOURCE_DUCK_FADE_UP_S
        : SOURCE_DUCK_FADE_DOWN_S
    );
  }
  if (session.translationVolume !== session.lastTranslatedTarget) {
    session.lastTranslatedTarget = session.translationVolume;
    rampParam(session.translatedGain.gain, session.translationVolume, ctx, CONTROL_FADE_S);
  }
  tickCount++;
  // Ton-Monitor alle 50 ms: meldet hörbar-vs-stumm als Popup-Status, damit ein
  // fehlender Zielton ohne Devtools eingrenzbar ist. Nur bei Wechsel senden.
  if (tickCount % 2 === 0) audioHealthCheck();
}

function rampParam(param: AudioParam, target: number, ctx: AudioContext, duration: number): void {
  // Laufende S-Curve an ihrer tatsächlichen Position übernehmen. Auch bei
  // schnellem Sprecherwechsel entstehen so weder Knackser noch Pegelkanten.
  rampAudioParam(param, target, ctx.currentTime, duration);
}

function applyOutputSettings(settings: OutputSettings): void {
  if (!session) return;
  session.translationVolume = clamp01(settings.translationVolume, 1);
  // Sofort neu bewerten, damit ein aufgedrehter Regler umgehend wirkt.
  session.lastAudioHealthKey = null;
  tick();
}

/** Ton-Monitor: unterscheidet stummen Track, Gain 0 und laufenden Zielton. */
function audioHealthCheck(): void {
  if (!session || !session.providerReady) return;
  const health = session.client.audioHealth();
  let key: string;
  let status: string | null;
  if (!health.attached) {
    // Meldet bereits der 10-s-Watchdog in live.ts.
    key = 'none';
    status = null;
  } else if (session.translationVolume <= 0) {
    key = 'volume-zero';
    status = 'Zielton aus · Lautstärke steht auf 0 %';
  } else if (!health.live) {
    key = 'track-ended';
    status = 'Zielstimme abgebrochen · bitte neu starten';
  } else if (health.muted) {
    key = 'track-muted';
    status = 'Zielstimme verbunden, liefert aber keinen Ton';
  } else if (!health.signal) {
    key = 'waiting-for-speech';
    status = 'Verbunden · warte auf deutsche Sprachausgabe';
  } else {
    key = 'ok';
    status = 'Deutsche Sprachausgabe · Audiopegel gemessen';
  }
  if (key === session.lastAudioHealthKey) return;
  session.lastAudioHealthKey = key;
  if (status !== null) {
    send({ type: 'offscreen-status', sessionId: session.sessionId, status: withDuckingWarning(status) });
  }
}

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function withDuckingWarning(status: string): string {
  return session?.vadError ? `${status} · vereinfachter Audiomix` : status;
}

function handleVadFailure(sessionId: string, detail: string): void {
  if (session?.sessionId !== sessionId || session.vadError) return;
  console.error('[live-translate] Lokale Spracherkennung ausgefallen:', detail);
  session.vad.stop();
  session.vadReady = false;
  session.vadError = detail;
  session.sourceSpeaking = false;
  session.vadProbability = 0;
  session.lastDuckGain = Number.NaN;
  tick();
  publishDuckingTelemetry(sessionId);
  send({
    type: 'offscreen-status',
    sessionId,
    status: 'Spracherkennung nicht verfügbar · Audiomix bleibt aktiv'
  });
}

function publishDuckingTelemetry(sessionId: string): void {
  if (session?.sessionId !== sessionId) return;
  const sourceGain = Number.isFinite(session.lastDuckGain) ? session.lastDuckGain : 1;
  send({
    type: 'ducking-telemetry',
    sessionId,
    telemetry: {
      ready: session.vadReady,
      speaking: session.sourceSpeaking,
      sourceGain,
      probability: session.vadProbability,
      error: session.vadError,
      translationReady: session.providerReady,
      inputIndependent: session.inputIndependent
    }
  });
}

function stop(): void {
  startGeneration++;
  if (!session) return;
  const { client, vad, media, inputPeer, captureTrack, ctx, tickTimer } = session;
  session = null;
  clearInterval(tickTimer);
  captureTrack.onended = null;
  inputPeer?.close();
  try {
    vad.stop();
  } catch (err) {
    console.warn('[live-translate] Spracherkennung konnte nicht sauber gestoppt werden:', err);
  }
  try {
    client.stop();
  } catch (err) {
    console.warn('[live-translate] Übersetzungsclient konnte nicht sauber gestoppt werden:', err);
  }
  for (const track of media.getTracks()) track.stop();
  void ctx.close().catch(() => {});
}

function stopGracefully(): Promise<void> {
  if (gracefulStopPromise) return gracefulStopPromise;
  const active = session;
  if (!active) {
    stop();
    return Promise.resolve();
  }
  active.captureTrack.onended = null;
  finalizationError = null;
  const sessionId = active.sessionId;
  gracefulStopPromise = active.client
    .finishInput(MANUAL_STOP_DRAIN_MS)
    .catch((error) => {
      finalizationError = error instanceof Error ? error.message : String(error);
      console.warn('[live-translate] Audio-Ende wurde per Timeout beendet:', error);
    })
    .then(() => {
      if (session?.sessionId === sessionId) stop();
    })
    .finally(() => {
      gracefulStopPromise = null;
    });
  return gracefulStopPromise;
}
