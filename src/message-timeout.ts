/** A runtime message can retain its response port forever; never block Stop on it. */
export class MessageTimeoutError extends Error {}

export function withMessageTimeout<T>(
  response: Promise<T>,
  timeoutMs: number,
  detail: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MessageTimeoutError(detail)), timeoutMs);
    response.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}
