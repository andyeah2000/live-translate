/**
 * Resumes a suspended AudioContext with a hard deadline and verifies the
 * resulting state. Chrome may resolve resume() without actually reaching
 * "running"; that must fail visibly instead of triggering an endless retry
 * loop in the 50-ms control tick.
 */
export function resumeAudioContextWithTimeout(
  ctx: AudioContext,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error(`Die Audio-Engine reagiert nicht (Status: ${ctx.state}).`)),
      timeoutMs
    );
    ctx.resume().then(
      () => {
        globalThis.clearTimeout(timer);
        if (ctx.state === 'running') {
          resolve();
        } else {
          reject(
            new Error(`Die Audio-Engine konnte nicht fortgesetzt werden (Status: ${ctx.state}).`)
          );
        }
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
