import type {
  AudioMode,
  Message,
  SessionSettings,
  SessionState
} from './messages';
import { configurationError, isTranslatableUrl } from './popup-logic';
import { loadSettings, saveSettings } from './settings';

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Element nicht gefunden: ${selector}`);
  return found;
}

const geminiKeyInput = el<HTMLInputElement>('#geminiKey');
const subtitlesInput = el<HTMLInputElement>('#subtitles');
const dubbingInput = el<HTMLInputElement>('#dubbing');
const originalVolumeInput = el<HTMLInputElement>('#originalVolume');
const volumeValueLabel = el<HTMLElement>('#volumeValue');
const translationVolumeInput = el<HTMLInputElement>('#translationVolume');
const translationValueLabel = el<HTMLElement>('#translationValue');
const fullOriginalInput = el<HTMLInputElement>('#fullOriginal');
const targetLanguageSelect = el<HTMLSelectElement>('#targetLanguage');
const calloutBoostInput = el<HTMLInputElement>('#calloutBoost');
const toggleButton = el<HTMLButtonElement>('#toggle');
const statusLine = el<HTMLDivElement>('#status');
const audioModeInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="audioMode"]')
);

let state: SessionState = {
  running: false,
  tabId: null,
  sessionId: null,
  status: 'Bereit',
  error: null,
  ducking: null
};

function selectedAudioMode(): AudioMode {
  return audioModeInputs.find((input) => input.checked)?.value === 'native' ? 'native' : 'filtered';
}

function collectSettings(): SessionSettings {
  return {
    settingsVersion: 4,
    subtitles: subtitlesInput.checked,
    dubbing: dubbingInput.checked,
    originalVolume: Number(originalVolumeInput.value) / 100,
    translationVolume: Number(translationVolumeInput.value) / 100,
    fullOriginal: fullOriginalInput.checked,
    geminiKey: geminiKeyInput.value.trim(),
    targetLanguage: targetLanguageSelect.value,
    audioMode: selectedAudioMode(),
    calloutBoost: calloutBoostInput.checked
  };
}

function setStatus(text: string, isError = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', isError);
}

function renderState(): void {
  toggleButton.textContent = state.running ? 'Übersetzung stoppen' : 'Übersetzung starten';
  toggleButton.classList.toggle('running', state.running);
  toggleButton.setAttribute('aria-pressed', String(state.running));
  if (state.error) setStatus(state.error, true);
  else setStatus(state.status === 'Bereit' ? '' : state.status);
  renderDuckingState();
}

function renderDuckingState(): void {
  const monitor = el<HTMLDivElement>('#duckingMonitor');
  if (!state.running) {
    monitor.textContent = 'Lokale Silero-KI: bereit';
    monitor.dataset.state = 'idle';
  } else if (state.ducking?.error) {
    monitor.textContent = 'Ducking nicht verfügbar · Original 100 %';
    monitor.dataset.state = 'error';
  } else if (!state.ducking?.ready) {
    monitor.textContent = 'Lokale Silero-KI wird geladen…';
    monitor.dataset.state = 'loading';
  } else if (state.ducking.speaking && !state.ducking.translationReady) {
    monitor.textContent = 'Stimme erkannt · Gemini verbindet · Original 100 %';
    monitor.dataset.state = 'loading';
  } else if (state.ducking.speaking && state.ducking.sourceGain < 1) {
    monitor.textContent = `Stimme erkannt · Original ${Math.round(state.ducking.sourceGain * 100)} %`;
    monitor.dataset.state = 'active';
  } else if (state.ducking.speaking) {
    monitor.textContent = 'Stimme erkannt · Ducking ist deaktiviert';
    monitor.dataset.state = 'idle';
  } else {
    monitor.textContent = 'Keine Stimme · Original 100 %';
    monitor.dataset.state = 'idle';
  }
}

function getStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err || !streamId) {
        reject(new Error(err?.message ?? 'Tab-Audio konnte nicht angefordert werden.'));
      } else {
        resolve(streamId);
      }
    });
  });
}

/** @returns true, wenn die Sitzung gestartet wurde; false bei (angezeigtem) Fehler. */
async function start(): Promise<boolean> {
  try {
    const settings = collectSettings();
    await saveSettings(settings);

    const validationError = configurationError(settings);
    if (validationError) {
      setStatus(validationError, true);
      return false;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (
      tab?.id === undefined ||
      !isTranslatableUrl(tab.url)
    ) {
      setStatus('Diese Seite kann nicht übersetzt werden. Bitte den Tab mit dem Video aktivieren.', true);
      return false;
    }

    setStatus('Starte…');
    const streamId = await getStreamId(tab.id);
    const response = (await chrome.runtime.sendMessage({
      type: 'start-session',
      tabId: tab.id,
      streamId,
      settings
    } satisfies Message)) as { ok: boolean; error?: string } | undefined;
    if (!response?.ok) {
      setStatus(response?.error ?? 'Die Erweiterung hat den Start nicht bestätigt.', true);
      return false;
    }
    return true;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    return false;
  }
}

async function refreshState(): Promise<void> {
  try {
    state = ((await chrome.runtime.sendMessage({ type: 'get-state' } satisfies Message)) ??
      state) as SessionState;
  } catch {
    // Service Worker gerade nicht erreichbar – letzten Stand behalten.
  }
  renderState();
}

async function onToggle(): Promise<void> {
  toggleButton.disabled = true;
  try {
    if (state.running) {
      await chrome.runtime.sendMessage({ type: 'stop-session' } satisfies Message);
      await refreshState();
    } else if (await start()) {
      // Nur bei Erfolg neu laden – sonst würde die Fehlermeldung überschrieben.
      await refreshState();
    }
  } catch (err) {
    await refreshState();
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    toggleButton.disabled = false;
  }
}

function updateControlStates(): void {
  const dubbing = dubbingInput.checked;
  translationVolumeInput.disabled = !dubbing;
  originalVolumeInput.disabled = !dubbing || fullOriginalInput.checked;
}

function onSettingChanged(): void {
  const settings = collectSettings();
  volumeValueLabel.textContent = `${originalVolumeInput.value} %`;
  translationValueLabel.textContent = `${translationVolumeInput.value} %`;
  updateControlStates();
  void saveSettings(settings).catch(() => {
    setStatus('Die Einstellungen konnten nicht gespeichert werden.', true);
  });
  // Immer senden – läuft keine Sitzung, verwirft der Empfänger die Nachricht.
  // So kann ein veralteter Popup-Zustand keine Updates verschlucken.
  void chrome.runtime
    .sendMessage({
      type: 'update-audio-settings',
      settings: {
        subtitles: settings.subtitles,
        dubbing: settings.dubbing,
        originalVolume: settings.originalVolume,
        translationVolume: settings.translationVolume,
        fullOriginal: settings.fullOriginal,
        calloutBoost: settings.calloutBoost
      }
    } satisfies Message)
    .catch(() => {});
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  geminiKeyInput.value = settings.geminiKey;
  subtitlesInput.checked = settings.subtitles;
  dubbingInput.checked = settings.dubbing;
  originalVolumeInput.value = String(Math.round(settings.originalVolume * 100));
  volumeValueLabel.textContent = `${originalVolumeInput.value} %`;
  translationVolumeInput.value = String(Math.round(settings.translationVolume * 100));
  translationValueLabel.textContent = `${translationVolumeInput.value} %`;
  fullOriginalInput.checked = settings.fullOriginal;
  targetLanguageSelect.value = settings.targetLanguage;
  for (const input of audioModeInputs) input.checked = input.value === settings.audioMode;
  calloutBoostInput.checked = settings.calloutBoost;
  updateControlStates();

  try {
    state = ((await chrome.runtime.sendMessage({ type: 'get-state' } satisfies Message)) ??
      state) as SessionState;
  } catch {
    state = {
      ...state,
      status: 'Fehler',
      error: 'Der Erweiterungsdienst ist gerade nicht erreichbar. Popup bitte erneut öffnen.'
    };
  }
  renderState();

  toggleButton.addEventListener('click', () => void onToggle());
  for (const input of [
    ...audioModeInputs,
    geminiKeyInput,
    subtitlesInput,
    dubbingInput,
    originalVolumeInput,
    translationVolumeInput,
    fullOriginalInput,
    targetLanguageSelect,
    calloutBoostInput
  ]) {
    input.addEventListener('change', onSettingChanged);
  }
  // Lautstärke schon beim Ziehen übernehmen, nicht erst beim Loslassen.
  originalVolumeInput.addEventListener('input', onSettingChanged);
  translationVolumeInput.addEventListener('input', onSettingChanged);

  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg.type === 'session-state') {
      state = msg.state;
      renderState();
    }
  });
}

void init().catch((err) => {
  console.error('[live-translate] Popup-Initialisierung fehlgeschlagen:', err);
  setStatus('Das Popup konnte nicht vollständig geladen werden. Bitte erneut öffnen.', true);
  toggleButton.disabled = true;
});
