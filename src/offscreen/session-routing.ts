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
