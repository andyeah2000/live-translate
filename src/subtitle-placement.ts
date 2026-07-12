/** Pure placement helpers keep fullscreen subtitle behavior testable. */
export function subtitleOverlayTarget(
  fullscreen: Element | null,
  body: HTMLElement | null,
  documentElement: HTMLElement
): Element {
  return fullscreen && fullscreen.tagName !== 'VIDEO' && fullscreen.tagName !== 'IFRAME'
    ? fullscreen
    : (body ?? documentElement);
}

export function placeSubtitleHost(host: HTMLElement, target: Element): void {
  if (host.parentNode !== target) target.appendChild(host);
}
