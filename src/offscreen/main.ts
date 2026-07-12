import type { Message, SessionSettings } from '../messages';
import {
  SOURCE_DUCK_FADE_DOWN_S,
  SOURCE_DUCK_FADE_UP_S,
  rampAudioParam
} from './audio-envelope';
import { GeminiTranslator } from './gemini';
import { NeuralVoiceDetector } from './neural-vad';
import { sourceDuckGain } from './voice-detector';

// Dynamisches Ducking wird ausschließlich von Sprachaktivität im Quellton
// gesteuert. Im vorgesehenen englischen Video bleiben Musik, Raketenklang und
// Atmo bei 100 %, sobald niemand spricht. Während Sprache sinkt der komplette
// Originalmix weich auf den unveränderlichen Zielpegel von 10 %.
//
// Silero v6.2 analysiert lückenlos 32-ms-Frames lokal in einem Worker. Der Tick
// überträgt nur den daraus abgeleiteten Zustand auf den Audio-Graphen.
const TICK_MS = 50;
// Der einzige Gemini-Eingang ist immer sprachoptimiert: Rumpelfilter,
// Kompression für leise Callouts und abschließender Limiter. Dieser Pfad ist
// vom hörbaren Original vollständig getrennt.
const SPEECH_MAKEUP_GAIN = 6.8;

interface ActiveSession {
  sessionId: string;
  ctx: AudioContext;
  media: MediaStream;
  captureTrack: MediaStreamTrack;
  sourceGain: GainNode;
  vad: NeuralVoiceDetector;
  client: GeminiTranslator;
  tickTimer: number;
  lastDuckGain: number;
  sourceSpeaking: boolean;
  resumePending: boolean;
  vadReady: boolean;
  vadProbability: number;
  vadError: string | null;
  geminiReady: boolean;
}

let session: ActiveSession | null = null;
// Schützt gegen parallele Starts (z. B. wiederholte Start-Nachrichten):
// Nur die jüngste start()-Ausführung darf eine Session anlegen.
let startGeneration = 0;

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

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === 'offscreen-start') {
    sendResponse({ ok: true });
    void start(msg.sessionId, msg.streamId, msg.settings);
  } else if (msg.type === 'offscreen-stop') {
    sendResponse({ ok: true });
    stop();
  }
});

