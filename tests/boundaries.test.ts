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
      '@types/node': '22.19.21', vitest: '4.1.7', '@types/react-test-renderer': '19.1.0',
    });
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    expect(json('paseo-plugin.json')).toEqual({ id: 'paseo-orbi', requirements: { paseo: '>=0.15.4 <0.16.0' }, build: [['npm', 'ci', '--omit=dev', '--ignore-scripts']] });
    expect(pkg.scripts).toEqual({ typecheck: 'tsc -p tsconfig.client.json && tsc -p tsconfig.server.json', test: 'vitest run', 'test:boundaries': 'vitest run tests/boundaries.test.ts' });
    for (const file of modules) expect(pkg.files.some((included: string) => included === file || file.startsWith(included + '/'))).toBe(true);
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
