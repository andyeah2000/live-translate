import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSigningIdentity } from '../scripts/macos-signing.mjs';

const development = 'A'.repeat(40);
const distribution = 'B'.repeat(40);
const listing = `  1) ${development} "Apple Development: Local Developer (TESTTEAM)"\n  1 valid identities found`;

test('local app builds use a stable Apple certificate instead of a changing code hash', () => {
  assert.equal(selectSigningIdentity(listing), development);
});
test('Developer ID is preferred when available for the app', () => {
  assert.equal(selectSigningIdentity(`${listing}\n  2) ${distribution} "Developer ID Application: Local Developer (TESTTEAM)"`), distribution);
});
test('missing certificates never silently produce an ad-hoc installed app', () => {
  assert.throws(() => selectSigningIdentity('0 valid identities found'), /Kein Apple-Entwicklerzertifikat/);
});
test('ambiguous signing teams require an explicit selection', () => {
  assert.throws(() => selectSigningIdentity(`${listing}\n  2) ${distribution} "Apple Development: Other Developer (OTHERTEAM)"`), /Mehrere/);
});
test('CI ad-hoc builds and explicit certificate selection remain intentional', () => {
  assert.equal(selectSigningIdentity('', '-'), '-');
  assert.equal(selectSigningIdentity(listing, ` ${distribution} `), distribution);
});
