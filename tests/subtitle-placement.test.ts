import assert from 'node:assert/strict';
import test from 'node:test';
import { placeSubtitleHost, subtitleOverlayTarget } from '../src/subtitle-placement';

function element(tagName: string): Element {
  return { tagName } as Element;
}

test('subtitle overlay follows a fullscreen container and returns to the body', () => {
  const body = element('BODY') as HTMLElement;
  const root = element('HTML') as HTMLElement;
  const container = element('DIV');

  assert.equal(subtitleOverlayTarget(null, body, root), body);
  assert.equal(subtitleOverlayTarget(container, body, root), container);
  assert.equal(subtitleOverlayTarget(element('VIDEO'), body, root), body);
  assert.equal(subtitleOverlayTarget(element('IFRAME'), body, root), body);

  const host = { parentNode: body } as unknown as HTMLElement;
  const appended: Element[] = [];
  const fullscreenTarget = {
    appendChild(node: Node) {
      (node as unknown as { parentNode: Element }).parentNode = this as unknown as Element;
      appended.push(node as Element);
      return node;
    }
  } as unknown as Element;
  placeSubtitleHost(host, fullscreenTarget);
  placeSubtitleHost(host, fullscreenTarget);
  assert.deepEqual(appended, [host], 'already placed hosts must not be appended twice');

  const bodyTarget = {
    appendChild(node: Node) {
      (node as unknown as { parentNode: Element }).parentNode = this as unknown as Element;
      return node;
    }
  } as unknown as Element;
  placeSubtitleHost(host, bodyTarget);
  assert.equal(host.parentNode, bodyTarget);
});
