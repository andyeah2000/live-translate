import { isTrustedSender } from './messages';
import type { Message, SessionSettings, SessionState } from './messages';
import {
  configurationError,
  isTranslatableUrl,
  liveStatsPresentation,
  popupMonitorPresentation,
  popupStatusPresentation,
  serverHealthPresentation
} from './popup-logic';
import { DEFAULT_SETTINGS, loadSettings, normalizeServerUrl, sanitizeSettings, saveSettings, VOICE_IDS } from './settings';

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Element nicht gefunden: ${selector}`);
  return found;
}

export function initializePopup(): void {
  const liveServerUrlInput = el<HTMLInputElement>('#liveServerUrl');
  const liveServerTokenInput = el<HTMLInputElement>('#liveServerToken');
  const subtitlesInput = el<HTMLInputElement>('#subtitles');
  const dualSubtitlesInput = el<HTMLInputElement>('#dualSubtitles');
  const translationVolumeInput = el<HTMLInputElement>('#translationVolume');
  const translationValue = el<HTMLElement>('#translationValue');
  const toggleButton = el<HTMLButtonElement>('#toggle');
  const monitor = el<HTMLDivElement>('#monitor');
  const statusLine = el<HTMLDivElement>('#status');
  const originalVolumeInput = el<HTMLInputElement>('#originalVolume');
  const originalValue = el<HTMLElement>('#originalValue');
  const connectionDetails = el<HTMLDetailsElement>('#connection');
  const voiceSelect = el<HTMLSelectElement>('#liveVoice');
  const languageSelect = el<HTMLSelectElement>('#sourceLanguage');
  const liveStats = el<HTMLElement>('#liveStats');
  const tabInfo = el<HTMLElement>('#tabInfo');
  const shortcut = el<HTMLElement>('#shortcut');
  const serverState = el<HTMLElement>('#serverState');

  let state: SessionState = {
    running: false,
    tabId: null,
    sessionId: null,
    status: 'Bereit',
    error: null,
    ducking: null
  };
  let stateRevision = 0;
  let operationPending = false;
  let voicePending = false;
  let localError: string | null = null;
  let connectionSettings = { liveServerUrl: '', liveServerToken: '' };

  function collectSettings(includeConnectionEdits = true): SessionSettings {
    return {
      settingsVersion: DEFAULT_SETTINGS.settingsVersion,
      liveServerUrl: includeConnectionEdits ? liveServerUrlInput.value.trim() : connectionSettings.liveServerUrl,
      liveServerToken: includeConnectionEdits ? liveServerTokenInput.value.trim() : connectionSettings.liveServerToken,
      // The server validates the selected voice and owns the translation prompt.
      liveVoice: voiceSelect.value,
      sourceLanguage: languageSelect.value === 'auto' ? 'auto' : 'en',
      subtitles: subtitlesInput.checked,
      subtitleMode: dualSubtitlesInput.checked ? 'dual' : 'translation',
      translationVolume: Number(translationVolumeInput.value) / 100,
      originalVolume: Number(originalVolumeInput.value) / 100
    };
  }

  function setStatus(text: string, isError = false): void {
    localError = isError ? text : null;
    renderStatus(text, isError);
  }

  function renderStatus(text: string, isError: boolean): void {
    statusLine.textContent = text;
    statusLine.classList.toggle('error', isError);
  }

  function renderState(): void {
    toggleButton.textContent = state.running ? 'Stop' : 'Start';
    // An active session can still be stopped while its voice is being changed.
    toggleButton.disabled = operationPending || (voicePending && !state.running);
    toggleButton.classList.toggle('running', state.running);
    toggleButton.setAttribute('aria-pressed', String(state.running));
    // Credentials stay fixed; voice changes restart through the background queue.
    liveServerUrlInput.disabled = state.running || operationPending || voicePending;
    liveServerTokenInput.disabled = state.running || operationPending || voicePending;
    voiceSelect.disabled = operationPending || voicePending;
    languageSelect.disabled = operationPending || voicePending;
    voiceSelect.title = 'Stimme wechseln – eine laufende Übersetzung startet automatisch neu';
    languageSelect.title = 'Englisch erkennt am zuverlässigsten; „Alle Sprachen“ dolmetscht jede Sprache außer Deutsch';
    const status = popupStatusPresentation(state);
    renderStatus(status.error ? status.text : (localError ?? status.text), status.error || localError !== null);
    toggleButton.title = status.text;
    renderMonitor();
    renderOutputControls();
  }

  function renderMonitor(): void {
    const presentation = popupMonitorPresentation(state);
    monitor.textContent = presentation.text;
    monitor.dataset.state = presentation.state;
    liveStats.textContent = liveStatsPresentation(state);
    renderTabInfo();
  }

  // Name the tab being translated, so a running session elsewhere is obvious.
  let tabTitle: { tabId: number; title: string } | null = null;
  function renderTabInfo(): void {
    const tabId = state.running ? state.tabId : null;
    if (tabId === null) {
      tabInfo.textContent = '';
      return;
    }
    if (tabTitle?.tabId === tabId) {
      tabInfo.textContent = `▶ ${tabTitle.title}`;
      tabInfo.title = tabTitle.title;
      return;
    }
    void chrome.tabs?.get(tabId).then(tab => {
      tabTitle = { tabId, title: tab.title || new URL(tab.url ?? 'about:blank').hostname || 'Tab' };
      renderTabInfo();
    }, () => {});
  }

  /** Server reachability and token, shown before Start; also pre-warms the OpenAI connection. */
  async function checkServer(): Promise<void> {
    const settings = sanitizeSettings(collectSettings());
    if (!settings.liveServerToken || !normalizeServerUrl(settings.liveServerUrl)) return;
    const pattern = serverPermissionPattern(settings.liveServerUrl);
    if (!pattern || !(await chrome.permissions.contains({ origins: [pattern] }).catch(() => false))) return;
    const presentation = await serverHealthPresentation(settings.liveServerUrl, settings.liveServerToken);
    serverState.textContent = presentation.text;
    serverState.dataset.state = presentation.state;
    if (presentation.state === 'error' && !state.running) connectionDetails.open = true;
  }

  async function start(): Promise<boolean> {
    try {
      const input = collectSettings();
      const validationError = configurationError(input);
      if (validationError) {
        connectionDetails.open = true;
        setStatus(validationError, true);
        return false;
      }
      const settings = sanitizeSettings(input);
      if (!(await ensureServerPermission(settings.liveServerUrl))) {
        setStatus('Der Zugriff auf den GPT-Live-Server wurde nicht erlaubt.', true);
        return false;
      }
      await saveSettings(settings);
      connectionSettings = settings;

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
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) return null;
    const url = new URL(normalized);
    return `${url.protocol}//${url.hostname}/*`;
  }

  async function ensureServerPermission(serverUrl: string): Promise<boolean> {
    const pattern = serverPermissionPattern(serverUrl);
    if (!pattern) return false;
    const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });
    if (alreadyGranted) return true;
    return chrome.permissions.request({ origins: [pattern] });
  }

  async function refreshState(reportUnavailable = false): Promise<void> {
    const revision = ++stateRevision;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'get-state' } satisfies Message);
      // A broadcast delivered while this read was pending is newer than its snapshot.
      if (stateRevision === revision && response) state = response as SessionState;
    } catch {
      if (reportUnavailable && stateRevision === revision) {
        state = { ...state, error: 'Erweiterungsdienst nicht erreichbar.' };
      }
    }
    renderState();
  }

  async function onToggle(): Promise<void> {
    if (operationPending) return;
    localError = null;
    operationPending = true;
    toggleButton.disabled = true;
    renderState();
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
      operationPending = false;
      renderState();
    }
  }

  function saveConfiguration(): void {
    localError = null;
    const settings = collectSettings();
    const validationError = configurationError(settings, false);
    if (validationError) {
      setStatus(validationError, true);
      return;
    }
    connectionSettings = sanitizeSettings(settings);
    void saveSettings(settings).then(() => {
      if (liveServerUrlInput.value.trim() === settings.liveServerUrl) {
        liveServerUrlInput.value = normalizeServerUrl(settings.liveServerUrl)!;
      }
      localError = null;
      renderState();
    }).catch(() => setStatus('Speichern fehlgeschlagen.', true));
  }

  async function changeVoice(): Promise<void> {
    if (operationPending || voicePending) return;
    voicePending = true;
    localError = null;
    renderState();
    try {
      const settings = collectSettings(false);
      await saveSettings(settings);
      const response = await chrome.runtime.sendMessage({
        type: 'restart-session', settings
      } satisfies Message) as { ok: boolean; error?: string } | undefined;
      if (!response?.ok) throw new Error(response?.error ?? 'Neustart mit den neuen Einstellungen fehlgeschlagen.');
      await refreshState();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      voicePending = false;
      renderState();
    }
  }

  function renderOutputControls(): void {
    const value = translationVolumeInput.value;
    translationValue.textContent = `${value} %`;
    translationVolumeInput.style.setProperty('--fill', `${value}%`);
    originalValue.textContent = `${originalVolumeInput.value} %`;
    originalVolumeInput.style.setProperty('--fill', `${originalVolumeInput.value}%`);
    const applyingSnapshot = operationPending || voicePending;
    translationVolumeInput.disabled = applyingSnapshot;
    originalVolumeInput.disabled = applyingSnapshot;
    subtitlesInput.disabled = applyingSnapshot;
    dualSubtitlesInput.disabled = applyingSnapshot || !subtitlesInput.checked;
  }

  function updateOutputSettings(): void {
    if (operationPending || voicePending) return;
    localError = null;
    renderState();
    const settings = collectSettings(false);
    renderOutputControls();
    void saveSettings(settings).catch(() => setStatus('Speichern fehlgeschlagen.', true));
    void chrome.runtime
      .sendMessage({
        type: 'update-output-settings',
        settings: {
          subtitles: settings.subtitles,
          subtitleMode: settings.subtitleMode,
          translationVolume: settings.translationVolume,
          originalVolume: settings.originalVolume
        }
      } satisfies Message)
      .then((response: { ok: boolean; error?: string } | undefined) => {
        if (response && !response.ok) throw new Error(response.error ?? 'Ausgabe konnte nicht aktualisiert werden.');
      })
      .catch((err) => setStatus(err instanceof Error ? err.message : 'Ausgabe konnte nicht aktualisiert werden.', true));
  }

  async function init(): Promise<void> {
    // Vor dem ersten await registrieren: Ein session-state-Broadcast während
    // des Ladens ginge sonst verloren und das Popup zeigte veralteten Status.
    chrome.runtime.onMessage.addListener((msg: Message, sender) => {
      if (!isTrustedSender(sender)) return;
      if (msg.type === 'session-state') {
        stateRevision++;
        state = msg.state;
        renderState();
      }
    });

    const settings = await loadSettings();
    connectionSettings = settings;
    for (const id of VOICE_IDS) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id[0]!.toUpperCase() + id.slice(1);
      voiceSelect.append(option);
    }
    voiceSelect.value = settings.liveVoice;
    languageSelect.value = settings.sourceLanguage;
    originalVolumeInput.value = String(Math.round(settings.originalVolume * 100));
    liveServerUrlInput.value = settings.liveServerUrl;
    liveServerTokenInput.value = settings.liveServerToken;
    subtitlesInput.checked = settings.subtitles;
    dualSubtitlesInput.checked = settings.subtitleMode === 'dual';
    translationVolumeInput.value = String(Math.round(settings.translationVolume * 100));
    renderOutputControls();

    await refreshState(true);
    toggleButton.disabled = false;
    connectionDetails.open = !settings.liveServerToken;
    void checkServer().catch(() => {});
    void chrome.commands?.getAll().then(commands => {
      const key = commands.find(command => command.name === 'toggle-translation')?.shortcut;
      shortcut.textContent = key ? `${key} startet und stoppt im aktuellen Tab` : '';
    }, () => {});

    toggleButton.addEventListener('click', () => void onToggle());
    liveServerUrlInput.addEventListener('change', () => { saveConfiguration(); void checkServer().catch(() => {}); });
    liveServerTokenInput.addEventListener('change', () => { saveConfiguration(); void checkServer().catch(() => {}); });
    voiceSelect.addEventListener('change', () => void changeVoice());
    languageSelect.addEventListener('change', () => void changeVoice());
    originalVolumeInput.addEventListener('input', updateOutputSettings);
    subtitlesInput.addEventListener('change', updateOutputSettings);
    dualSubtitlesInput.addEventListener('change', updateOutputSettings);
    translationVolumeInput.addEventListener('input', updateOutputSettings);
  }

  void init().catch((err) => {
    console.error('[live-translate] Popup-Initialisierung fehlgeschlagen:', err);
    setStatus('Popup konnte nicht geladen werden.', true);
    toggleButton.disabled = true;
  });
}

initializePopup();