async function start(sessionId: string, streamId: string, settings: SessionSettings): Promise<void> {
  stop();
  const generation = ++startGeneration;
  let pendingMedia: MediaStream | null = null;
  let pendingContext: AudioContext | null = null;
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

    const ctx = new AudioContext();
    pendingContext = ctx;
    if (ctx.state !== 'running') await ctx.resume();
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

    // Ein hörbarer Originalpfad: unverändert bei Atmo, weich auf 10 % während
    // Sprache. Kein Bypass, kein Modus, kein paralleler Umschaltpfad.
    const sourceGain = ctx.createGain();
    sourceGain.gain.value = 1;
    source.connect(sourceGain).connect(ctx.destination);

    // Ein einziger, immer optimaler Gemini-Eingang. Der Hochpass entfernt nur
    // unbrauchbares Rumpeln; Kompressor und Makeup normalisieren leise Sprache.
    const modelHighpass = ctx.createBiquadFilter();
    modelHighpass.type = 'highpass';
    modelHighpass.frequency.value = 80;
    modelHighpass.Q.value = 0.7;
    const speechCompressor = ctx.createDynamicsCompressor();
    speechCompressor.threshold.value = -40;
    speechCompressor.knee.value = 20;
    speechCompressor.ratio.value = 3;
    speechCompressor.attack.value = 0.005;
    speechCompressor.release.value = 0.4;
    const speechMakeup = ctx.createGain();
    speechMakeup.gain.value = SPEECH_MAKEUP_GAIN;
    const modelLimiter = ctx.createDynamicsCompressor();
    modelLimiter.threshold.value = -3;
    modelLimiter.knee.value = 4;
    modelLimiter.ratio.value = 12;
    modelLimiter.attack.value = 0.002;
    modelLimiter.release.value = 0.12;
    source
      .connect(modelHighpass)
      .connect(speechCompressor)
      .connect(speechMakeup)
      .connect(modelLimiter);
    // Die übersetzte Spur läuft immer mit dem kalibrierten Unity-Pegel und
    // bekommt ausschließlich einen Sicherheits-Limiter.
    const translatedInput = ctx.createGain();
    const translatedLimiter = ctx.createDynamicsCompressor();
    translatedLimiter.threshold.value = -3;
    translatedLimiter.knee.value = 3;
    translatedLimiter.ratio.value = 8;
    translatedLimiter.attack.value = 0.003;
    translatedLimiter.release.value = 0.15;
    translatedInput.connect(translatedLimiter).connect(ctx.destination);

    const clientOptions = {
      apiKey: settings.geminiKey,
      ctx,
      modelSource: modelLimiter,
      outputNode: translatedInput,
      targetLanguage: settings.targetLanguage,
      onTranscript: (text: string, final: boolean) => {
        if (session?.sessionId !== sessionId) return;
        send({ type: 'transcript', sessionId, text, final });
      },
      onStatus: (status: string) => {
        if (session?.sessionId !== sessionId) return;
        send({ type: 'offscreen-status', sessionId, status: withDuckingWarning(status) });
      },
      onReadyChange: (ready: boolean) => {
        if (session?.sessionId !== sessionId) return;
        session.geminiReady = ready;
        session.lastDuckGain = Number.NaN;
        tick();
        publishDuckingTelemetry(sessionId);
      },
      canContinueWithoutTranscript: () => session?.sessionId === sessionId,
      onError: (detail: string) => {
        console.error('[live-translate] Gemini-Fehler:', detail);
        if (session?.sessionId !== sessionId) return;
        stop();
        send({ type: 'offscreen-error', sessionId, detail });
      }
    };
    const client = new GeminiTranslator(clientOptions);
    const vad = new NeuralVoiceDetector({
      ctx,
      source,
      onSpeechChange: (speaking, probability) => {
        if (session?.sessionId !== sessionId) return;
        session.sourceSpeaking = speaking;
        session.vadProbability = probability;
        session.lastDuckGain = Number.NaN;
        console.debug(
          `[live-translate] Silero-Ducking ${speaking ? 'AN' : 'AUS'} (p=${probability.toFixed(3)})`
        );
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
      captureTrack,
      sourceGain,
      vad,
      client,
      tickTimer: setInterval(() => {
        try {
          tick();
        } catch (err) {
          console.error('[live-translate] Tick-Fehler:', err);
        }
      }, TICK_MS) as unknown as number,
      lastDuckGain: Number.NaN,
      sourceSpeaking: false,
      resumePending: false,
      vadReady: false,
      vadProbability: 0,
      vadError: null,
      geminiReady: false
    };
    pendingMedia = null;
    pendingContext = null;
    const handleCaptureEnded = () => {
      if (session?.sessionId !== sessionId) return;
      stop();
      send({
        type: 'offscreen-error',
        sessionId,
        detail: 'Die Audioaufnahme des Quell-Tabs wurde beendet. Bitte die Übersetzung neu starten.'
      });
    };
    captureTrack.onended = handleCaptureEnded;
    if (captureTrack.readyState === 'ended') {
      handleCaptureEnded();
      return;
    }
    try {
      await vad.start();
      if (session?.sessionId !== sessionId) return;
      session.vadReady = true;
      publishDuckingTelemetry(sessionId);
    } catch (error) {
      if (session?.sessionId !== sessionId) return;
      handleVadFailure(sessionId, error instanceof Error ? error.message : String(error));
    }
    await client.start();
  } catch (err) {
    console.error('[live-translate] Start fehlgeschlagen:', err);
    if (pendingMedia) {
      for (const track of pendingMedia.getTracks()) track.stop();
    }
    if (pendingContext) void pendingContext.close().catch(() => {});
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
  if (ctx.state === 'suspended' && !session.resumePending) {
    session.resumePending = true;
    const sessionId = session.sessionId;
    void ctx
      .resume()
      .then(() => {
        if (session?.sessionId === sessionId) session.resumePending = false;
      })
      .catch((error) => {
        if (session?.sessionId !== sessionId) return;
        stop();
        send({
          type: 'offscreen-error',
          sessionId,
          detail: `Chrome hat die Audio-Engine angehalten: ${error instanceof Error ? error.message : String(error)}`
        });
      });
  }

  const speaking = session.sourceSpeaking;

  // Soll-Werte komplett aus dem aktuellen Zustand ableiten.
  const duckGain = sourceDuckGain({
    sourceSpeaking: speaking,
    translationReady: session.geminiReady
  });

  if (duckGain !== session.lastDuckGain) {
    session.lastDuckGain = duckGain;
    rampParam(
      session.sourceGain.gain,
      duckGain,
      ctx,
      duckGain === 1 ? SOURCE_DUCK_FADE_UP_S : SOURCE_DUCK_FADE_DOWN_S
    );
  }
}

function rampParam(param: AudioParam, target: number, ctx: AudioContext, duration: number): void {
  // Laufende S-Curve an ihrer tatsächlichen Position übernehmen. Auch bei
  // schnellem Sprecherwechsel entstehen so weder Knackser noch Pegelkanten.
  rampAudioParam(param, target, ctx.currentTime, duration);
}

function withDuckingWarning(status: string): string {
  return session?.vadError ? `${status} · Ducking aus (Original 100 %)` : status;
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
    status: 'Ducking nicht verfügbar · Original bleibt bei 100 %'
  });
}

function publishDuckingTelemetry(sessionId: string): void {
  if (session?.sessionId !== sessionId) return;
  const sourceGain = sourceDuckGain({
    sourceSpeaking: session.sourceSpeaking,
    translationReady: session.geminiReady
  });
  send({
    type: 'ducking-telemetry',
    sessionId,
    telemetry: {
      ready: session.vadReady,
      speaking: session.sourceSpeaking,
      sourceGain,
      probability: session.vadProbability,
      error: session.vadError,
      translationReady: session.geminiReady
    }
  });
}

function stop(): void {
  startGeneration++;
  if (!session) return;
  const { client, vad, media, captureTrack, ctx, tickTimer } = session;
  session = null;
  clearInterval(tickTimer);
  captureTrack.onended = null;
  try {
    vad.stop();
  } catch (err) {
    console.warn('[live-translate] Spracherkennung konnte nicht sauber gestoppt werden:', err);
  }
  try {
    client.stop();
  } catch (err) {
    console.warn('[live-translate] Gemini konnte nicht sauber gestoppt werden:', err);
  }
  for (const track of media.getTracks()) track.stop();
  void ctx.close().catch(() => {});
}
