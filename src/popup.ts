import type { Message, SessionSettings, SessionState } from './messages';
import {
  configurationError,
  isTranslatableUrl,
  popupMonitorPresentation,
  popupStatusPresentation
} from './popup-logic';
import { loadSettings, saveSettings } from './settings';

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Element nicht gefunden: ${selector}`);
  return found;
}

const geminiKeyInput = el<HTMLInputElement>('#geminiKey');
const targetLanguageSelect = el<HTMLSelectElement>('#targetLanguage');
const subtitlesInput = el<HTMLInputElement>('#subtitles');
const translationVolumeInput = el<HTMLInputElement>('#translationVolume');
const translationValue = el<HTMLElement>('#translationValue');
const toggleButton = el<HTMLButtonElement>('#toggle');
const monitor = el<HTMLDivElement>('#monitor');
const statusLine = el<HTMLDivElement>('#status');

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
    settingsVersion: 7,
    geminiKey: geminiKeyInput.value.trim(),
    targetLanguage: targetLanguageSelect.value,
    subtitles: subtitlesInput.checked,
    translationVolume: Number(translationVolumeInput.value) / 100
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
  geminiKeyInput.disabled = state.running;
  targetLanguageSelect.disabled = state.running;
  const status = popupStatusPresentation(state);
  setStatus(status.text, status.error);
  renderMonitor();
}

function renderMonitor(): void {
  const presentation = popupMonitorPresentation(state);
  monitor.textContent = presentation.text;
  monitor.dataset.state = presentation.state;
}

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

function updateOutputSettings(): void {
  const settings = collectSettings();
  translationValue.textContent = `${translationVolumeInput.value}%`;
  void saveSettings(settings).catch(() => setStatus('Speichern fehlgeschlagen.', true));
  void chrome.runtime
    .sendMessage({
      type: 'update-output-settings',
      settings: {
        subtitles: settings.subtitles,
        translationVolume: settings.translationVolume
      }
    } satisfies Message)
    .catch(() => {});
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  geminiKeyInput.value = settings.geminiKey;
  targetLanguageSelect.value = settings.targetLanguage;
  subtitlesInput.checked = settings.subtitles;
  translationVolumeInput.value = String(Math.round(settings.translationVolume * 100));
  translationValue.textContent = `${translationVolumeInput.value}%`;

  try {
    state = ((await chrome.runtime.sendMessage({ type: 'get-state' } satisfies Message)) ??
      state) as SessionState;
  } catch {
    state = { ...state, error: 'Erweiterungsdienst nicht erreichbar.' };
  }
  renderState();

  toggleButton.addEventListener('click', () => void onToggle());
  geminiKeyInput.addEventListener('change', saveConfiguration);
  targetLanguageSelect.addEventListener('change', saveConfiguration);
  subtitlesInput.addEventListener('change', updateOutputSettings);
  translationVolumeInput.addEventListener('input', updateOutputSettings);
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg.type === 'session-state') {
      state = msg.state;
      renderState();
    }
  });
}

void init().catch((err) => {
  console.error('[live-translate] Popup-Initialisierung fehlgeschlagen:', err);
  setStatus('Popup konnte nicht geladen werden.', true);
  toggleButton.disabled = true;
});
