import type { AudioSettings, Message, SessionSettings } from '../messages';
import { GeminiTranslator } from './gemini';
import { SourceVoiceDetector, sourceDuckGain, sourcePathMix } from './voice-detector';

// Dynamisches Ducking wird ausschließlich von Sprache im englischen Quellton
// gesteuert. Musik, Raketenklang und Atmo bleiben bei 100 %, sobald niemand
// spricht. Während Quellsprache sinkt der komplette Originalmix weich auf den
// eingestellten Pegel (standardmäßig 10 %).
//
// Robustheitsprinzip: Ein Tick berechnet alle Soll-Werte alle 50 ms komplett
// neu aus dem aktuellen Zustand – es gibt keine Einzel-Events, die verloren
// gehen könnten.
const TICK_MS = 50;
const DUCK_ATTACK_S = 0.025;
const DUCK_RELEASE_S = 0.08;
const CONTROL_RAMP_S = 0.08;
// Callout-Boost: Kompression + Ausgleich hebt leise Sprecher (Funk-Callouts)
// im KI-Feed um ~15 dB an, während laute Sprecher gleich laut bleiben.
// Makeup 6.8 ≈ +16,7 dB kompensiert die Absenkung bei Durchschnittspegel.
const CALLOUT_MAKEUP_GAIN = 6.8;

interface ActiveSession {
  sessionId: string;
  ctx: AudioContext;
  media: MediaStream;
  captureTrack: MediaStreamTrack;
  sourceDryGain: GainNode;
  sourceDynamicGain: GainNode;
  translatedGain: GainNode;
  modelDirect: GainNode;
  modelBoosted: GainNode;
  bandAnalyser: AnalyserNode;
  totalAnalyser: AnalyserNode;
  bandBuffer: Float32Array<ArrayBuffer>;
  totalBuffer: Float32Array<ArrayBuffer>;
  voiceDetector: SourceVoiceDetector;
  client: GeminiTranslator;
  tickTimer: number;
  dubbing: boolean;
  originalVolume: number;
  translationVolume: number;
  fullOriginal: boolean;
  calloutBoost: boolean;
  lastDuckGain: number;
  lastTranslatedTarget: number;
  lastCalloutTarget: number;
  lastSourcePathTarget: number;
  wasSpeaking: boolean;
}

let session: ActiveSession | null = null;
// Merkt die zuletzt gewünschten Ausgabe-Einstellungen, auch wenn sie eintreffen,
// während start() noch läuft (z. B. Nutzer schaltet direkt nach dem Start um).
let latestAudio: AudioSettings | null = null;
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
  } else if (msg.type === 'update-audio-settings') {
    latestAudio = msg.settings;
    applyAudioSettings(msg.settings);
  }
});

