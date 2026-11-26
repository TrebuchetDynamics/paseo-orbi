import { afterEach, describe, it, expect } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contractFacts } from '../server/contract-facts';
import { fixture } from './helpers/fixtures';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanups: (() => unknown)[] = [];
async function setup() { const f = await fixture('v0765'); cleanups.push(f.cleanup); return f; }
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// One file of the fixture engine checkout, edited as text — never imported.
async function edit(f: Fixture, path: string, change: (text: string) => string) {
  const file = join(f.source, path);
  const text = await readFile(file, 'utf8');
  const next = change(text);
  expect(next, `${path}: the edit applied`).not.toBe(text);
  await writeFile(file, next);
}
const replace = (from: string, to: string) => (text: string) => text.replace(from, to);
const append = (extra: string) => (text: string) => text + extra;
const drop = (line: string) => (text: string) => text.split('\n').filter(entry => entry !== line).join('\n');

const DISPOSITIONS = 'DISPOSITIONS: dict[str, tuple[str, bool]] = {';

// The complete v0.7.65 fact set: every kind of this reader, verified by hand
// against the pinned engine source (a37c005c).
const V0765_FACTS = [
  'active AWAITING_MERGE_LABEL', 'active FIX_NEEDED_LABEL', 'active IN_PROGRESS_LABEL', 'active PR_OPENED_LABEL',
  'config deploy_home=none', 'config max_concurrency=1', 'config repo_dir="."', 'config source_repos=none', 'config unit_name=none',
  'disposition attachment_unavailable=fix_ticket:false', 'disposition base_branch_missing=fix_ticket:false',
  'disposition base_ci_red=fix_ticket:false', 'disposition checks_permission_missing=check_credentials:false',
  'disposition credential_missing=check_credentials:false', 'disposition github_transient=requeue:true',
  'disposition human_decision_required=decide:false', 'disposition no_commit_delivered=fix_ticket:false',
  'disposition no_file_change=fix_ticket:false', 'disposition provider_balance=top_up_balance:false',
  'disposition provider_quota=wait_quota:true', 'disposition release_failed=fix_ticket:false',
  'disposition review_budget_exhausted=decide:false', 'disposition tests_failed=fix_ticket:false',
  'disposition unclassified=fix_ticket:false',
  'journal run_end', 'journal run_start', 'journal worktree_cleaned', 'journal worktree_retained',
  'journal-format levelname-message', 'journal-format run-id-prefix',
  'label awaiting_merge=ai-awaiting-merge', 'label blocked=ai-blocked', 'label content_only=ai-content-only',
  'label epic=ai-epic', 'label fix_needed=ai-fix-needed', 'label human_review=ai-human-review',
  'label in_progress=ai-in-progress', 'label merged=ai-merged', 'label needs_detail=ai-needs-detail',
  'label ops_only=ai-ops-only', 'label pr_opened=ai-pr-opened', 'label priority=p0', 'label queue=ai-ready',
  'label release=ai-release',
  'marker orbi:answer:v1', 'marker orbi:base-ci-red:v1', 'marker orbi:failure:v1', 'marker orbi:progress:v1',
  'marker orbi:question:v1', 'marker orbi:scene:v1',
  'reserved bug=bug', 'retention keep_failed=true', 'retention retain_hours=72', 'unit prefix', 'unit service', 'unit timer',
];

