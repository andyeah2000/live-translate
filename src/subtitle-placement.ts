/** Pure placement helpers keep fullscreen subtitle behavior testable. */
export function subtitleFullscreenElement(fullscreen: Element | null): Element | null {
  // document.fullscreenElement is retargeted to a web component's host.
  // Follow accessible shadow roots to the actual player/container.
  let current = fullscreen;
  while (current?.shadowRoot?.fullscreenElement) current = current.shadowRoot.fullscreenElement;
  return current;
}

export function subtitleOverlayTarget(
  fullscreen: Element | null,
  body: HTMLElement | null,
  documentElement: HTMLElement
): Element {
  const target = subtitleFullscreenElement(fullscreen);
  return target && target.tagName !== 'VIDEO' && target.tagName !== 'IFRAME'
    ? target
    : (body ?? documentElement);
}

export function placeSubtitleHost(host: HTMLElement, target: Element): void {
  if (host.parentNode !== target) target.appendChild(host);
}