async function start(sessionId: string, streamId: string, settings: SessionSettings): Promise<void> {
  stop();
  const generation = ++startGeneration;
  let pendingMedia: MediaStream | null = null;
  let pendingContext: AudioContext | null = null;
  latestAudio = {
    subtitles: settings.subtitles,
    dubbing: settings.dubbing,
    originalVolume: settings.originalVolume,
    translationVolume: settings.translationVolume,
    fullOriginal: settings.fullOriginal,
    calloutBoost: settings.calloutBoost
  };
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
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    if (generation !== startGeneration) {
      for (const track of media.getTracks()) track.stop();
      void ctx.close().catch(() => {});
      return;
    }

    const captureTrack = media.getAudioTracks()[0];
    if (!captureTrack) throw new Error('Der Tab-Audiostream enthält keine Audiospur.');
    const source = ctx.createMediaStreamSource(media);

    // Zwei physisch getrennte Originalpfade: Im Full-Modus läuft ausschließlich
    // der direkte Unity-Pfad. Der dynamische Pfad ist dann exakt 0. So bleibt
    // der komplette Stream wirklich unverändert.
    const initialSourceMix = sourcePathMix({
      dubbing: settings.dubbing,
      fullOriginal: settings.fullOriginal
    });
    const sourceDryGain = ctx.createGain();
    sourceDryGain.gain.value = initialSourceMix.dry;
    source.connect(sourceDryGain).connect(ctx.destination);
    const sourceDynamicGain = ctx.createGain();
    sourceDynamicGain.gain.value = initialSourceMix.dynamic;
    source.connect(sourceDynamicGain).connect(ctx.destination);

    // Separater Analysepfad: 250–4000 Hz gegen den Gesamtpegel. Dadurch lösen
    // tiefe Triebwerke und Rumpeln das Ducking nicht aus; der hörbare Pfad
    // selbst bleibt vollständig breitbandig und unverfälscht.
    const speechHighpass = ctx.createBiquadFilter();
    speechHighpass.type = 'highpass';
    speechHighpass.frequency.value = 250;
    speechHighpass.Q.value = Math.SQRT1_2;
    const speechLowpass = ctx.createBiquadFilter();
    speechLowpass.type = 'lowpass';
    speechLowpass.frequency.value = 4000;
    speechLowpass.Q.value = Math.SQRT1_2;
    const bandAnalyser = ctx.createAnalyser();
    bandAnalyser.fftSize = 1024;
    source.connect(speechHighpass).connect(speechLowpass).connect(bandAnalyser);
    const totalAnalyser = ctx.createAnalyser();
    totalAnalyser.fftSize = 1024;
    source.connect(totalAnalyser);

    // KI-Feed mit live umschaltbarem Callout-Boost: zwei parallele Wege
    // (direkt / komprimiert) in einen Sammelbus – das Gehörte ist unberührt.
    let modelInput: AudioNode = source;
    if (settings.audioMode === 'filtered') {
      const modelHighpass = ctx.createBiquadFilter();
      modelHighpass.type = 'highpass';
      modelHighpass.frequency.value = 80;
      modelHighpass.Q.value = 0.7;
      source.connect(modelHighpass);
      modelInput = modelHighpass;
    }
    const modelBus = ctx.createGain();
    const modelDirect = ctx.createGain();
    modelDirect.gain.value = settings.calloutBoost ? 0 : 1;
    modelInput.connect(modelDirect).connect(modelBus);
    const calloutCompressor = ctx.createDynamicsCompressor();
    calloutCompressor.threshold.value = -40;
    calloutCompressor.knee.value = 20;
    calloutCompressor.ratio.value = 3;
    calloutCompressor.attack.value = 0.005;
    calloutCompressor.release.value = 0.4;
    const calloutMakeup = ctx.createGain();
    calloutMakeup.gain.value = CALLOUT_MAKEUP_GAIN;
    const modelBoosted = ctx.createGain();
    modelBoosted.gain.value = settings.calloutBoost ? 1 : 0;
    modelInput
      .connect(calloutCompressor)
      .connect(calloutMakeup)
      .connect(modelBoosted)
      .connect(modelBus);
    const modelLimiter = ctx.createDynamicsCompressor();
    modelLimiter.threshold.value = -3;
    modelLimiter.knee.value = 4;
    modelLimiter.ratio.value = 12;
    modelLimiter.attack.value = 0.002;
    modelLimiter.release.value = 0.12;
    modelBus.connect(modelLimiter);

    // Nur die übersetzte Spur bekommt einen Sicherheits-Limiter. Der
    // Originalpfad bleibt davon vollständig unberührt und ist bei Stille
    // garantiert 100 % durchgeschaltet.
    const translatedInput = ctx.createGain();
    const translatedGain = ctx.createGain();
    translatedGain.gain.value = settings.dubbing ? settings.translationVolume : 0;
    const translatedLimiter = ctx.createDynamicsCompressor();
    translatedLimiter.threshold.value = -3;
    translatedLimiter.knee.value = 3;
    translatedLimiter.ratio.value = 8;
    translatedLimiter.attack.value = 0.003;
    translatedLimiter.release.value = 0.15;
    translatedInput.connect(translatedGain).connect(translatedLimiter).connect(ctx.destination);

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
        send({ type: 'offscreen-status', sessionId, status });
      },
      onError: (detail: string) => {
        console.error('[live-translate] Gemini-Fehler:', detail);
        if (session?.sessionId !== sessionId) return;
        stop();
        send({ type: 'offscreen-error', sessionId, detail });
      }
    };
    const client = new GeminiTranslator(clientOptions);

    session = {
      sessionId,
      ctx,
      media,
      captureTrack,
      sourceDryGain,
      sourceDynamicGain,
      translatedGain,
      modelDirect,
      modelBoosted,
      bandAnalyser,
      totalAnalyser,
      bandBuffer: new Float32Array(bandAnalyser.fftSize),
      totalBuffer: new Float32Array(totalAnalyser.fftSize),
      voiceDetector: new SourceVoiceDetector(),
      client,
      tickTimer: setInterval(() => {
        try {
          tick();
        } catch (err) {
          console.error('[live-translate] Tick-Fehler:', err);
        }
      }, TICK_MS) as unknown as number,
      dubbing: settings.dubbing,
      originalVolume: settings.originalVolume,
      translationVolume: settings.translationVolume,
      fullOriginal: settings.fullOriginal,
      calloutBoost: settings.calloutBoost,
      lastDuckGain: Number.NaN,
      lastTranslatedTarget: -1,
      lastCalloutTarget: -1,
      lastSourcePathTarget: -1,
      wasSpeaking: false
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
    applyAudioSettings(latestAudio);
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

function rmsOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / buffer.length);
}

