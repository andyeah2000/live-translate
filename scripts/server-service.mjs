// Installs or removes the macOS LaunchAgent that keeps the GPT-Live server running.
//   npm run service:install    start at login, restart after a crash
//   npm run service:uninstall  stop and remove
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.andreas.live-translate';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = join(homedir(), 'Library', 'Logs', 'LiveTranslate');
const domain = `gui/${userInfo().uid}`;

// The Homebrew symlink survives `brew upgrade`; the resolved Cellar path does not.
const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(path => existsSync(path)) ?? process.execPath;
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (process.argv.includes('--uninstall')) {
  launchctl('bootout', `${domain}/${LABEL}`);
  rmSync(plistPath, { force: true });
  console.log('Live Translate Server-Dienst entfernt.');
  process.exit(0);
}

const envFile = join(repo, '.env.local');
if (!existsSync(envFile)) {
  console.error(`Fehlt: ${envFile} (OPENAI_API_KEY und LIVE_TRANSLATE_SERVER_TOKEN).`);
  process.exit(1);
}
mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(logDir, { recursive: true });
writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>--env-file=${xml(envFile)}</string>
    <string>${xml(join(repo, 'server', 'live-server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'server.err.log'))}</string>
</dict>
</plist>
`);
// Replace a running instance so new server code takes effect.
launchctl('bootout', `${domain}/${LABEL}`);
if (!launchctl('bootstrap', domain, plistPath)) {
  console.error('launchctl bootstrap fehlgeschlagen. Läuft schon ein anderer Server auf Port 8787?');
  process.exit(1);
}
console.log(`Live Translate Server läuft jetzt dauerhaft (startet beim Login). Logs: ${logDir}`);