describe('contract_facts_manifest', () => {
  it('reads the pinned v0.7.65 checkout into one exact, deterministic manifest', async () => {
    const f = await setup();
    const first = await contractFacts(f.source);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.facts).toEqual(V0765_FACTS);
    expect(first.facts).toEqual([...first.facts].sort());
    expect(first.manifest).toBe(`${V0765_FACTS.join('\n')}\n`);
    // The facts this issue names explicitly, asserted separately so a rewritten
    // list cannot silently drop one of them.
    for (const fact of [
      'label queue=ai-ready', 'disposition provider_balance=top_up_balance:false',
      'disposition attachment_unavailable=fix_ticket:false', 'marker orbi:failure:v1',
      'journal run_start', 'retention keep_failed=true', 'config max_concurrency=1',
    ]) expect(first.facts, fact).toContain(fact);
    const second = await contractFacts(f.source);
    expect(second).toEqual(first);
    if (second.ok) expect(second.manifest).toBe(first.manifest);
  });

  it('ignores non-fact edits: prose, comments and label presentation', async () => {
    const f = await setup();
    const baseline = await contractFacts(f.source);
    expect(baseline.ok).toBe(true);
    await edit(f, 'src/orbi/failure.py', text => text.replace(
      '    A transient GitHub API/server failure',
      '    A rewritten docstring line (#145 non-fact)\n\n    A transient GitHub API/server failure',
    ).replace('# Closed sets. A reason says WHY', '# A new comment. A reason says WHY'));
    await edit(f, 'src/orbi/labels.toml', text => text
      .replace('# Orbi platform labels', '# Rewritten header comment')
      .replace('color = "1d76db"', 'color = "000000"')
      .replace('description = "Ready for unattended delivery · aiready.sh"', 'description = "A different sentence"'));
    const after = await contractFacts(f.source);
    expect(after.ok).toBe(true);
    if (baseline.ok && after.ok) expect(after.manifest).toBe(baseline.manifest);
  });
});

