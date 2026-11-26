import { resolve } from 'node:path';
import { parse as parseToml, type TomlTable } from 'smol-toml';
import { ReadError, readBytes } from './read-ports';

// Contract facts: the engine facts this plugin depends on, read as DATA.
//
// `contractFacts(root, signal)` reads one Orbi engine checkout through the bounded
// reader (`readBytes`, server/read-ports.ts) and returns ONE normalized,
// deterministic fact list — or a clear refusal. Engine source is never imported,
// evaluated or executed: `.py` files are text, `labels.toml` is parsed as TOML data.
//
// Manifest: `<kind> <value>` lines sorted by code unit, joined with "\n", plus a
// trailing "\n". The caller hashes that text.
//
// Final rules, verified against engine v0.7.65 (commit a37c005c):
//
//   label           src/orbi/labels.toml       every `[[label]]` `role`/`name` pair
//                                              (roles unique) -> "label <role>=<name>";
//                                              each `[reserved]` entry ->
//                                              "reserved <key>=<value>".
//   disposition     src/orbi/failure.py        the single line
//                                              `DISPOSITIONS: dict[str, tuple[str, bool]] = {`
//                                              to the next `}`; each entry
//                                              `"<reason>": ("<action>", True|False),`
//                                              -> "disposition <reason>=<action>:true|false".
//                                              `provider_balance.ACTION_CODE` resolves to
//                                              `top_up_balance`; see below.
//   marker          the eight marker files    union of `orbi:<name>:v<N>` tokens
//                   in src/orbi/              -> "marker <token>".
//   journal         src/orbi/journal.py       `run_start`, `run_end`,
//                                              `worktree_cleaned`, `worktree_retained`
//                                              each exactly once as a key of the
//                                              `JOURNAL_EVENTS: dict[str, str] = {` block;
//                                              a blank or comment line of that block is
//                                              never a key -> "journal <name>".
//   journal-format  src/orbi/journal.py       exactly one trimmed line
//                                              `return "%(levelname)s %(message)s"` and
//                                              one `record.msg = f"[{_CURRENT_RUN_ID}] {record.msg}"`
//                                              -> "journal-format levelname-message" /
//                                              "journal-format run-id-prefix".
//   config          src/orbi/config.py        for `repo_dir`, `deploy_home`,
//                                              `source_repos`, `unit_name`,
//                                              `max_concurrency`: the single
//                                              `data.get("<key>"[, <literal>])`
//                                              -> "config <key>=<literal text>|none".
//   retention       src/orbi/worktree_retention.py
//                                              exactly one `WORKTREE_RETAIN_HOURS = <number>`
//                                              and one `KEEP_FAILED_WORKTREES = True|False`
//                                              -> "retention retain_hours=<number>",
//                                              "retention keep_failed=true|false".
//   unit            src/orbi/scheduler_units.py
//                                              presence of the three trimmed lines
//                                              (prefix, timer template, service template)
//                                              -> "unit prefix|timer|service".
//   active          src/orbi/status_observe.py
//                                              the `delivery_labels.<NAME>` names inside
//                                              `def active_delivery_labels`'s return
//                                              tuple -> "active <NAME>".
//
// Fail closed: a missing file, a block absent or present twice, a non-empty,
// non-comment line inside a block that does not match its rule, a duplicate key,
// an unexpected TOML table or an unresolved constant returns `ok: false` with a
// short reason. A partial manifest is never returned.
//
// `src/orbi/provider_balance.py` is deliberately not read: server/read-ports.ts
// refuses any path segment matching /provider/i. The one action code that module
// owns is `top_up_balance`, a closed value of this plugin's Failure contract
// (`shared/issues.ts` `action_code`), so a change there fails that contract's own
// validation instead of passing this reader unnoticed — the same reasoning
// server/compatibility.ts records for the pinned profile.
export type ContractFacts = { ok: true; facts: string[]; manifest: string } | { ok: false; reason: string };

class Refusal extends Error {}

