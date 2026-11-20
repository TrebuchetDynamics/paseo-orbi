// Separate validator for the opt-in host Overview lane. It never applies or
// weakens the #12/#13 evidence contract: a missing permission, prerequisite,
// image, hash, cleanup, inspection or fixture-safety proof is NOT_RUN/FAIL.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFirstScreenshots, hostFirstTitles } from './contract.mjs';
import { pngSize, sha256, provenance, uploadSafety } from '../evidence.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const secret = /(?:[A-Z_]*(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|https?:\/\/[^\s/]+:[^\s/@]+@|[?&](?:token|password|key)=|\/home\/[^/\s]+|\/Users\/[^/\s]+)/i;
const required = hostFirstScreenshots.map(item => item.id);
const TITLES = hostFirstTitles;

export async function validateHostFirst(directory, manifest, proof) {
  const errors = [], require = (condition, message) => { if (!condition) errors.push(message); };
  const root = resolve(directory);
  require(isAbsolute(directory), 'explicit absolute output directory required');
  require(manifest.evidenceKind === 'host-first', 'evidenceKind must be host-first');
  require(['pass', 'fail', 'partial', 'not_run'].includes(manifest.status), 'invalid manifest status');
  require(/^[0-9a-f]{40}$/.test(manifest.pluginSha ?? '') && manifest.dirty === false, 'exact clean plugin provenance required');
  require(/^https:\/\/github\.com\/TrebuchetDynamics\/paseo-orbi\/issues\/32#issuecomment-\d+$/.test(manifest.approvalUrl ?? ''), 'issue-32 expanded-inventory approval URL required');
  require(text(manifest.runId) && stamp(manifest.observedAt), 'run identity and observation time required');
  require(text(manifest.artifactUrl) && /^https:\/\/github\.com\/TrebuchetDynamics\/paseo-orbi\/actions\/runs\/\d+\/artifacts\/\d+$/.test(manifest.artifactUrl), 'exact approved artifact link required');
  require(stamp(manifest.expiresAt) && Date.parse(manifest.expiresAt) > Date.parse(manifest.observedAt) && Date.parse(manifest.expiresAt) <= Date.parse(manifest.observedAt) + 31 * 86400000, 'artifact expiration required (30-day retention)');
  require(manifest.cleanup?.status === 'pass', 'ownership-aware cleanup must pass');
  require(Array.isArray(manifest.tests) && manifest.tests.length === TITLES.length && TITLES.every(title => manifest.tests.some(t => t.title === title && t.status === 'pass')), 'mandatory host-first journeys missing, failed or skipped');
  require(new Set((manifest.tests ?? []).map(t => t.id)).size === manifest.tests?.length, 'duplicate test results');
  // The fixture refusal proof is executed by the run's global setup, never asserted.
  require(proof?.refusalExitCode === 64 && proof?.unknownArgvRefused === true && proof?.allowedListArgv === true && proof?.fallback === false && proof?.inventoryFlag === true, 'safe redesign fixture proof required');
  const shots = manifest.screenshots ?? [], seen = new Set(), paths = new Set(), fixtures = await provenance();
  require(shots.length === required.length, 'evidence must contain exactly the required host-first images');
  for (const shot of shots) {
    const expected = hostFirstScreenshots.find(item => item.id === shot.id);
    require(!!expected, `unknown screenshot case: ${shot.id}`);
    require(!seen.has(shot.id), `duplicate screenshot case: ${shot.id}`); seen.add(shot.id);
    require(!paths.has(shot.path), `duplicate screenshot file: ${shot.path}`); paths.add(shot.path);
    require(shot.pluginSha === manifest.pluginSha && shot.dirty === false && stamp(shot.observedAt), `shot provenance: ${shot.id}`);
    require(shot.expected === 'pass' && shot.observed === 'pass', `shot result: ${shot.id}`);
    require(text(shot.hostAlias) && text(shot.state) && text(shot.paseoVersion), `shot host/state/version: ${shot.id}`);
    require(shot.browser === 'chromium' && shot.deviceScaleFactor === 1 && text(shot.browserVersion), `shot browser provenance: ${shot.id}`);
    const review = shot.inspection;
    require(review?.horizontalClipping === false && review?.scrollReachable === true && review?.contrast === 'pass' && review?.stateVisible === true && text(review?.reviewedBy) && stamp(review?.at), `manual image inspection missing/failed: ${shot.id}`);
    if (expected) {
      require(['scenario', 'theme'].every(key => expected[key] === shot[key]) && JSON.stringify(expected.viewport) === JSON.stringify(shot.viewport) && expected.state === shot.state, `matrix mismatch: ${shot.id}`);
      require(shot.supplemental === expected.supplemental, `supplemental marker mismatch: ${shot.id}`);
      require(shot.pixelWidth === shot.viewport?.width && shot.pixelHeight >= shot.viewport?.height, `CSS/PNG dimensions: ${shot.id}`);
    }
    require(fixtures.some(p => p.profile === shot.fixture?.profile && p.sha256 === shot.fixture?.sha256), `fixture provenance: ${shot.id}`);
    try {
      if (!text(shot.path) || isAbsolute(shot.path) || relative(root, resolve(root, shot.path)).startsWith('..') || await realpath(join(root, shot.path)) !== join(root, shot.path)) throw new Error('unsafe screenshot path');
      const bytes = await readFile(join(root, shot.path)), size = pngSize(bytes);
      require(sha256(bytes) === shot.sha256, `screenshot hash: ${shot.id}`);
      require(size.width === shot.pixelWidth && size.height === shot.pixelHeight, `PNG dimensions: ${shot.id}`);
    } catch (error) { errors.push(`screenshot file ${shot.id}: ${error.message}`); }
  }
  for (const id of required) require(seen.has(id), `missing mandatory screenshot: ${id}`);
  errors.push(...await uploadSafety(root));
  require(!secret.test(JSON.stringify(manifest)), 'secret/private-data canary in manifest');
  if (manifest.status !== 'pass') errors.push(`manifest is ${manifest.status}; not qualification success`);
  if (manifest.status === 'pass' && errors.length) errors.push('manifest claims success with invalid/missing evidence');
  const status = manifest.status === 'not_run' ? 'not_run' : manifest.status === 'fail' ? 'fail' : errors.length ? 'partial' : 'pass';
  return { status, errors };
}

async function main() {
  const directory = process.argv[2];
  if (!directory || !isAbsolute(directory)) { console.error('Usage: node tests/e2e/host-first/verify.mjs /absolute/owned/output'); process.exitCode = 1; return; }
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
  catch {
    const report = { status: 'not_run', errors: ['No host-first manifest: no authorized installed run, permission, prerequisite or image exists.'] };
    console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return;
  }
  let proof;
  try { proof = JSON.parse(await readFile(join(directory, 'fixture-proof.json'), 'utf8')); } catch { proof = null; }
  const report = await validateHostFirst(directory, manifest, proof);
  await writeFile(join(directory, 'validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'pass' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
