import { z } from 'zod';
import { Progress, Failure, Scene, BaseCi, Receipt, type ReportSelection } from '../shared/issues';

// Contracts checked against Orbi v0.7.48: public-contracts, journal, progress_summary,
// comment_kind, failure, scene, base_ci_red and delivery_comment. No prose fallback.
export const Comment = z.object({ id: z.number().int().positive(), updated_at: z.iso.datetime(), user: z.object({ login: z.string() }), body: z.string() });
export type Comment = z.infer<typeof Comment>;
const RunId = z.string().regex(/^[0-9a-f]{8}$/);
const SceneInput = z.object({ schema: z.literal(1), run_id: RunId, base_branch: z.string().min(1), base_sha: z.string().min(1), pr_url: z.string().min(1), external: z.string(), review_round: z.number().int().nonnegative(), base_advance_round: z.number().int().nonnegative().optional(), verdict_head_unknown_round: z.number().int().nonnegative().optional() }).strict();
const ProgressInput = Progress.extend({ activity: z.object({ at: z.iso.datetime().nullable(), kind: z.enum(['read', 'edit', 'command', 'analysis']), target: z.string().nullable() }).strict().nullable() });
const BaseInput = z.object({ schema: z.literal(1), state: z.enum(['waiting', 'resuming', 'merged', 'stale']), base_branch: z.string().min(1), base_sha: z.string().min(1), pr: z.number().int(), failing_checks: z.array(z.string().min(1)) }).strict();

