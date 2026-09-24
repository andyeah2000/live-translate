import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(root, 'macos');
execFileSync('swift', ['build', '--package-path', packagePath, '-c', 'release'], { stdio: 'inherit' });
const bin = execFileSync('swift', ['build', '--package-path', packagePath, '-c', 'release', '--show-bin-path'], { encoding: 'utf8' }).trim();
const app = join(packagePath, 'build', 'Live Translate.app');
mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
cpSync(join(bin, 'LiveTranslate'), join(app, 'Contents', 'MacOS', 'LiveTranslate'));
cpSync(join(packagePath, 'Sources', 'LiveTranslateCore', 'Resources', 'translation-profile.json'), join(app, 'Contents', 'Resources', 'translation-profile.json'));
const iconset = join(packagePath, 'build', 'AppIcon.iconset');
execFileSync('swift', [join(root, 'scripts', 'macos-icon.swift'), iconset], { stdio: 'inherit' });
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents', 'Resources', 'AppIcon.icns')], { stdio: 'inherit' });
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.andyeah.live-translate</string>
<key>CFBundleName</key><string>Live Translate</string>
<key>CFBundleDisplayName</key><string>Live Translate</string>
<key>CFBundleExecutable</key><string>LiveTranslate</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Live Translate nimmt den Ton deiner gewählten App oder den Systemton auf und übersetzt ihn mit OpenAI ins Deutsche. Es werden keine Bildschirmbilder gespeichert oder übertragen.</string>
<key>NSAudioCaptureUsageDescription</key><string>Systemaudio wird während deiner gestarteten Übersetzung an OpenAI gesendet. Die eigene Übersetzerstimme wird ausgeschlossen.</string>
</dict></plist>
`);
execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'org.andyeah.live-translate', app], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
console.log(app);