function tick(): void {
  if (!session) return;
  const { ctx } = session;
  // Selbstheilung, falls Chrome den AudioContext pausiert hat.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

  const bandRms = rmsOf(session.bandAnalyser, session.bandBuffer);
  const totalRms = rmsOf(session.totalAnalyser, session.totalBuffer);
  const decision = session.voiceDetector.update({
    bandRms,
    totalRms,
    nowMs: performance.now()
  });
  const speaking = decision.speaking;
  if (speaking !== session.wasSpeaking) {
    session.wasSpeaking = speaking;
    console.debug(
      `[live-translate] Quellen-Ducking ${speaking ? 'AN' : 'AUS'} (band=${bandRms.toFixed(4)}, ratio=${decision.bandRatio.toFixed(2)})`
    );
  }

  // Soll-Werte komplett aus dem aktuellen Zustand ableiten.
  const duckGain = sourceDuckGain({
    dubbing: session.dubbing,
    fullOriginal: session.fullOriginal,
    sourceSpeaking: speaking,
    backgroundVolume: session.originalVolume
  });
  const sourceMix = sourcePathMix({
    dubbing: session.dubbing,
    fullOriginal: session.fullOriginal
  });
  const translatedTarget = session.dubbing ? session.translationVolume : 0;
  const calloutTarget = session.calloutBoost ? 1 : 0;

  if (duckGain !== session.lastDuckGain) {
    session.lastDuckGain = duckGain;
    rampParam(
      session.sourceDynamicGain.gain,
      duckGain,
      ctx,
      duckGain === 1 ? DUCK_RELEASE_S : DUCK_ATTACK_S
    );
  }
  if (translatedTarget !== session.lastTranslatedTarget) {
    session.lastTranslatedTarget = translatedTarget;
    rampParam(session.translatedGain.gain, translatedTarget, ctx, CONTROL_RAMP_S);
  }
  if (calloutTarget !== session.lastCalloutTarget) {
    session.lastCalloutTarget = calloutTarget;
    rampParam(session.modelBoosted.gain, calloutTarget, ctx, CONTROL_RAMP_S);
    rampParam(session.modelDirect.gain, 1 - calloutTarget, ctx, CONTROL_RAMP_S);
  }
  if (sourceMix.dry !== session.lastSourcePathTarget) {
    session.lastSourcePathTarget = sourceMix.dry;
    rampParam(session.sourceDryGain.gain, sourceMix.dry, ctx, CONTROL_RAMP_S);
    // Im dynamischen Pfad ist `duckGain` bereits der Sollpegel. Beim Wechsel
    // des Modus wird nur der Pfad ein-/ausgeblendet; der nächste Tick setzt
    // danach weiterhin den korrekten Ducking-Pegel.
    rampParam(
      session.sourceDynamicGain.gain,
      sourceMix.dynamic ? duckGain : 0,
      ctx,
      CONTROL_RAMP_S
    );
  }
}

function rampParam(param: AudioParam, target: number, ctx: AudioContext, duration: number): void {
  const now = ctx.currentTime;
  // Laufende Rampe an ihrer tatsächlichen aktuellen Position festhalten. Das
  // vermeidet Pegelsprünge, wenn Sprache während Attack/Release erneut startet.
  param.cancelAndHoldAtTime(now);
  param.linearRampToValueAtTime(target, now + duration);
}

function applyAudioSettings(settings: AudioSettings): void {
  if (!session) return;
  session.dubbing = settings.dubbing === true;
  session.originalVolume = clamp01(settings.originalVolume, 1);
  session.translationVolume = clamp01(settings.translationVolume, 1);
  session.fullOriginal = settings.fullOriginal !== false;
  session.calloutBoost = settings.calloutBoost === true;
  // Ziel-Werte neu erzwingen, damit z. B. ein bewegter Slider sofort greift.
  session.lastDuckGain = Number.NaN;
  session.lastTranslatedTarget = -1;
  session.lastCalloutTarget = -1;
  session.lastSourcePathTarget = -1;
}

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function stop(): void {
  startGeneration++;
  if (!session) return;
  const { client, media, captureTrack, ctx, tickTimer } = session;
  session = null;
  clearInterval(tickTimer);
  captureTrack.onended = null;
  try {
    client.stop();
  } catch (err) {
    console.warn('[live-translate] Gemini konnte nicht sauber gestoppt werden:', err);
  }
  for (const track of media.getTracks()) track.stop();
  void ctx.close().catch(() => {});
}
