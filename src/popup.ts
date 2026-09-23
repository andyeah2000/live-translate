import { isTrustedSender } from './messages';
import type { Message, SessionSettings, SessionState } from './messages';
import {
  configurationError,
  isTranslatableUrl,
  popupMonitorPresentation,
  popupStatusPresentation
} from './popup-logic';
import { loadSettings, saveSettings, VOICE_IDS } from './settings';

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Element nicht gefunden: ${selector}`);
  return found;
}

const liveServerUrlInput = el<HTMLInputElement>('#liveServerUrl');
const liveServerTokenInput = el<HTMLInputElement>('#liveServerToken');
const subtitlesInput = el<HTMLInputElement>('#subtitles');
const dualSubtitlesInput = el<HTMLInputElement>('#dualSubtitles');
const translationVolumeInput = el<HTMLInputElement>('#translationVolume');
const translationValue = el<HTMLElement>('#translationValue');
const toggleButton = el<HTMLButtonElement>('#toggle');
const monitor = el<HTMLDivElement>('#monitor');
const statusLine = el<HTMLDivElement>('#status');
const originalValue = el<HTMLElement>('#originalValue');
const originalMeter = el<HTMLMeterElement>('#originalMeter');
const connectionDetails = el<HTMLDetailsElement>('#connection');
const voiceSelect = el<HTMLSelectElement>('#liveVoice');
const inputMode = el<HTMLElement>('#inputMode');

let state: SessionState = {
  running: false,
  tabId: null,
  sessionId: null,
  status: 'Bereit',
  error: null,
  ducking: null
};


function collectSettings(): SessionSettings {
  return {
    settingsVersion: 11,
    liveServerUrl: liveServerUrlInput.value.trim(),
    liveServerToken: liveServerTokenInput.value.trim(),
    // The server owns voice and the English-only dubbing prompt.
    liveVoice: voiceSelect.value,
    subtitles: subtitlesInput.checked,
    subtitleMode: dualSubtitlesInput.checked ? 'dual' : 'translation',
    translationVolume: Number(translationVolumeInput.value) / 100,
  };
}

function setStatus(text: string, isError = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', isError);
}

function renderState(): void {
  toggleButton.textContent = state.running ? 'Stop' : 'Start';
  toggleButton.classList.toggle('running', state.running);
  toggleButton.setAttribute('aria-pressed', String(state.running));
  // Credentials stay fixed; voice changes restart through the background queue.
  liveServerUrlInput.disabled = state.running;
  liveServerTokenInput.disabled = state.running;
  voiceSelect.disabled = false;
  voiceSelect.title = 'Stimme wechseln – laufende Übersetzung startet automatisch neu';
  const status = popupStatusPresentation(state);
  setStatus(status.error ? status.text : '', status.error);
  toggleButton.title = status.text;
  renderMonitor();
}

function renderMonitor(): void {
  const presentation = popupMonitorPresentation(state);
  monitor.textContent = presentation.text;
  monitor.dataset.state = presentation.state;
  const gain = state.running ? (state.ducking?.sourceGain ?? 1) : 1;
  originalValue.textContent = `${Math.round(gain * 100)} %`;
  originalMeter.value = gain;
  inputMode.textContent = state.running ? (state.ducking?.inputIndependent ? 'DIRECT' : 'TAB') : 'LIVE-MIX';
  inputMode.title = state.ducking?.inputIndependent
    ? 'Agent-Eingang unabhängig von Player-Lautstärke und Stummschaltung'
    : 'Tab-Eingang: Player-Lautstärke beeinflusst den Agenten; Video auf 100 % stellen';
}

async function start(): Promise<boolean> {
  try {
    const settings = collectSettings();
    const validationError = configurationError(settings);
    if (validationError) {
      connectionDetails.open = true;
      setStatus(validationError, true);
      return false;
    }
    if (!(await ensureServerPermission(settings.liveServerUrl))) {
      setStatus('Der Zugriff auf den GPT-Live-Server wurde nicht erlaubt.', true);
      return false;
    }
    await saveSettings(settings);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !isTranslatableUrl(tab.url)) {
      setStatus('Bitte zuerst den Video-Tab öffnen.', true);
      return false;
    }

    setStatus('Starte…');
    const response = (await chrome.runtime.sendMessage({
      type: 'start-session',
      tabId: tab.id,
      settings
    } satisfies Message)) as { ok: boolean; error?: string } | undefined;
    if (!response?.ok) {
      setStatus(response?.error ?? 'Start fehlgeschlagen.', true);
      return false;
    }
    return true;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    return false;
  }
}

function serverPermissionPattern(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

async function ensureServerPermission(serverUrl: string): Promise<boolean> {
  const pattern = serverPermissionPattern(serverUrl);
  if (!pattern) return false;
  const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });
  if (alreadyGranted) return true;
  return chrome.permissions.request({ origins: [pattern] });
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
      const response = (await chrome.runtime.sendMessage({
        type: 'stop-session'
      } satisfies Message)) as { ok: boolean; error?: string } | undefined;
      if (!response?.ok) throw new Error(response?.error ?? 'Stop fehlgeschlagen.');
      await refreshState();
    } else if (await start()) {
      await refreshState();
    }
  } catch (err) {
    await refreshState();
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    toggleButton.disabled = false;
  }
}

function saveConfiguration(): void {
  void saveSettings(collectSettings()).catch(() => setStatus('Speichern fehlgeschlagen.', true));
}

async function changeVoice(): Promise<void> {
  try {
    const settings = collectSettings();
    await saveSettings(settings);
    const response = await chrome.runtime.sendMessage({
      type: 'change-voice', settings
    } satisfies Message) as { ok: boolean; error?: string } | undefined;
    if (!response?.ok) throw new Error(response?.error ?? 'Stimmenwechsel fehlgeschlagen.');
    await refreshState();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function renderOutputControls(): void {
  const value = translationVolumeInput.value;
  translationValue.textContent = `${value} %`;
  translationVolumeInput.style.setProperty('--fill', `${value}%`);
  dualSubtitlesInput.disabled = !subtitlesInput.checked;
}

function updateOutputSettings(): void {
  const settings = collectSettings();
  renderOutputControls();
  void saveSettings(settings).catch(() => setStatus('Speichern fehlgeschlagen.', true));
  void chrome.runtime
    .sendMessage({
      type: 'update-output-settings',
      settings: {
        subtitles: settings.subtitles,
        subtitleMode: settings.subtitleMode,
        translationVolume: settings.translationVolume
      }
    } satisfies Message)
    .catch(() => {});
}

async function init(): Promise<void> {
  // Vor dem ersten await registrieren: Ein session-state-Broadcast während
  // des Ladens ginge sonst verloren und das Popup zeigte veralteten Status.
  chrome.runtime.onMessage.addListener((msg: Message, sender) => {
    if (!isTrustedSender(sender)) return;
    if (msg.type === 'session-state') {
      state = msg.state;
      renderState();
    }
  });

  const settings = await loadSettings();
  for (const id of VOICE_IDS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id[0]!.toUpperCase() + id.slice(1);
    voiceSelect.append(option);
  }
  voiceSelect.value = settings.liveVoice;
  liveServerUrlInput.value = settings.liveServerUrl;
  liveServerTokenInput.value = settings.liveServerToken;
  subtitlesInput.checked = settings.subtitles;
  dualSubtitlesInput.checked = settings.subtitleMode === 'dual';
  translationVolumeInput.value = String(Math.round(settings.translationVolume * 100));
  renderOutputControls();

  try {
    state = ((await chrome.runtime.sendMessage({ type: 'get-state' } satisfies Message)) ??
      state) as SessionState;
  } catch {
    state = { ...state, error: 'Erweiterungsdienst nicht erreichbar.' };
  }
  renderState();
  toggleButton.disabled = false;
  connectionDetails.open = !settings.liveServerToken;

  toggleButton.addEventListener('click', () => void onToggle());
  liveServerUrlInput.addEventListener('change', saveConfiguration);
  liveServerTokenInput.addEventListener('change', saveConfiguration);
  voiceSelect.addEventListener('change', () => void changeVoice());
  subtitlesInput.addEventListener('change', updateOutputSettings);
  dualSubtitlesInput.addEventListener('change', updateOutputSettings);
  translationVolumeInput.addEventListener('input', updateOutputSettings);
}

void init().catch((err) => {
  console.error('[live-translate] Popup-Initialisierung fehlgeschlagen:', err);
  setStatus('Popup konnte nicht geladen werden.', true);
  toggleButton.disabled = true;
});
