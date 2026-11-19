import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

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
    expect(json('paseo-plugin.json')).toEqual({ id: 'paseo-orbi', requirements: { paseo: '>=0.15.4 <0.16.0' }, build: [['npm', 'ci', '--omit=dev', '--ignore-scripts']] });
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
    expect(read('.github/workflows/paseo-qualification.yml')).toContain('workflow_dispatch:');
    expect(read('.github/workflows/paseo-qualification.yml')).toContain('retention-days: 30');
    expect(read('.github/workflows/paseo-qualification.yml')).toContain('if: always()');
  });
  it('limits transitive runtime capabilities to read-only named imports and fixed RPCs', () => {
    const nodeImports: Record<string, string[]> = {
      'node:fs': ['constants'], 'node:fs/promises': ['lstat', 'realpath', 'stat', 'open', 'opendir'],
      'node:path': ['dirname', 'resolve', 'isAbsolute', 'normalize', 'relative', 'sep'],
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
    expect(rpcNames.sort()).toEqual(['blockers.list', 'blockers.read', 'deployments.list', 'fleet.read', 'issues.get', 'issues.list', 'runs.list', 'runs.read', 'services.inventory']);
    const port = read('server/read-ports.ts');
    expect([...port.matchAll(/command = '([^']+)'/g)].map(m => m[1]).sort()).toEqual(['gh', 'journalctl', 'systemctl']);
    expect(port).toContain("'--method', 'GET'");
    expect(port).toContain('constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK');
    expect(port).toContain('this.children.size >= 2');
    expect(port).toContain('length > 1024 * 1024');
    expect(port).toContain('timeoutMs > 10000');
  });
  it('has no write, Orbi execution, Git, raw path RPC, or unconstrained command capability', () => {
    for (const file of ['index.server.ts', ...files('server')]) {
      const source = read(file);
      expect(source).not.toMatch(/\b(writeFile|appendFile|mkdir|unlink|rename|exec|execFile|spawnSync|execSync)\s*\(/);
      if (file !== 'server/read-ports.ts') expect(source).not.toMatch(/\bspawn\s*\(/);
      expect(source).not.toMatch(/console\.(log|error|warn)|shell:\s*true/);
    }
    expect(read('shared/common.ts')).not.toMatch(/configPath|engineSourcePath|repoDir|deployHome|trustedPublisherLogins/);
    expect(read('.github/workflows/ci.yml')).toMatch(/22\.19\.0/);
    for (const command of ['npm ci --ignore-scripts', 'npm run typecheck', 'npm test -- tests/foundation.test.ts', 'npm run test:boundaries', 'npm test', 'npm pack --dry-run --ignore-scripts']) expect(read('.github/workflows/ci.yml')).toContain(command);
  });
});
