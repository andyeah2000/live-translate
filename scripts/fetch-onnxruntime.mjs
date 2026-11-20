import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '1.30.0';
const archives = {
  c: {
    url: 'https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.30.0.zip',
    sha256: 'e6f1670c14406fd9f082bb400ab197a9b0a9646058ca6366e440642e2b54a2ea'
  },
  objc: {
    url: 'https://download.onnxruntime.ai/pod-archive-onnxruntime-objc-1.30.0.zip',
    sha256: '0005babda7c3f585dfa2ca52c9986b42a820a91aed10dfc39d2f4cfddb61b1e8'
  }
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'macos', 'Vendor');
const framework = join(vendor, 'onnxruntime.xcframework');
const bindings = join(vendor, 'OnnxRuntimeBindings');
const stampPath = join(vendor, '.fetch-stamp');
const stamp = `${version}\n${archives.c.sha256}\n${archives.objc.sha256}\nframework-root-binary\n`;

if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp
  && existsSync(join(framework, 'Info.plist'))
  && existsSync(join(bindings, 'include', 'onnxruntime.h'))) {
  console.log(`ONNX Runtime ${version} already extracted`);
  console.log(archives.c.url);
  console.log(archives.c.sha256);
  console.log(archives.objc.url);
  console.log(archives.objc.sha256);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'onnxruntime-'));
try {
  const cZip = await download(archives.c, join(scratch, 'c.zip'));
  const objcZip = await download(archives.objc, join(scratch, 'objc.zip'));
  const cDir = join(scratch, 'c');
  const objcDir = join(scratch, 'objc');
  expand(cZip, cDir);
  expand(objcZip, objcDir);
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  cpSync(join(cDir, 'onnxruntime.xcframework'), framework, { recursive: true });
  const slice = join(framework, 'macos-arm64_x86_64', 'onnxruntime.framework');
  const binary = join(slice, 'Versions', 'A', 'onnxruntime');
  const headers = join(slice, 'Versions', 'A', 'Headers');
  rmSync(join(slice, 'onnxruntime'), { force: true });
  cpSync(binary, join(slice, 'onnxruntime'));
  rmSync(join(slice, 'Headers'), { recursive: true, force: true });
  cpSync(headers, join(slice, 'Headers'), { recursive: true });
  cpSync(join(cDir, 'Headers'), join(bindings, 'capi'), { recursive: true });
  mkdirSync(join(bindings, 'include'), { recursive: true });
  copyBindings(join(objcDir, 'objectivec'), bindings);
  writeFileSync(join(bindings, 'include', 'OnnxRuntimeBindings.h'), '#import "onnxruntime.h"\n');
  writeFileSync(stampPath, stamp);
  console.log(`ONNX Runtime ${version}`);
  console.log(archives.c.url);
  console.log(archives.c.sha256);
  console.log(archives.objc.url);
  console.log(archives.objc.sha256);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function download(archive, destination) {
  const response = await fetch(archive.url);
  if (!response.ok) throw new Error(`${archive.url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== archive.sha256) {
    throw new Error(`${archive.url} checksum ${sha256} does not match ${archive.sha256}`);
  }
  writeFileSync(destination, bytes);
  return destination;
}

function expand(archive, destination) {
  mkdirSync(destination, { recursive: true });
  const command = process.platform === 'darwin'
    ? ['ditto', ['-x', '-k', archive, destination]]
    : ['unzip', ['-q', archive, '-d', destination]];
  const result = spawnSync(command[0], command[1], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed for ${archive}`);
}

function copyBindings(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'include') continue;
    const from = join(source, entry.name);
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.h') && !entry.name.endsWith('.mm')) continue;
    cpSync(from, join(destination, entry.name));
  }
  const include = join(source, 'include');
  for (const entry of readdirSync(include, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.h')) continue;
    cpSync(join(include, entry.name), join(destination, 'include', entry.name));
  }
}
