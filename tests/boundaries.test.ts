import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { assertPluginCompatibility } from '@getpaseo/protocol/plugin-requirements';

const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const modules = ['index.client.tsx', 'index.server.ts', ...files('client'), ...files('server'), ...files('shared')];
function imports(file: string) {
  const result: string[] = [];
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      expect(node.arguments.length, `${file}: dynamic module path`).toBe(1);
      expect(ts.isStringLiteral(node.arguments[0]), `${file}: nonliteral module path`).toBe(true);
      if (ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return result;
}

// Declared admission only: these rows report what the pinned 0.15.4 evaluator admits for the
// manifest's actual requirements.paseo. They do not guarantee that any installed daemon/app pair,
// or any future Paseo version, interoperates with this plugin.
const HISTORICAL_BOUNDED_RANGE = '>=0.15.4 <0.16.0'; // Pre-#61 shipped requirement, kept only as an independent negative control.
describe('declared_paseo_range_policy_admission', () => {
  const requirements = json('paseo-plugin.json').requirements;
  const rows: Array<[version: string, admitted: boolean]> = [
    ['0.14.9', false], ['0.15.0', false], ['0.15.0-beta.1', false],
    ['0.15.1', true], ['0.15.4', true], ['0.16.0-beta.2', true], ['0.16.0', true], ['0.17.0-beta.1', true], ['1.0.0', true],
  ];
  const evaluate = (version: string, runtime: 'daemon' | 'app') => () => assertPluginCompatibility({ id: 'paseo-orbi', requirements, version, runtime });
  it('declares exactly the accepted >0.15.0 requirement in the shipped manifest', () => {
    expect(requirements).toEqual({ paseo: '>0.15.0' });
  });
  it('admits and rejects the recorded versions for both runtimes through the real evaluator', () => {
    for (const runtime of ['daemon', 'app'] as const) for (const [version, admitted] of rows) {
      if (admitted) expect(evaluate(version, runtime), `${runtime} ${version}: admitted by ${requirements.paseo}`).not.toThrow();
      else expect(evaluate(version, runtime), `${runtime} ${version}: rejected by ${requirements.paseo}`).toThrow(`requires Paseo ${requirements.paseo}`);
    }
  });
  it('keeps the historical bounded range rejecting 0.16.0-beta.2 independently of the shipped manifest', () => {
    const historicalRequirements = { paseo: HISTORICAL_BOUNDED_RANGE };
    expect(historicalRequirements.paseo).not.toBe(requirements.paseo);
    for (const runtime of ['daemon', 'app'] as const) {
      expect(() => assertPluginCompatibility({ id: 'paseo-orbi', requirements: historicalRequirements, version: '0.16.0-beta.2', runtime }), `${runtime}: historical bounded range`).toThrow(`requires Paseo ${HISTORICAL_BOUNDED_RANGE}`);
    }
  });
});

// Row-by-row qualification record: declared admission is a policy check, and a row is only
// qualified by its own installed evidence for one exact committed candidate.
const OWNER_SELECTED_ROWS = ['0.15.1', '0.15.4', '0.16.0-beta.2', '0.16.0'];
const ROW_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const UNOBSERVED = 'not observed';
const UNPINNED = 'not pinned before an authorized run';
function documentedRows() {
  const guide = read('docs/testing/qualification.md');
  const start = guide.indexOf('## Paseo version compatibility rows');
  expect(start, 'qualification report records the compatibility rows').toBeGreaterThanOrEqual(0);
  const end = guide.indexOf('\n## ', start + 1);
  const section = guide.slice(start, end === -1 ? undefined : end);
  const rows = section.split('\n').flatMap(line => {
    const cells = line.split('|').map(cell => cell.trim().replaceAll('`', ''));
    return cells.length === 7 && ROW_VERSION.test(cells[1]) ? [{ identity: cells[2], observed: cells[3], sha: cells[4], status: cells[5], version: cells[1] }] : [];
  });
  return { section, rows };
}

describe('documented_paseo_qualification_rows', () => {
  it('records exactly the four owner-selected rows, each NOT_RUN with its locked runtime identity', () => {
    const { rows } = documentedRows();
    expect(rows.map(row => row.version)).toEqual(OWNER_SELECTED_ROWS);
    for (const row of rows) {
      expect(row.status, `${row.version}: installed evidence`).toBe('NOT_RUN');
      expect(row.identity, `${row.version}: required matching runtime identity`).toContain(`@getpaseo/cli ${row.version}`);
      expect(row.observed, `${row.version}: no observed versions without a run`).toBe(UNOBSERVED);
      expect(row.sha, `${row.version}: no source SHA without a run`).toBe(UNPINNED);
    }
  });
  it('refuses to claim a qualified row without recorded versions and a source SHA', () => {
    for (const row of documentedRows().rows) {
      expect(['PASS', 'FAIL', 'NOT_RUN'], `${row.version}: status vocabulary`).toContain(row.status);
      if (row.status === 'NOT_RUN') continue;
      expect(row.observed, `${row.version}: observed versions`).not.toBe(UNOBSERVED);
      expect(row.sha, `${row.version}: source SHA`).not.toBe(UNPINNED);
    }
  });
  it('keeps every shipped compatibility statement equal to the manifest requirement', () => {
    const requirements = json('paseo-plugin.json').requirements;
    for (const doc of ['README.md', 'OVERVIEW.md', 'docs/paseo-plugins.md', 'docs/operator-guide.md', 'docs/testing/qualification.md']) {
      expect(read(doc), `${doc}: states the shipped requirement`).toContain(`\`${requirements.paseo}\``);
      expect(read(doc), `${doc}: no historical bounded range`).not.toContain(HISTORICAL_BOUNDED_RANGE);
    }
  });
});

describe('package_and_registration boundaries', () => {
  it('keeps every transitive runtime and type import in its lane', () => {
    const lanes = (file: string) => file.startsWith('index.client') || file.startsWith('client/') ? 'client' : file.startsWith('index.server') || file.startsWith('server/') ? 'server' : 'shared';
    for (const file of modules) {
      const lane = lanes(file);
      for (const name of imports(file)) {
        expect(name).not.toBe('@getpaseo/plugin/client/host');
        if (name.startsWith('.')) {
          const target = resolve(dirname(file), name);
          const match = modules.find(module => resolve(module).replace(/\.tsx?$/, '') === target);
          expect(match, `${file} -> ${name}: imported module is packaged`).toBeDefined();
          expect(dirname(match!), `${file}: no root-module imports`).not.toBe('.');
          const targetLane = lanes(match!);
          expect(targetLane === 'shared' || targetLane === lane, `${file} -> ${name}: lane`).toBe(true);
        } else if (lane === 'shared') {
          expect(['zod', '@getpaseo/plugin']).toContain(name);
        } else if (lane === 'client') {
          expect(['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@tanstack/react-query']).toContain(name);
        } else expect(name.startsWith('node:') || ['zod', 'smol-toml', '@getpaseo/plugin/server'].includes(name)).toBe(true);
      }
    }
  });
  it('has only runtime entry modules and tool configuration at root; no DOM or browser-only UI', () => {
    expect(readdirSync('.').filter(p => /\.tsx?$/.test(p)).sort()).toEqual(['index.client.tsx', 'index.server.ts', 'vitest.config.ts']);
    for (const file of ['index.client.tsx', ...files('client')]) {
      expect(read(file)).not.toMatch(/document\.|window\.|localStorage|navigator\.|className=|onClick=/);
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) expect(node.tagName.getText(source)).not.toMatch(/^[a-z]/);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(json('tsconfig.json').compilerOptions).toMatchObject({ strict: true, noEmit: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', lib: ['ES2023'] });
    expect(json('tsconfig.client.json').compilerOptions.types).toEqual(['react']);
    expect(json('tsconfig.server.json').compilerOptions.types).toEqual(['node']);
  });
  it('pins all requested dependencies and synchronized preparation inputs', () => {
    const pkg = json('package.json'), lock = json('package-lock.json');
    expect(pkg.dependencies).toEqual({ 'smol-toml': '1.9.1' });
    expect(pkg.devDependencies).toEqual({
      '@getpaseo/plugin': '0.15.4', '@getpaseo/client': '0.15.4', '@getpaseo/protocol': '0.15.4',
      react: '19.2.3', 'react-test-renderer': '19.2.3', 'react-native': '0.86.3',
      '@tanstack/react-query': '5.90.21', zod: '4.4.3', typescript: '5.9.3', '@types/react': '19.2.14',
      '@types/node': '22.19.21', vitest: '4.1.7', '@types/react-test-renderer': '19.1.0', '@playwright/test': '1.65.1',
    });
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    expect(json('paseo-plugin.json')).toEqual({ id: 'paseo-orbi', requirements: { paseo: '>0.15.0' }, build: [['npm', 'ci', '--omit=dev', '--ignore-scripts']] });
    expect(pkg.scripts).toEqual({ typecheck: 'tsc -p tsconfig.client.json && tsc -p tsconfig.server.json', test: 'vitest run', 'test:boundaries': 'vitest run tests/boundaries.test.ts',
      'test:e2e:unit': 'vitest run tests/e2e-harness.test.ts', 'test:e2e:list': 'playwright test --config tests/e2e/playwright.config.ts --list',
      'test:e2e': 'playwright test --config tests/e2e/playwright.config.ts', 'test:e2e:verify': 'node tests/e2e/evidence.mjs', 'test:e2e:typecheck': 'tsc --project tests/e2e/tsconfig.json --noEmit',
    });
    for (const file of modules) expect(pkg.files.some((included: string) => included === file || file.startsWith(included + '/'))).toBe(true);
  });
  it('isolates installed qualification tooling and keeps the default CI offline', () => {
    const server = json('tsconfig.server.json'), browser = json('tests/e2e/tsconfig.json');
    expect(server.exclude).toContain('tests/e2e/**');
    expect(server.include).toContain('tests/**/*.ts');
    expect(browser.extends).toBeUndefined(); expect(browser.compilerOptions.lib).toEqual(['ES2023', 'DOM']);
    expect(read('vitest.config.ts')).toContain("include: ['tests/**/*.test.{ts,tsx}']"); // Rooted selection never scans .orbi/ or nested .worktrees/.
    expect(read('vitest.config.ts')).toContain("exclude: [...configDefaults.exclude, 'tests/e2e/**']");
    const runtime = json('tests/e2e/runtime/package.json'), lock = json('tests/e2e/runtime/package-lock.json');
    expect(runtime.dependencies).toEqual({ '@getpaseo/cli': '0.15.4' }); expect(runtime.engines.node).toBe('22.19.0');
    expect(lock.packages[''].dependencies).toEqual(runtime.dependencies);
    for (const name of ['cli', 'client', 'server']) expect(lock.packages[`node_modules/@getpaseo/${name}`].version).toBe('0.15.4');
    expect(json('package.json').files).not.toContain('tests');
    expect(read('.github/workflows/ci.yml')).not.toContain('npm run test:e2e\n');
    const qualification = read('.github/workflows/paseo-qualification.yml');
    expect(qualification).toContain('workflow_dispatch:');
    expect(qualification).toContain('retention-days: 30');
    expect(qualification).toContain('if: always()');
    // The offline gates stop the run before any runtime/browser acquisition, disposable-daemon install or journey.
    const offlineGates = qualification.slice(qualification.indexOf('- name: Offline gates'), qualification.indexOf('- name: Explicit isolated locked runtime and browser acquisition'));
    expect(offlineGates).toContain('timeout 60 npm run test:boundaries');
    expect(offlineGates).toContain('timeout 180 npm test');
  });
  it('limits transitive runtime capabilities to read-only named imports and fixed RPCs', () => {
    const nodeImports: Record<string, string[]> = {
      'node:fs': ['constants'], 'node:fs/promises': ['lstat', 'realpath', 'stat', 'open', 'opendir', 'statfs'],
      'node:path': ['basename', 'dirname', 'resolve', 'isAbsolute', 'normalize', 'relative', 'sep'],
      'node:child_process': ['spawn'], 'node:crypto': ['createHash'],
    };
    const rpcNames: string[] = [];
    for (const file of modules) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
          const name = node.moduleSpecifier.text;
          if (name.startsWith('node:') || ['@getpaseo/plugin/server', '@getpaseo/plugin/client', '@getpaseo/plugin'].includes(name)) {
            expect(node.importClause?.name, `${file}: no default capability import`).toBeUndefined();
            const bindings = node.importClause?.namedBindings;
            expect(bindings && ts.isNamedImports(bindings), `${file}: no namespace capability import`).toBe(true);
            const allowed = name.startsWith('node:') ? nodeImports[name] : name === '@getpaseo/plugin/client' ? ['useRpc', 'useHosts'] : name === '@getpaseo/plugin' ? ['defineRpc'] : [];
            expect(allowed, `${file}: bounded node module`).toBeDefined();
            if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements.filter(b => !b.isTypeOnly)) expect(allowed).toContain((binding.propertyName ?? binding.name).text);
          }
        }
        if (ts.isCallExpression(node)) {
          expect(node.expression.kind, `${file}: no dynamic import`).not.toBe(ts.SyntaxKind.ImportKeyword);
          expect(node.expression.getText(source), `${file}: no dynamic capability loader`).not.toMatch(/^(require|eval|Function)$/);
          if (node.expression.getText(source) === 'defineRpc') {
            const arg = node.arguments[0]; expect(ts.isObjectLiteralExpression(arg)).toBe(true);
            if (ts.isObjectLiteralExpression(arg)) {
              const name = arg.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'name');
              expect(name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer)).toBe(true);
              if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer)) rpcNames.push(name.initializer.text);
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(rpcNames.sort()).toEqual(['blockers.list', 'blockers.read', 'deployments.list', 'fleet.read', 'issues.get', 'issues.list', 'runs.list', 'runs.read', 'services.control', 'services.inventory', 'workspace.shortcut']);
    const port = read('server/read-ports.ts');
    expect([...port.matchAll(/command = '([^']+)'/g)].map(m => m[1]).sort()).toEqual(['gh', 'journalctl', 'systemctl']);
    expect(port).toContain("'--method', 'GET'");
    expect(port).toContain('constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK');
    expect(port).toContain('this.children.size >= 2');
    expect(port).toContain('length > 1024 * 1024');
    expect(port).toContain('timeoutMs > 10000');
    // Presence/type only: the shortcut adapter has one fd-relative metadata read and
    // no target read, enumeration, pathname fallback or write capability.
    const shortcut = read('server/workspace-shortcut.ts');
    expect(shortcut).toContain('constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW');
    expect(shortcut).toContain('/proc/self/fd/${held.handle.fd}');
    expect(shortcut).toContain('PROC_SUPER_MAGIC = 0x9fa0n');
    // Comments may name the forbidden operations; no call may use them.
    expect(shortcut.match(/\.(readlink|realpath|opendir|readdir|readFile|writeFile|appendFile|mkdir|unlink|rename)\s*\(/g) ?? []).toEqual([]);
    expect(port).toContain('new WorkspaceShortcutInspector()');
    expect(read('shared/workspace-shortcut.ts')).not.toMatch(/directory|target:|readlink/);
  });
  it('keeps the service-control mutation boundary narrow and separate from reads', async () => {
    const adapter = read('server/service-control.ts');
    // One child-execution site, no shell, no inherited stdio, no retained output.
    expect([...adapter.matchAll(/\bspawn\s*\(/g)]).toHaveLength(1);
    expect(adapter).toContain('shell: false');
    expect(adapter).toContain("stdio: ['ignore', 'ignore', 'ignore']");
    expect(adapter).toContain('detached: true');
    expect(adapter).toContain("process.kill(-child.pid, 'SIGKILL')");
    expect(adapter).toContain('MAX_CONTROL_CHILDREN = 2');
    expect(adapter).toContain('CONTROL_TIMEOUT_MS = 10000');
    // The adapter runs only the operator-bound argv: it never names a unit,
    // builds a systemctl mutation or parses command output.
    expect(adapter).not.toMatch(/'systemctl'|'journalctl'|'--user'|shell:\s*true/);
    expect(imports('server/service-control.ts').filter(name => name.startsWith('node:'))).toEqual(['node:child_process']);
    // The request contract carries a deployment, a slot and an action only.
    const { servicesControl } = await import('../shared/service-control');
    expect(Object.keys((servicesControl.input as unknown as { shape: Record<string, unknown> }).shape).sort())
      .toEqual(['action', 'deploymentId', 'slot']);
    // Only the validated config derives the exact unit from the approved action,
    // so a display label, slug or prefix match can never become a target.
    expect(read('server/config.ts')).toContain("token === '{unit}' ? unit : token");
    expect(read('server/config.ts')).toContain('controlGrant(id: string, action: ControlAction, slot: number): ControlGrant');
    expect(read('server/service-control.ts')).not.toContain('{unit}');
    // Raw systemctl mutation is never assembled anywhere: the lifecycle command is
    // the operator's, not something this plugin invents.
    for (const file of modules) expect(read(file), file).not.toMatch(/'--user',\s*'(?:start|stop|restart|enable|disable)'/);
    // The same prohibition is enforced on the operator's grant: a system-manager or
    // privilege-escalation program is refused as the bound program.
    expect(read('server/config.ts')).toContain("forbiddenPrograms.has(basename(argv[0]))");
    expect(read('server/config.ts')).toContain("const forbiddenPrograms = new Set(['systemctl', 'systemd-run', 'env', 'sudo', 'doas', 'pkexec', 'su']);");
  });

  it('has no write, Orbi execution, Git, raw path RPC, or unconstrained command capability', () => {
    for (const file of ['index.server.ts', ...files('server')]) {
      const source = read(file);
      expect(source).not.toMatch(/\b(writeFile|appendFile|mkdir|unlink|rename|exec|execFile|spawnSync|execSync)\s*\(/);
      // Exactly two child-execution sites exist: bounded reads and the separate
      // bounded mutation adapter. No other module can start a process.
      if (!['server/read-ports.ts', 'server/service-control.ts'].includes(file)) expect(source).not.toMatch(/\bspawn\s*\(/);
      expect(source).not.toMatch(/console\.(log|error|warn)|shell:\s*true/);
    }
    expect(read('shared/common.ts')).not.toMatch(/configPath|engineSourcePath|repoDir|deployHome|trustedPublisherLogins/);
    expect(read('.github/workflows/ci.yml')).toMatch(/22\.19\.0/);
    for (const command of ['npm ci --ignore-scripts', 'npm run typecheck', 'npm test -- tests/foundation.test.ts', 'npm run test:boundaries', 'npm test', 'npm pack --dry-run --ignore-scripts']) expect(read('.github/workflows/ci.yml')).toContain(command);
  });
});

// Phone review record (#91): every required case is listed once, and only an
// inspected phone artifact may replace NOT_RUN. A Chromium/desktop viewport is
// supplementary evidence and is never phone proof.
const PHONE_CASES = [
  'unconfigured-first-screen', 'configured-work', 'services-list', 'diagnostic-detail',
  'back-to-services', 'setup-guide', 'stale-read', 'touch-actions',
  'normal-text', 'large-text', 'contrast', 'safe-area',
];
const PHONE_UNRUN_EVIDENCE = 'none';
const PHONE_UNKNOWN_DEFECT = 'unknown until the authorized run';
function documentedPhoneCases() {
  const guide = read('docs/testing/qualification.md');
  const start = guide.indexOf('## Phone Services and Work review (issue #91)');
  expect(start, 'qualification report records the phone Services/Work review').toBeGreaterThanOrEqual(0);
  const end = guide.indexOf('\n## ', start + 1);
  const section = guide.slice(start, end === -1 ? undefined : end);
  const rows = section.split('\n').flatMap(line => {
    const cells = line.split('|').map(cell => cell.trim());
    const id = cells.length === 7 ? /^`([a-z0-9-]+)`$/.exec(cells[1]) : null;
    return id ? [{ id: id[1], result: cells[3], evidence: cells[4], defect: cells[5] }] : [];
  });
  return { section, rows };
}

describe('documented_phone_services_and_work_review', () => {
  it('records every required phone case exactly once, each NOT_RUN with no invented evidence', () => {
    const { rows } = documentedPhoneCases();
    expect(rows.map(row => row.id)).toEqual(PHONE_CASES);
    for (const row of rows) {
      expect(['PASS', 'FAIL', 'NOT_RUN'], `${row.id}: status vocabulary`).toContain(row.result);
      expect(row.result, `${row.id}: no phone run is authorized`).toBe('NOT_RUN');
      expect(row.evidence, `${row.id}: evidence without an inspected phone artifact`).toBe(PHONE_UNRUN_EVIDENCE);
      expect(row.defect, `${row.id}: defect claimed without an inspected phone artifact`).toBe(PHONE_UNKNOWN_DEFECT);
    }
  });
  it('refuses a phone PASS or FAIL without an inspected artifact and a named defect', () => {
    for (const row of documentedPhoneCases().rows) {
      if (row.result === 'NOT_RUN') continue;
      expect(row.evidence, `${row.id}: PASS/FAIL needs an inspected phone artifact`).not.toBe(PHONE_UNRUN_EVIDENCE);
      expect(row.defect, `${row.id}: PASS/FAIL needs a named defect or a cleared one`).not.toBe(PHONE_UNKNOWN_DEFECT);
    }
  });
  it('keeps the consent gate, the exact candidate pre-checks and the supplementary-simulation rule', () => {
    const { section } = documentedPhoneCases();
    for (const required of ['npm run test:e2e:typecheck', 'env -u PASEO_ORBI_HOST_INVENTORY npm test', 'PASEO_ORBI_HOST_INVENTORY=1']) {
      expect(section, `phone review states ${required}`).toContain(required);
    }
    expect(section, 'a desktop viewport is never phone proof').toContain('never phone proof');
    expect(read('OVERVIEW.md'), 'overview keeps the phone review unperformed').toContain('phone Services and action review');
  });
});