const PROVIDER_BALANCE_ACTION_CODE = 'top_up_balance';
const DISPOSITIONS_HEADER = 'DISPOSITIONS: dict[str, tuple[str, bool]] = {';
const JOURNAL_HEADER = 'JOURNAL_EVENTS: dict[str, str] = {';
const journalEvents = ['run_start', 'run_end', 'worktree_cleaned', 'worktree_retained'];
const configKeys = ['repo_dir', 'deploy_home', 'source_repos', 'unit_name', 'max_concurrency'];
const unitLines: ReadonlyArray<readonly [string, string]> = [
  ['prefix', 'return "orbi" if unit_name is None else f"orbi-{unit_name}"'],
  ['timer', 'return tuple(f"{prefix}@{index}.timer" for index in range(1, count + 1))'],
  ['service', 'return tuple(f"{prefix}@{index}.service" for index in range(1, count + 1))'],
];
const journalFormatLines: ReadonlyArray<readonly [string, string]> = [
  ['levelname-message', 'return "%(levelname)s %(message)s"'],
  ['run-id-prefix', 'record.msg = f"[{_CURRENT_RUN_ID}] {record.msg}"'],
];
const markerFiles = ['failure', 'progress', 'question', 'base_ci_red', 'scene', 'comment_kind', 'requeue', 'blocked_record']
  .map(name => `src/orbi/${name}.py`);

const refuse = (reason: string): never => { throw new Refusal(reason); };
const trimmed = (text: string) => text.split('\n').map(line => line.trim());
const count = (values: string[], value: string) => values.filter(entry => entry === value).length;

// One block from its exact header line to the next line that is exactly "}".
function block(text: string, header: string, source: string): string[] {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => line.trim() === header ? [index] : []);
  if (starts.length !== 1) return refuse(`${source}: block ${header} found ${starts.length} times`);
  const end = lines.findIndex((line, index) => index > starts[0] && line.trim() === '}');
  if (end === -1) return refuse(`${source}: block ${header} is unterminated`);
  return lines.slice(starts[0] + 1, end);
}

function labelFacts(text: string): string[] {
  let data: TomlTable;
  try { data = parseToml(text); } catch { return refuse('labels.toml: unparseable TOML'); }
  for (const key of Object.keys(data)) if (key !== 'label' && key !== 'reserved') return refuse(`labels.toml: unexpected table ${key}`);
  const entries = data.label;
  if (!Array.isArray(entries) || entries.length === 0) return refuse('labels.toml: no [[label]] entries');
  const facts: string[] = [];
  const roles = new Set<string>();
  for (const entry of entries) {
    const record = entry as TomlTable;
    const role = record.role, name = record.name;
    if (typeof role !== 'string' || !/^[a-z][a-z0-9_]*$/.test(role)) return refuse('labels.toml: invalid label role');
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return refuse(`labels.toml: invalid label name for ${role}`);
    if (roles.has(role)) return refuse(`labels.toml: duplicate label role ${role}`);
    roles.add(role);
    facts.push(`label ${role}=${name}`);
  }
  const reserved = data.reserved;
  if (reserved !== undefined) {
    if (typeof reserved !== 'object' || reserved === null || Array.isArray(reserved)) return refuse('labels.toml: [reserved] is not a table');
    for (const [key, value] of Object.entries(reserved)) {
      if (typeof value !== 'string' || value === '') return refuse(`labels.toml: invalid reserved ${key}`);
      facts.push(`reserved ${key}=${value}`);
    }
  }
  return facts;
}

function dispositionFacts(text: string): string[] {
  const entry = /^"([a-z][a-z0-9_]*)": \(("([a-z][a-z0-9_]*)"|provider_balance\.ACTION_CODE), (True|False)\),$/;
  const facts: string[] = [];
  const reasons = new Set<string>();
  for (const line of block(text, DISPOSITIONS_HEADER, 'failure.py')) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) continue;
    const match = value.match(entry);
    if (!match) return refuse(`failure.py: unparsed DISPOSITIONS line ${JSON.stringify(value)}`);
    if (reasons.has(match[1])) return refuse(`failure.py: duplicate disposition ${match[1]}`);
    reasons.add(match[1]);
    facts.push(`disposition ${match[1]}=${match[3] ?? PROVIDER_BALANCE_ACTION_CODE}:${match[4] === 'True' ? 'true' : 'false'}`);
  }
  if (facts.length === 0) return refuse('failure.py: DISPOSITIONS block is empty');
  return facts;
}

function markerFacts(sources: ReadonlyArray<readonly [string, string]>): string[] {
  const found = new Set<string>();
  for (const [, text] of sources) for (const match of text.matchAll(/orbi:[a-z_-]+:v[0-9]+/g)) found.add(match[0]);
  if (found.size === 0) return refuse('markers: no versioned marker found');
  return [...found].map(token => `marker ${token}`);
}