// Acceptance #145.3: each fact drift is refused or changes the manifest, one
// test each.
describe('contract_facts_drift', () => {
  const rows: Array<{
    name: string; run: (f: Fixture) => Promise<void>; refused?: boolean; reason?: string;
    contains?: string[]; absent?: string[];
  }> = [
    {
      name: 'renamed label in labels.toml',
      run: f => edit(f, 'src/orbi/labels.toml', replace('name = "ai-ready"', 'name = "ai-queued"')),
      contains: ['label queue=ai-queued'], absent: ['label queue=ai-ready'],
    },
    {
      name: 'changed disposition action',
      run: f => edit(f, 'src/orbi/failure.py', replace('"github_transient": ("requeue", True),', '"github_transient": ("fix_ticket", True),')),
      contains: ['disposition github_transient=fix_ticket:true'],
    },
    {
      name: 'changed disposition retry flag',
      run: f => edit(f, 'src/orbi/failure.py', replace('"provider_quota": ("wait_quota", True),', '"provider_quota": ("wait_quota", False),')),
      contains: ['disposition provider_quota=wait_quota:false'],
    },
    {
      name: 'new disposition entry',
      run: f => edit(f, 'src/orbi/failure.py', replace(
        '    "unclassified": ("fix_ticket", False),',
        '    "unclassified": ("fix_ticket", False),\n    "brand_new_reason": ("decide", False),',
      )),
      contains: ['disposition brand_new_reason=decide:false'],
    },
    {
      name: 'marker v1 renamed to v2',
      run: f => edit(f, 'src/orbi/failure.py', text => text.replaceAll('orbi:failure:v1', 'orbi:failure:v2')),
      contains: ['marker orbi:failure:v2'],
    },
    {
      name: 'removed run_end journal event',
      run: f => edit(f, 'src/orbi/journal.py', drop('    "run_end": "a delivery ended (result, PR, commit)",')),
      refused: true,
    },
    {
      // A comment line of the block is not a key: commenting the entry out removes it.
      name: 'commented-out run_end journal event',
      run: f => edit(f, 'src/orbi/journal.py', replace(
        '    "run_end": "a delivery ended (result, PR, commit)",',
        '    # "run_end": "a delivery ended (result, PR, commit)",',
      )),
      refused: true,
      reason: 'journal.py: event run_end found 0 times',
    },
    {
      name: 'changed journal log format line',
      run: f => edit(f, 'src/orbi/journal.py', replace('return "%(levelname)s %(message)s"', 'return "%(levelname)s: %(message)s"')),
      refused: true,
    },
    {
      name: 'changed WORKTREE_RETAIN_HOURS',
      run: f => edit(f, 'src/orbi/worktree_retention.py', replace('WORKTREE_RETAIN_HOURS = 72', 'WORKTREE_RETAIN_HOURS = 96')),
      contains: ['retention retain_hours=96'],
    },
    {
      name: 'changed unit prefix line',
      run: f => edit(f, 'src/orbi/scheduler_units.py', replace(
        'return "orbi" if unit_name is None else f"orbi-{unit_name}"',
        'return "orbi" if unit_name is None else f"orbi_{unit_name}"',
      )),
      refused: true,
    },
    {
      name: 'missing fact file',
      run: async f => { await rm(join(f.source, 'src/orbi/labels.toml')); },
      refused: true, reason: 'src/orbi/labels.toml: read_failed',
    },
    {
      name: 'DISPOSITIONS block appearing twice',
      run: f => edit(f, 'src/orbi/failure.py', append(`\n${DISPOSITIONS}\n    "unclassified": ("fix_ticket", False),\n}\n`)),
      refused: true, reason: `failure.py: block ${DISPOSITIONS} found 2 times`,
    },
    {
      name: 'unparseable line inside the DISPOSITIONS block',
      run: f => edit(f, 'src/orbi/failure.py', replace(`${DISPOSITIONS}\n`, `${DISPOSITIONS}\n    "broken": ("requeue"),\n`)),
      refused: true, reason: 'failure.py: unparsed DISPOSITIONS line',
    },
    {
      // The engine's one unreadable action code: only `provider_balance.ACTION_CODE`
      // resolves; any other constant leaves the action unknown -> refusal.
      name: 'unresolved constant in the DISPOSITIONS block',
      run: f => edit(f, 'src/orbi/failure.py', replace(`${DISPOSITIONS}\n`, `${DISPOSITIONS}\n    "other_reason": (other_module.ACTION_CODE, True),\n`)),
      refused: true, reason: 'failure.py: unparsed DISPOSITIONS line',
    },
  ];
  it.each(rows)('$name', async row => {
    const f = await setup();
    const baseline = await contractFacts(f.source);
    expect(baseline.ok).toBe(true);
    await row.run(f);
    const result = await contractFacts(f.source);
    if (row.refused) {
      expect(result.ok, JSON.stringify(result)).toBe(false);
      if (!result.ok && row.reason) expect(result.reason).toContain(row.reason);
      if (!result.ok) expect(result.reason).toMatch(/^(src\/orbi\/|labels\.toml|failure\.py|journal\.py|config\.py|worktree_retention\.py|scheduler_units\.py|status_observe\.py|markers)/);
      return;
    }
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || !baseline.ok) return;
    expect(result.manifest).not.toBe(baseline.manifest);
    for (const fact of row.contains ?? []) expect(result.facts, fact).toContain(fact);
    for (const fact of row.absent ?? []) expect(result.facts, fact).not.toContain(fact);
  });
});

// Acceptance #145.4: the reader treats the engine checkout as data. It imports no
// execution capability, and engine code that would fail if it ran changes nothing.
describe('contract_facts_boundaries', () => {
  it('imports only the bounded reader, the path helper and the TOML data parser', async () => {
    const source = await readFile('server/contract-facts.ts', 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]).sort();
    expect(imports).toEqual(['./read-ports', 'node:path', 'smol-toml']);
    // No dynamic loading and no child execution at all: a `.py` file can only
    // ever arrive as bytes through the bounded reader.
    expect(source).not.toMatch(/\b(eval|Function|require|spawn|spawnSync|execSync|execFile|fork)\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toContain('child_process');
  });

  it('never executes engine code: a file that would abort on import changes nothing', async () => {
    const f = await setup();
    const baseline = await contractFacts(f.source);
    expect(baseline.ok).toBe(true);
    for (const path of ['src/orbi/config.py', 'src/orbi/status_observe.py']) {
      await edit(f, path, append('\nraise SystemExit("EXECUTED")\n'));
    }
    const after = await contractFacts(f.source);
    expect(after.ok).toBe(true);
    if (baseline.ok && after.ok) expect(after.manifest).toBe(baseline.manifest);
  });
});
