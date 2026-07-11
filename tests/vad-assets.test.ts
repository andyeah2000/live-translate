import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MODEL_SHA256 = '7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49';

test('bundled Silero v6.2.1 model has the audited checksum', async () => {
  const model = await readFile('public/vad/silero_vad_16k_op15.onnx');
  assert.equal(createHash('sha256').update(model).digest('hex'), MODEL_SHA256);
});

test('MV3 policy permits only local worker and WASM execution', async () => {
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8')) as {
    content_security_policy?: { extension_pages?: string };
  };
  const policy = manifest.content_security_policy?.extension_pages ?? '';
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(policy, /worker-src 'self'/);
  assert.doesNotMatch(policy, /https?:/);
});
