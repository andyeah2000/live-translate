import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageTimeoutError, withMessageTimeout } from '../src/message-timeout';

test('runtime message deadlines preserve successful responses and original failures', async () => {
  assert.deepEqual(await withMessageTimeout(Promise.resolve({ ok: true }), 50, 'timeout'), { ok: true });
  const error = new Error('closed response port');
  await assert.rejects(withMessageTimeout(Promise.reject(error), 50, 'timeout'), failure => failure === error);
});

test('a receiver holding its response port open cannot block the caller indefinitely', async () => {
  let respond!: (value: string) => void;
  const pending = new Promise<string>(resolve => { respond = resolve; });
  await assert.rejects(withMessageTimeout(pending, 10, 'response deadline'), error =>
    error instanceof MessageTimeoutError && error.message === 'response deadline');
  respond('too late');
});

test('a late response rejection is consumed after its deadline', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_resolve, fail) => { reject = fail; });
  await assert.rejects(withMessageTimeout(pending, 10, 'response deadline'), MessageTimeoutError);
  reject(new Error('late port close'));
  await Promise.resolve();
});