export function repositoryPr(repo: string, url: string): number | null {
  const prefix = `https://github.com/${repo}/pull/`;
  if (!url.startsWith(prefix)) return null;
  const suffix = url.slice(prefix.length);
  const number = Number(suffix);
  return /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(number) ? number : null;
}
function unquoted(body: string, omitted: string[] = []): string {
  let fence: string | null = null;
  return body.split(/\r?\n/).flatMap(line => {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      return omitted;
    }
    return !fence && !/^\s*>/.test(line) && !/^ {4}|^\t/.test(line) ? [line] : omitted;
  }).join('\n');
}
type Formal = { comment: Comment; run: string; kind: string | null; prefix: string };
function formal(comment: Comment): Formal | null {
  const run = comment.body.match(/^<!-- orbi:run=([0-9a-f]{8}) -->(?:\r?\n|$)/);
  if (!run) return null;
  const rest = comment.body.slice(run[0].length);
  const kind = rest.match(/^<!-- orbi:comment=([a-z-]+) -->(?:\r?\n|$)/);
  if (rest.startsWith('<!-- orbi:comment=') && (!kind || !['started', 'failure', 'review-round', 'merged', 'requeued'].includes(kind[1]))) return null;
  // The requeue writer publishes attribution and readable text, no report payload.
  if (kind?.[1] === 'requeued') return { comment, run: run[1], kind: kind[1], prefix: '' };
  // Only contiguous hidden blocks are official. Never scan prose/fences for metadata.
  let prefix = '', remaining = rest;
  while (remaining.startsWith('<!-- orbi:')) {
    const end = remaining.indexOf('-->');
    if (end < 0) { prefix += remaining; break; }
    prefix += remaining.slice(0, end + 3) + '\n';
    remaining = remaining.slice(end + 3);
    if (!remaining.startsWith('\n') && !remaining.startsWith('\r\n')) break;
    remaining = remaining.replace(/^\r?\n/, '');
  }
  return { comment, run: run[1], kind: kind?.[1] ?? null, prefix };
}
export function selectReports(repo: string, issue: number, raw: unknown[], trusted: readonly string[], complete: boolean): ReportSelection {
  const missing = () => ({ status: 'missing' as const, attribution: null });
  const result: ReportSelection = { selectedRunId: null, attribution: null, complete, problems: complete ? [] : [{ source: 'github', code: 'incomplete' }], progress: missing(), failure: missing(), scene: missing(), baseCi: missing(), mergedReceipt: missing(), prIdentity: { status: 'missing' } };
  // Initial incomplete reads cannot establish a current run.
  if (!complete) return result;
  const records = raw.flatMap(value => {
    const parsed = Comment.safeParse(value);
    if (!parsed.success || !trusted.some(login => login.toLowerCase() === parsed.data.user.login.toLowerCase())) return [];
    const record = formal(parsed.data); return record ? [record] : [];
  }).sort((a, b) => Date.parse(b.comment.updated_at) - Date.parse(a.comment.updated_at) || b.comment.id - a.comment.id);
  if (!records.length) return result;
  result.selectedRunId = records[0].run;
  const current = records.filter(r => r.run === result.selectedRunId);
  const attribution = (r: Formal) => ({ repo, issue, commentId: r.comment.id, updatedAt: r.comment.updated_at });
  result.attribution = attribution(records[0]);
  function block<T>(name: string, schema: z.ZodType<T>, eligible: (r: Formal) => boolean = () => true) {
    const r = current.find(r => eligible(r) && (name === 'failure' || name === 'base-ci-red' || (name === 'scene' && r.kind === 'review-round') || r.prefix.includes(`<!-- orbi:${name}:`)));
    if (!r) return missing();
    const attr = attribution(r);
    let source = r.prefix;
    // base_ci_red.comment_body ends with the block, optionally followed by
    // the engine's fix-issues receipt. Strip only that literal final paragraph
    // before checking the block's position and ignoring quoted/fenced examples.
    if (name === 'base-ci-red' && result.failure.status === 'available' && result.failure.data.reason_code === 'base_ci_red') {
      // Keep a placeholder for excluded lines so filtering can't create a valid tail.
      const tail = unquoted(r.comment.body, ['#']).trimEnd()
        .replace(/\n\n<!-- orbi-base-ci-red-fix-issues scene=[0-9a-f]{16} -->$/, '');
      if (/\n<!-- orbi:base-ci-red:[^\n]*$/.test(tail)) source = tail.split('\n').filter(line => line.startsWith('<!-- orbi:base-ci-red:')).join('\n');
    }
    if (!source.includes(`<!-- orbi:${name}:`)) return { status: 'missing' as const, attribution: attr };
    const tokens = source.match(new RegExp(`<!-- orbi:${name}:[^\\n]*`, 'g')) ?? [];
    if (tokens.length !== 1) return { status: 'invalid' as const, attribution: attr };
    const match = tokens[0].match(new RegExp(`^<!-- orbi:${name}:v([0-9]+) ([\\s\\S]*?) -->$`));
    if (!match) return { status: 'invalid' as const, attribution: attr };
    if (match[1] !== '1') return { status: 'unsupported' as const, attribution: attr };
    try {
      const data = schema.parse(JSON.parse(match[2]));
      return { status: 'available' as const, data, attribution: attr };
    } catch { return { status: 'invalid' as const, attribution: attr }; }
  }
  const progress = block('progress', ProgressInput, r => r.kind === null && r.prefix.startsWith('<!-- orbi:progress:'));
  result.progress = progress.status === 'available' ? { ...progress, data: { ...progress.data, activity: progress.data.activity ? { ...progress.data.activity, target: null } : null } } : progress;
  result.failure = block('failure', Failure, r => r.kind === 'failure');
  const scene = block('scene', SceneInput);
  result.scene = scene.status === 'available'
    ? scene.data.run_id !== result.selectedRunId || !repositoryPr(repo, scene.data.pr_url) ? { status: 'invalid', attribution: scene.attribution }
      : { ...scene, data: Scene.parse({ run_id: scene.data.run_id, pr_url: scene.data.pr_url, review_round: scene.data.review_round }) }
    : scene;
  const base = block('base-ci-red', BaseInput, r => r.kind === 'failure');
  result.baseCi = base.status === 'available' ? { ...base, data: BaseCi.parse({ state: base.data.state, pr: base.data.pr, failing_checks: base.data.failing_checks }) } : base;
  const merged = current.find(r => r.kind === 'merged');
  if (merged) {
    const attr = attribution(merged);
    result.mergedReceipt = { status: 'invalid', attribution: attr };
    // Remove quoted/fenced lookalikes before recognizing a real details element.
    const body = unquoted(merged.comment.body);
    const blocks = [...body.matchAll(/<details><summary>[^\n]*<\/summary>\n([\s\S]*?)<\/details>/g)];
    if (blocks.length === 1 && (body.match(/<details\b/g) ?? []).length === 1) {
      const fields: Record<string, string | number> = {};
      let valid = true;
      for (const line of blocks[0][1].split('\n')) {
        if (!line.trim()) continue;
        const row = line.match(/^- (merge_commit|review_rounds|commits|external_commits|run_id|pr_url)=(\S+)$/);
        if (!row || row[1] in fields) { valid = false; break; }
        const numeric = ['review_rounds', 'commits', 'external_commits'].includes(row[1]);
        if (numeric && !/^(0|[1-9][0-9]*)$/.test(row[2])) valid = false;
        fields[row[1]] = numeric ? Number(row[2]) : row[2];
      }
      const parsed = Receipt.safeParse(fields);
      if (valid && parsed.success && parsed.data.run_id === result.selectedRunId && repositoryPr(repo, parsed.data.pr_url)) result.mergedReceipt = { status: 'available', data: parsed.data, attribution: attr };
    }
  }
  const s = result.scene, receipt = result.mergedReceipt;
  if (s.status === 'invalid' || receipt.status === 'invalid' || s.status === 'unsupported' || receipt.status === 'unsupported') result.prIdentity = { status: 'invalid' };
  else if (s.status === 'available' && receipt.status === 'available' && (s.data.pr_url !== receipt.data.pr_url || s.data.run_id !== receipt.data.run_id)) result.prIdentity = { status: 'conflict' };
  else {
    const identity = s.status === 'available' ? s.data : receipt.status === 'available' ? receipt.data : null;
    if (identity) result.prIdentity = { status: 'available', number: repositoryPr(repo, identity.pr_url)!, url: identity.pr_url, runId: identity.run_id, source: s.status === 'available' ? 'scene' : 'receipt' };
  }
  return result;
}
