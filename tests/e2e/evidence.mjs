import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

export const views = ['fleet', 'issues', 'runs', 'blockers'];
export const themes = ['light', 'dark'];
export const viewports = [{ width: 375, height: 667 }, { width: 768, height: 1024 }, { width: 1920, height: 1080 }];
export const matrix = [
  ...views.flatMap(view => themes.flatMap(theme => viewports.map(viewport => ({ view, theme, viewport, scenario: 'available' })))),
  ...views.flatMap(view => ['empty', 'partial', 'stale', 'unavailable'].map(scenario => ({ view, scenario, theme: 'dark', viewport: viewports[0] }))),
  ...['unconfigured', 'rejected-profile'].map(scenario => ({ view: 'catalog', scenario, theme: 'light', viewport: viewports[2] })),
].map(c => ({ ...c, id: `${c.view}-${c.scenario}-${c.theme}-${c.viewport.width}x${c.viewport.height}` }));
export const functionalTitles = [
  ...views.flatMap(view => [`[smoke] ${view}: sidebar, deployment, actual detail, keyboard and narrow scrolling`, ...['empty', 'partial', 'unavailable', 'stale'].map(s => `${view}: ${s}, external repair and safe Refresh`)]),
  'invalid and missing configuration, unknown source profile refuse telemetry',
  'refresh coalesces, polls at 30 seconds and selection-only detail ages at 60 seconds',
  'two hosts with identical labels/IDs: selected detail/page, late result, no fallback and disconnect/reconnect',
];
export const requiredTests = [
  ...functionalTitles.map(title => ({ browser: 'chromium', title })),
  ...matrix.map(c => ({ browser: 'chromium', title: `screenshot ${c.id}` })),
  ...['firefox', 'webkit'].flatMap(browser => functionalTitles.filter(t => t.startsWith('[smoke]')).map(title => ({ browser, title }))),
];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function pngSize(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 20000 || height > 100000) throw new Error('Invalid PNG dimensions');
  const crc = buffer => { let n = 0xffffffff; for (const byte of buffer) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunks = []; let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG');
    if (crc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error('Corrupt PNG checksum');
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') { ended = true; if (offset !== bytes.length) throw new Error('Trailing PNG data'); break; }
  }
  if (!ended || !chunks.length) throw new Error('Invalid PNG data');
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: 256 * 1024 * 1024 });
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[bytes[25]], depth = bytes[24];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || bytes[28] !== 0) throw new Error('Unsupported PNG encoding');
  const stride = Math.ceil(width * channels * depth / 8) + 1;
  if (pixels.length !== stride * height) throw new Error('PNG pixel dimensions mismatch');
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) throw new Error('Invalid PNG row filter');
  return { width, height };
}
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const secret = /(?:[A-Z_]*(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|https?:\/\/[^\s/]+:[^\s/@]+@|[?&](?:token|password|key)=|\/home\/[^/\s]+|\/Users\/[^/\s]+)/i;
export async function provenance() {
  return Promise.all(['release', 'installed'].map(async profile => ({ profile, sha256: sha256(await readFile(new URL(`../helpers/${profile}.json.gz`, import.meta.url))) })));
}
export async function uploadSafety(root) {
  const errors = [];
  const scan = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) { errors.push('symlink in evidence'); continue; }
    if (entry.isDirectory()) await scan(path);
    else {
      if (!/\.(?:png|json|md|log)$/.test(entry.name)) errors.push('unreviewed evidence file type');
      if (secret.test((await readFile(path)).toString('utf8'))) errors.push(`secret/private-data canary in ${relative(root, path)}`);
    }
  } }; await scan(root); return errors;
}
export async function validate(directory, manifest) {
  const errors = [], require = (condition, message) => { if (!condition) errors.push(message); };
  const root = resolve(directory);
  require(isAbsolute(directory), 'explicit absolute output directory required');
  require(['browser', 'native'].includes(manifest.evidenceKind), 'evidenceKind must be browser or native');
  require(['pass', 'fail', 'partial'].includes(manifest.status), 'invalid manifest status');
  require(/^[0-9a-f]{40}$/.test(manifest.pluginSha ?? '') && manifest.dirty === false, 'exact clean plugin provenance required');
  require(/^https:\/\/github\.com\/TrebuchetDynamics\/paseo-orbi\/issues\/(12|13)#issuecomment-\d+$/.test(manifest.approvalUrl ?? ''), 'record owner approval URL');
  require(text(manifest.runId) && stamp(manifest.observedAt), 'run identity and observation time required');
  require(text(manifest.artifactUrl) && /^https:\/\/github\.com\/TrebuchetDynamics\/paseo-orbi\/actions\/runs\/\d+\/artifacts\/\d+$/.test(manifest.artifactUrl), 'exact run/artifact link required');
  require(stamp(manifest.expiresAt) && Date.parse(manifest.expiresAt) > Date.parse(manifest.observedAt) && Date.parse(manifest.expiresAt) <= Date.parse(manifest.observedAt) + 31 * 86400000, 'artifact expiration required (30-day retention)');
  require(manifest.tests?.length > 0 && manifest.tests.every(t => t.status === 'pass' && text(t.id)), 'mandatory tests missing, failed or skipped');
  require(new Set((manifest.tests ?? []).map(t => t.id)).size === manifest.tests?.length, 'duplicate test results');
  require(manifest.cleanup?.status === 'pass', 'cleanup must pass');
  const shots = manifest.screenshots ?? [], seen = new Set(), paths = new Set(), fixtures = await provenance();
  let required = [];
  if (manifest.evidenceKind === 'browser') {
    required = matrix.map(c => c.id);
    require(manifest.executionStatus === 'passed', 'whole browser run must pass, including setup/teardown');
    for (const test of requiredTests) require(manifest.tests?.some(t => t.browser === test.browser && t.title === test.title && t.status === 'pass'), `mandatory test missing/failed: ${test.browser}: ${test.title}`);
    require(manifest.daemonVersion === '0.15.4' && manifest.appVersion === '0.15.4' && manifest.playwrightVersion === '1.65.1' && manifest.nodeVersion === 'v22.19.0', 'pinned browser/runtime versions required');
    require(['chromium', 'firefox', 'webkit'].every(browser => manifest.tests?.some(t => t.browser === browser && t.status === 'pass')), 'three-engine functional smoke required');
  } else if (manifest.evidenceKind === 'native') {
    const targets = manifest.targets ?? [];
    require(targets.length === 3 && new Set(targets.map(t => t.platform)).size === 3 && ['desktop', 'ios', 'android'].every(p => targets.some(t => t.platform === p)), 'preserve three required native platform slots');
    require(new Set(targets.map(t => t.id)).size === targets.length, 'duplicate native targets');
    for (const target of targets) {
      require(text(target.id) && ['physical', 'simulator', 'emulator'].includes(target.targetClass), 'invalid native target identity/class');
      require(['pass', 'fail', 'not_run'].includes(target.status), 'invalid native target status');
      require(target.status === 'not_run' ? text(target.missingInput) : text(target.osVersion) && target.osVersion !== 'unknown' && text(target.paseoVersion) && target.paseoVersion !== 'unknown', 'named native versions or exact missingInput required');
      if (target.status === 'pass') required.push(...views.flatMap(view => themes.map(theme => `${target.id}-${view}-available-${theme}`)));
    }
    require(targets.length === 3 && targets.every(t => t.status === 'pass'), 'full-native PASS requires all three targets passing; partial is non-success');
  }
  for (const shot of shots) {
    require(text(shot.id) && !seen.has(shot.id), `duplicate/missing screenshot case: ${shot.id}`); seen.add(shot.id);
    require(!paths.has(shot.path), `duplicate screenshot file: ${shot.path}`); paths.add(shot.path);
    require(shot.pluginSha === manifest.pluginSha && shot.dirty === false && stamp(shot.observedAt), `shot provenance: ${shot.id}`);
    require(shot.expected === 'pass' && shot.observed === 'pass', `shot result: ${shot.id}`);
    require(themes.includes(shot.theme) && text(shot.scenario) && text(shot.hostAlias), `shot state: ${shot.id}`);
    const review = shot.inspection;
    require(review?.horizontalClipping === false && review?.scrollReachable === true && review?.contrast === 'pass' && review?.stateVisible === true && text(review?.reviewedBy) && stamp(review?.at), `manual image inspection missing/failed: ${shot.id}`);
    if (manifest.evidenceKind === 'browser') {
      const expected = matrix.find(c => c.id === shot.id);
      require(!!expected || shot.supplemental === true, `unknown required case: ${shot.id}`);
      if (expected) require(['view', 'theme', 'scenario'].every(k => expected[k] === shot[k]) && JSON.stringify(expected.viewport) === JSON.stringify(shot.viewport), `matrix mismatch: ${shot.id}`);
      require(shot.browser === 'chromium' && text(shot.browserVersion) && shot.deviceScaleFactor === 1 && shot.daemonVersion === manifest.daemonVersion && shot.appVersion === manifest.appVersion && shot.playwrightVersion === manifest.playwrightVersion, `shot tool versions: ${shot.id}`);
      require(fixtures.some(p => p.profile === shot.fixture?.profile && p.sha256 === shot.fixture?.sha256), `fixture provenance: ${shot.id}`);
      require(shot.pixelWidth === shot.viewport?.width && shot.pixelHeight >= shot.viewport?.height, `CSS/PNG dimensions: ${shot.id}`);
    } else {
      const target = manifest.targets?.find(t => t.id === shot.targetId);
      require(!!target && shot.appVersion === target.paseoVersion && shot.id === `${shot.targetId}-${shot.view}-${shot.scenario}-${shot.theme}`, `native target provenance: ${shot.id}`);
      require(shot.viewport === undefined && shot.deviceScaleFactor === undefined && text(shot.daemonVersion) && text(shot.toolVersion) && text(shot.fixture?.profile) && /^[0-9a-f]{64}$/.test(shot.fixture?.sha256 ?? ''), `native pixel/tool provenance: ${shot.id}`);
    }
    try {
      if (!text(shot.path) || isAbsolute(shot.path) || relative(root, resolve(root, shot.path)).startsWith('..') || await realpath(join(root, shot.path)) !== join(root, shot.path)) throw new Error('unsafe screenshot path');
      const bytes = await readFile(join(root, shot.path)), size = pngSize(bytes);
      require(sha256(bytes) === shot.sha256, `screenshot hash: ${shot.id}`);
      require(size.width === shot.pixelWidth && size.height === shot.pixelHeight, `PNG dimensions: ${shot.id}`);
    } catch (e) { errors.push(`screenshot file ${shot.id}: ${e.message}`); }
  }
  for (const id of required) require(seen.has(id), `missing mandatory screenshot: ${id}`);
  // Reject secrets in ALL output files, including failures. No raw zip traces may be uploaded.
  errors.push(...await uploadSafety(root));
  require(!secret.test(JSON.stringify(manifest)), 'secret/private-data canary in manifest');
  if (manifest.status === 'pass' && errors.length) errors.push('manifest claims success with invalid/missing evidence');
  if (manifest.status !== 'pass') errors.push(`manifest is ${manifest.status}; not qualification success`);
  return { status: errors.length ? 'partial' : 'pass', errors };
}

// Playwright reporter: retains only sanitized test outcomes, never raw errors/traces.
export default class EvidenceReporter {
  tests = [];
  output;
  ownedRoot;
  onBegin() {
    if (process.argv.includes('--list')) return;
    // Capture the successful global setup lease before teardown removes it.
    // An approval/startup failure must not overwrite an existing output path.
    try {
      const lease = JSON.parse(readFileSync(process.env.PASEO_E2E_LEASE, 'utf8'));
      if (isAbsolute(lease.input.output) && lease.input.output === process.env.PASEO_E2E_OUTPUT) {
        this.output = lease.input.output; this.ownedRoot = lease.root;
      }
    } catch { /* no successful owned setup */ }
  }
  async saveFailure(message) {
    if (process.argv.includes('--list')) return;
    const output = this.output;
    if (!output) return;
    try {
      let safe = message.split(process.cwd()).join('[CHECKOUT]');
      if (this.ownedRoot) safe = safe.split(this.ownedRoot).join('[OWNED]');
      safe = safe.replace(/(?:[A-Z_]*(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|https?:\/\/[^\s/]+:[^\s/@]+@|[?&](?:token|password|key)=[^\s&]+|\/home\/[^\s:]+|\/Users\/[^\s:]+)/gi, '[REDACTED]');
      await writeFile(join(output, 'test-failure.log'), safe.slice(-262144));
    } catch { /* missing approval/output must never create runtime state */ }
  }
  async onError(error) { await this.saveFailure(error.message ?? 'Runner failed'); }
  async onTestEnd(test, result) {
    this.tests.push({ id: test.titlePath().join(' / '), title: test.title, browser: test.parent.project()?.name, status: result.status === 'passed' ? 'pass' : result.status === 'skipped' ? 'skip' : 'fail' });
    if (result.errors.length) await this.saveFailure(result.errors.map(e => e.message ?? 'Test failed').join('\n'));
  }
  async onEnd(result) {
    const output = this.output;
    if (!output) return;
    try {
      let receipt;
      try { receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8')); }
      catch { receipt = { pluginSha: process.env.PASEO_E2E_CANDIDATE_SHA, dirty: false, evidenceKind: 'browser', approval: process.env.PASEO_E2E_APPROVAL_URL, observedAt: new Date().toISOString() }; }
      const shots = (await readdir(output)).filter(n => n.endsWith('.shot.json'));
      const screenshots = await Promise.all(shots.map(async n => JSON.parse(await readFile(join(output, n), 'utf8'))));
      const cleanup = JSON.parse(await readFile(join(output, 'cleanup.json'), 'utf8'));
      const manifest = { ...receipt, runId: output.split('/').at(-1), approvalUrl: receipt.approval, status: 'partial', tests: this.tests, screenshots, cleanup,
        artifactUrl: null, expiresAt: null, executionStatus: result.status };
      await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await writeFile(join(output, 'index.md'), '# Installed Paseo qualification\n\nPartial until mandatory tests, cleanup and manual image inspection pass, and exact artifact link/expiration are recorded. Artifacts expire after 30 days. Browser emulation is not native evidence.\n\n' + screenshots.map(s => `- [${s.id}](${s.path}) (${s.pixelWidth}×${s.pixelHeight} PNG)`).join('\n'));
    } catch { /* startup failure already retains sanitized logs; validation fails closed */ }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const safetyOnly = process.argv[2] === '--check-upload';
  const directory = process.argv[safetyOnly ? 3 : 2];
  if (!directory || !isAbsolute(directory)) { console.error('Usage: npm run test:e2e:verify -- /absolute/owned/output'); process.exitCode = 1; }
  else {
    try { if (safetyOnly) { const errors = await uploadSafety(directory); if (errors.length) throw new Error(errors.join('; ')); console.log('Evidence upload safety check passed (not qualification success)'); }
    else { const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), report = await validate(directory, manifest); await writeFile(join(directory, 'validation.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'pass' ? 0 : 1; } }
    catch (e) { console.error(`Evidence rejected: ${e.message}`); process.exitCode = 1; }
  }
}