function journalFacts(text: string): string[] {
  // Only a code line of the block carries an event: a commented-out entry is not a key.
  const lines = block(text, JOURNAL_HEADER, 'journal.py').map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  return journalEvents.map(name => {
    const seen = lines.filter(line => line.startsWith(`"${name}":`)).length;
    if (seen !== 1) return refuse(`journal.py: event ${name} found ${seen} times`);
    return `journal ${name}`;
  });
}

function journalFormatFacts(text: string): string[] {
  const lines = trimmed(text);
  return journalFormatLines.map(([fact, line]) => {
    const seen = count(lines, line);
    if (seen !== 1) return refuse(`journal.py: ${fact} line found ${seen} times`);
    return `journal-format ${fact}`;
  });
}

function configFacts(text: string): string[] {
  return configKeys.map(key => {
    const matches = [...text.matchAll(new RegExp(`data\\.get\\("${key}"(?:,\\s*([^)\\n]+))?\\)`, 'g'))];
    if (matches.length !== 1) return refuse(`config.py: data.get("${key}") found ${matches.length} times`);
    return `config ${key}=${matches[0][1] !== undefined ? matches[0][1].trim() : 'none'}`;
  });
}

function retentionFacts(text: string): string[] {
  const hours = [...text.matchAll(/^WORKTREE_RETAIN_HOURS = ([0-9]+(?:\.[0-9]+)?)$/gm)];
  if (hours.length !== 1) return refuse(`worktree_retention.py: WORKTREE_RETAIN_HOURS found ${hours.length} times`);
  const keep = [...text.matchAll(/^KEEP_FAILED_WORKTREES = (True|False)$/gm)];
  if (keep.length !== 1) return refuse(`worktree_retention.py: KEEP_FAILED_WORKTREES found ${keep.length} times`);
  return [`retention retain_hours=${hours[0][1]}`, `retention keep_failed=${keep[0][1] === 'True' ? 'true' : 'false'}`];
}

function unitFacts(text: string): string[] {
  const lines = trimmed(text);
  return unitLines.map(([fact, line]) => {
    const seen = count(lines, line);
    if (seen !== 1) return refuse(`scheduler_units.py: ${fact} line found ${seen} times`);
    return `unit ${fact}`;
  });
}

function activeFacts(text: string): string[] {
  const lines = trimmed(text);
  const starts = lines.flatMap((line, index) => line.startsWith('def active_delivery_labels(') ? [index] : []);
  if (starts.length !== 1) return refuse(`status_observe.py: active_delivery_labels found ${starts.length} times`);
  const start = lines.findIndex((line, index) => index > starts[0] && line === 'return (');
  if (start === -1) return refuse('status_observe.py: active_delivery_labels has no return tuple');
  const end = lines.findIndex((line, index) => index > start && line === ')');
  if (end === -1) return refuse('status_observe.py: active_delivery_labels return tuple is unterminated');
  const names = [...lines.slice(start + 1, end).join(' ').matchAll(/delivery_labels\.([A-Z][A-Z0-9_]*)/g)].map(match => match[1]);
  if (names.length === 0) return refuse('status_observe.py: active_delivery_labels names no delivery label');
  return [...new Set(names)].map(name => `active ${name}`);
}

export async function contractFacts(root: string, signal?: AbortSignal): Promise<ContractFacts> {
  const texts = new Map<string, string>();
  // One bounded read per file, shared by every fact kind that reads it.
  const text = async (path: string): Promise<string> => {
    const cached = texts.get(path);
    if (cached !== undefined) return cached;
    let value: string;
    try { value = (await readBytes(root, resolve(root, path), signal)).toString('utf8'); }
    catch (error) { return refuse(`${path}: ${error instanceof ReadError ? error.code : 'read_failed'}`); }
    texts.set(path, value);
    return value;
  };
  try {
    const facts = [
      ...labelFacts(await text('src/orbi/labels.toml')),
      ...dispositionFacts(await text('src/orbi/failure.py')),
      ...markerFacts(await Promise.all(markerFiles.map(async path => [path, await text(path)] as const))),
      ...journalFacts(await text('src/orbi/journal.py')),
      ...journalFormatFacts(await text('src/orbi/journal.py')),
      ...configFacts(await text('src/orbi/config.py')),
      ...retentionFacts(await text('src/orbi/worktree_retention.py')),
      ...unitFacts(await text('src/orbi/scheduler_units.py')),
      ...activeFacts(await text('src/orbi/status_observe.py')),
    ].sort();
    return { ok: true, facts, manifest: `${facts.join('\n')}\n` };
  } catch (error) {
    return { ok: false, reason: error instanceof Refusal ? error.message : 'read_failed' };
  }
}
