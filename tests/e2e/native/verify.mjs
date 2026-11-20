import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../evidence.mjs';

// Exactly the two diagnostics a Linux-only native delivery must still produce:
// mobile is deferred, so full-native success is neither claimed nor waivable.
export const KNOWN_PARTIAL = [
  'full-native PASS requires all three targets passing; partial is non-success',
  'manifest is partial; not qualification success',
];
const text = value => typeof value === 'string' && value.trim().length > 0;
const ownerDeferred = value => /owner[- ]deferred/i.test(typeof value === 'string' ? value : '');

// Structural checks come first. Three not_run targets with no screenshots otherwise
// produce the same two diagnostics without proving any Linux image integrity.
export function structure(manifest) {
  const errors = [], require = (condition, message) => { if (!condition) errors.push(message); };
  require(manifest?.evidenceKind === 'native', 'evidenceKind must be native');
  require(manifest?.status === 'partial', 'manifest must stay partial: Linux-only evidence is not full-native success');
  const targets = Array.isArray(manifest?.targets) ? manifest.targets : [];
  const desktops = targets.filter(target => target?.platform === 'desktop');
  require(desktops.length === 1, 'exactly one Linux desktop target required');
  const desktop = desktops[0];
  if (desktop) {
    require(desktop.status === 'pass', 'Linux desktop target must pass before this wrapper can report integrity');
    require(desktop.targetClass === 'emulator', 'Linux desktop target must stay emulator (virtual display), never physical');
    require(text(desktop.osVersion) && desktop.osVersion !== 'unknown' && desktop.paseoVersion === '0.15.4', 'named Linux desktop OS and Paseo versions required');
    const display = desktop.virtualDisplay ?? {};
    require(display.server === 'Xvfb' && /^:[0-9]+$/.test(display.display ?? '') && text(display.socket), 'explicit Xvfb virtual-display provenance required');
  }
  for (const platform of ['ios', 'android']) {
    const target = targets.find(candidate => candidate?.platform === platform);
    require(!!target && target.status === 'not_run' && ownerDeferred(target.missingInput), `${platform} must stay not_run with an owner-deferred reason`);
  }
  return errors;
}
export async function verifyNative(directory, effects = { validate }) {
  const errors = [];
  if (!isAbsolute(directory)) return { ok: false, errors: ['explicit absolute downloaded evidence directory required'], diagnostics: [], validation: null };
  let manifest;
  try { manifest = JSON.parse(await readFile(join(resolve(directory), 'manifest.json'), 'utf8')); }
  catch (error) { return { ok: false, errors: [`manifest unavailable: ${error.message}`], diagnostics: [], validation: null }; }
  errors.push(...structure(manifest));
  let validation;
  try { validation = await effects.validate(resolve(directory), manifest); }
  catch (error) { errors.push(`validator rejected or failed closed: ${error?.message ?? error}`); return { ok: false, errors, diagnostics: [], validation: null }; }
  if (validation?.status !== 'partial') errors.push('raw validator must report partial for a Linux-only native delivery');
  const actual = [...new Set(validation?.errors ?? [])].sort(), expected = [...KNOWN_PARTIAL].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`validator diagnostics must be exactly the two known full-native ones, got ${JSON.stringify(actual)}`);
  return { ok: errors.length === 0, errors, diagnostics: validation?.errors ?? [], validation };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory || !isAbsolute(directory)) { console.error('Usage: node tests/e2e/native/verify.mjs /absolute/downloaded/native-evidence'); process.exitCode = 1; }
  else {
    try {
      const result = await verifyNative(directory);
      await writeFile(join(directory, 'native-validation.json'), JSON.stringify({ wrapper: { ok: result.ok, errors: result.errors }, raw: result.validation }, null, 2));
      console.log('Raw evidence.mjs validate() result — a Linux-only delivery is expected to be partial with a nonzero raw exit:');
      console.log(JSON.stringify(result.validation, null, 2));
      console.log(result.ok
        ? 'Linux native evidence integrity PASS. Journeys, visual inspection and full-native success are not proven here; iOS/Android stay deferred.'
        : `Linux native evidence integrity FAIL: ${result.errors.join('; ')}`);
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) { console.error(`Native evidence rejected: ${error.message}`); process.exitCode = 1; }
  }
}
