# paseo-orbi

A read-only [Paseo](https://github.com/getpaseo/paseo) plugin foundation for observing explicitly authorized local [Orbi](https://github.com/orbi-build/orbi) deployments.

**Status:** Issues browsing and trusted report reading are implemented. Fleet reads deployment timers, services and recorded health. Blockers explains trusted failures, waits and stat-only evidence without executing recovery. Runs remains a **feature not implemented** screen. The deployment selector and rejected-deployment cards use the safe `deployments.list` catalog. Fixture-backed browser checks cover Fleet, Issues and Blockers; live installation and native mobile qualification remain unperformed.

## Responsibilities

- **Kit** plans work and creates GitHub Issues.
- **Orbi** owns execution, recovery, code review, and PR delivery.
- **Paseo** observes that work. This plugin is not another scheduler or orchestrator. Reported recovery actions and retry safety never grant permission; recovery stays Orbi/operator-owned.

## Planned v0.1

| View | Purpose / status |
| --- | --- |
| Fleet | Implemented: deployments, timers/services, recorded health, configured capacity; active work links to Issues, counts unknown |
| Issues | Implemented: repository-selected lifecycle pages, source evidence, on-demand reports and dependency uncertainty |
| Runs | Structured Pi activity, run IDs, branches, tests, and PR status |
| Blockers | Implemented: trusted reported failures, manual/fix/merge waits, base-CI states and metadata-only evidence; no recovery controls |

Version 0.1 is strictly read-only: no timer control, execution-state mutation, merging, Orbi CLI, Git commands, or arbitrary shell/path RPCs. No raw logs, prompts, reasoning, or interactive Pi attachment. External Pi sessions are not Paseo-managed sessions. Future feature work may share entry files and must reconcile edits there.

## Setup

Baseline: Linux, Node **22.19.0**, Paseo daemon and app **0.15.4** (`>=0.15.4 <0.16.0`). Issues uses the daemon user's existing authenticated GitHub CLI. Fleet uses existing user systemd units and does not invoke GitHub; Issues never invokes systemd. No provider/model/auth changes are required or performed.

An operator supplies an existing JSON file via the daemon environment's absolute `PASEO_ORBI_CONFIG`. It is read once at plugin startup; changes require an explicitly authorized plugin reload. The plugin does not write configuration or discover repositories.

```json
{
  "schema": 1,
  "deployments": [{
    "id": "example",
    "label": "Example deployment",
    "repo": "owner/repository",
    "configPath": "/srv/example/orbi.toml",
    "engineSourcePath": "/srv/orbi-source",
    "repoDir": "/srv/example/repo",
    "deployHome": "/srv/example/home",
    "trustedPublisherLogins": ["trusted-publisher"],
    "adapter": "orbi-0.7.41-release"
  }]
}
```

The TOML is parsed as inert data, never imported or executed:

```toml
repo_dir = "/srv/example/repo"
deploy_home = "/srv/example/home"
source_repos = ["owner/repository"]
unit_name = "example"
max_concurrency = 2
```

Paths must be absolute in the JSON, canonical and free of symlink components or environment expansion. TOML paths resolve against its directory and must match those exact roots. One `source_repos` repository must match; capacity is 1..5. `unit_name` is optional (default Orbi units); when present, use letters, numbers, `_` or `-` (maximum 80 characters). IDs match `^[a-z][a-z0-9-]{0,63}$`; labels have 1..80 printable characters. At most 16 deployments; IDs and GitHub repositories are unique (repositories case-insensitively). No credentials belong in the authorization file. Unknown JSON fields are rejected.

Only these source checkout subsets are supported:

| Adapter | Upstream commit | Subset SHA-256 |
| --- | --- | --- |
| `orbi-0.7.41-release` | `fbafd09fe49a20299e96565f100633bca61ae2af` | `ff662193032fc0caf59e2742a3892c31af90a6d66726f38b2ac2256cb663140e` |
| `orbi-0.7.41-1a8b2f96` | `1a8b2f9603f6258cb105293f238a8d3f775f3393` | `ae5bd552aef7e1689b7352d99794f6dc0a04e257cf3668cad08be9473b9d859d` |

`server/compatibility.ts` enumerates the finite inspected files and manifest hashing algorithm. Both hashes were independently reproduced from those reachable upstream commits; compressed raw-file fixtures in `tests/helpers/` exercise the real reader. This is compatibility evidence for that subset, **not authentication of the engine**, and neither version strings nor Git metadata grant trust. The plugin never imports or executes engine source.

### Failure and repair

- Missing `PASEO_ORBI_CONFIG`: `unconfigured`, no entries; UI explains operator setup.
- Malformed file, invalid identity, duplicate ID/repository, or over 16 entries: global `invalid`, no entries. Repair the operator-owned authorization and reload.
- Mismatched TOML, missing/unsafe roots: entry-local `invalid_config` with a safe code. Correct the exact authorization/TOML; do not broaden access to make it pass.
- Unknown/missing/modified source subset: entry-local `unsupported_source_profile`. Use a supported unmodified source checkout or wait for a separately qualified adapter, then reload. Other valid entries remain usable.

The RPC returns only IDs, labels, repository names, adapter names, status and allowlisted problem codes. It never returns private roots, publisher logins, environment values or raw error prose. Invalid entries cannot resolve into read capabilities. No `.orbi/env`, provider, Git metadata or lock reads are permitted. Config, TOML, source and approved JSON reads are bounded to 256 KiB and a 10-second caller deadline, and reject nonregular files and symlinks, with opened-file identity checks to narrow check/use races. Startup directory checks use the same 10-second deadline. Disposal aborts initialization as well as pending port reads, clears their deadlines, and closes handles; a stuck kernel filesystem operation itself cannot be forcibly cancelled, so late completions are discarded and late-opened handles closed.

Internal process ports allow only fixed `systemctl show`, bounded `journalctl`, and GitHub.com `gh api --method GET` forms. Shell is off, stdin ignored, two children maximum, 10 seconds and 1 MiB combined output per child; timeout and disposal kill each operation's isolated Linux process group (including helpers holding output pipes), then reap the direct child. Internal raw output is not a public RPC. The GitHub reader validates and projects it before transport; future collectors must do the same. Caches are memory-only. Client observations poll mounted foreground/connected surfaces every 30 seconds, coalesce refreshes, retain failed data as stale, mark it stale after 60 seconds without success, and guard cancelled host/deployment generations.

## Issues and GitHub authentication

Open **Issues**, select an available repository in the catalog, then browse pages or select an issue to inspect its reports and native blockers. Rejected deployments remain visible with their diagnostics, never selectable. Each repository is read separately on the selected host. The typed `issues.list({deploymentId,page})` and `issues.get({deploymentId,issue})` RPCs expose validated projections only: no bodies, comments, credentials, activity targets or check output.

Authentication belongs to the operator and the daemon user's existing `gh` context, not plugin settings. The plugin does not extract tokens, source `.orbi/env`, authenticate, or change permissions. It runs only fixed `gh api --hostname github.com --method GET --include` requests with `Accept: application/vnd.github+json` and API version `2022-11-28`, without CLI caching or verbose output. Endpoints are constructed from authorized repository identities and validated positive issue/PR numbers; supplied URLs are never fetched. Only repository issues, selected-issue comments/details/dependencies, exact-repo PR metadata, and that PR head's check metadata are read.

Lifecycle precedence is: verified associated PR merge or `ai-merged`; closed without merge evidence; `ai-blocked`; `ai-needs-detail`; `ai-epic`; reviewing (`ai-awaiting-merge`, `ai-pr-opened`, `ai-fix-needed`, with the specific label badge); `ai-in-progress`; `ai-planning` / `ai-paused`; `ai-ready`; Other. `ai-human-review` alone is not a wait state. Conflicting lifecycle labels remain visible as evidence warnings. A selected issue's newly read facts update its displayed group. Labels and receipts are **reported**, not verified merge evidence: verification requires the authorized PR's `merged_at`. GitHub terminal/manual facts outrank reported progress. Ready candidate never promises pickup; dependencies remain unknown until requested, and unavailable/incomplete dependency reads never mean unblocked. Foreign-repository dependencies are unavailable rather than incorrectly attributed locally.

Browsing uses numbered pages of 100, sorted by updated time descending, excludes PR objects, and explicitly does not establish active membership. The server-only `GitHubReader.listIssueScope` completely paginates **open** issues for Runs/Blockers; consumers must check `complete`. Collections stop at ten pages or 60 seconds, with child deadlines reduced to the remaining cycle budget. A cap/failure never installs partial active membership or a new current run. Previous complete evidence is retained stale, or an initial incomplete result has no established members/run. Detail reads are on demand, not a sweep of historical issue comments. Identical requests coalesce and use a bounded memory-only, 30-second cache. An incomplete detail refresh can still show a newly confirmed closed/terminal fact while retaining explicitly incomplete report evidence. Report selections carry safe typed problems (including comment authentication failures), which also appear on the detail observation. A failed refresh of the same run's associated PR retains its previously verified merge stale; a different or conflicting identity cannot borrow that verification.

Formal metadata follows the [pinned public contracts](https://github.com/orbi-build/orbi/blob/fbafd09fe49a20299e96565f100633bca61ae2af/docs/public-contracts.mdx). Only configured `trustedPublisherLogins` authenticate publication; `authorAssociation` and copied markers grant no trust. A formal run prefix selects the newest updated run (numeric comment-ID tie break), then that run's newest progress. A newer missing/invalid report never borrows an older run. The reader validates the closed progress/failure/base-CI vocabularies and scene schema, strips every activity target, and does not parse arbitrary prose. The pinned base-CI writer's final block is accepted only on its formal validated base-CI failure, excluding quotes/fences. Legacy prose is missing; unknown versions are unsupported. Attribution includes repository, issue, REST comment ID and update time.

A selected run's formal merged comment must carry one unquoted details block with all six unique fixed machine rows. Duplicate/missing/malformed rows, invalid commit/numeric values, mismatched run IDs and foreign PR URLs are invalid. A valid receipt can identify a PR without a scene; conflicting valid scene/receipt identities expose **conflict**, with no selected PR. A malformed present source cannot disappear behind a valid fallback. Runs and Blockers should reuse `readIssueReports` and the server-only `getPullRequestEvidence` helper/method rather than reparse receipts.

### GitHub failure and repair

- `auth_denied`: no empty/ready success. Ask the operator to repair the daemon user's `gh` authentication/repository permissions outside the plugin, then Refresh.
- `rate_limited`: wait for `Retry-After`, rate-limit reset, or the 60-second fallback. All GitHub reads on this plugin installation share the gate; manual Refresh cannot bypass it. A 403 without quota exhaustion is `auth_denied` and also applies backoff.
- `not_found` on dependencies: unknown/unavailable, not an empty blocker set. Check repository access/API availability outside the plugin.
- `network_failed`, bounded process/read failures, `invalid_response`, `deadline`, or `incomplete`: retain previous complete evidence stale and retry after repair/the polling interval. Do not broaden authorization or infer an empty queue.

Offline fixture tests exercise the registered RPC, real reader and React Native screen path, including auth failure/repair, pagination, stale retention and forbidden canaries. A separate Playwright fixture preview exercised the actual screen components with React Native Web, registered RPCs and a bounded fake-gh executable at desktop/tablet/mobile widths (light/dark), including auth failure and repair/Refresh, with no browser errors or horizontal overflow. Neither is live GitHub or installed Paseo qualification; those remain the final integration issue's responsibility. No installation, credential change or GitHub mutation is part of this feature.

## Blockers and recovery limits

Open **Orbi → Blockers**, select an available deployment, then **Inspect artifact metadata** on an issue. Rejected catalog entries retain their safe diagnostics and never grant reads. `blockers.list({deploymentId,page})` returns an `Observation<BlockerPage>`; `blockers.read({deploymentId,issue})` returns an `Observation<BlockerDetails>`. Selectors are positive integers, with no path or command input. Runs is not a prerequisite.

The shared GitHub reader establishes complete open membership before classifying candidates with `ai-blocked`, `ai-needs-detail`, `ai-fix-needed` or `ai-awaiting-merge`. Pages contain up to 20 candidates; only that page's reports are read, not unrelated/historical comments. Manual attention, automatic fix/review pending, and maintainer merge wait are separate, not all terminal failures. Detail shows current GitHub state/labels and their update time, selected run, report status, repository/issue/comment attribution and source links. Closed/merged GitHub facts make retained failure reports historical. Conflicting labels remain visible.

Only the selected run's trusted formal failure schema 1 supplies outcome (`blocked` / `fix_needed`), the closed reason/action enums, and strict boolean `retry_safe`. Explanations are plugin-owned, including legacy `tests_failed`. Missing, invalid, unsupported or unknown metadata never falls back to free-text diagnostics. **Reported retry safety is metadata, never permission to retry.** Base-CI `waiting`, `resuming`, `merged` and `stale` remain separate reported states; resuming is not delivery success, and reported merged does not independently verify delivery success. Source: [pinned failure vocabulary](https://github.com/orbi-build/orbi/blob/fbafd09fe49a20299e96565f100633bca61ae2af/src/orbi/failure.py#L45).

For a complete, valid, exact-run scene with nonconflicting repository PR identity, the server derives the pinned `gitops.worktree_path` name under the authorized repository's `.worktrees`. It does not use a supplied scene path, enumerate directories, scan alternate roots, or search renamed worktrees. Only the worktree directory and `.orbi/run-state.json`, `.orbi/test.log`, `.orbi/plan.md`, `.orbi/verify.md` are metadata candidates. The port performs bounded `lstat`/canonical-path checks, rejects symlinks/nonregular artifacts, and exposes only a fixed relative name, presence status, byte size and modification time. Sizes are stat sizes, not recursive worktree totals. No artifact is opened or read; even run-state contents are not inspected as proof of identity. Missing, unreadable, invalid, present and unattributed evidence remain distinct. No absolute scene paths, artifact contents, raw failure diagnostics, prompts, tokens or downloads cross the RPC boundary. A missing/cleaned scene never removes a GitHub blocker or triggers recreation/cleanup.

Retention settings are inert startup observations, not promises:

| Profile | Supported settings/defaults | Limit |
| --- | --- | --- |
| `orbi-0.7.41-release` | `worktree_retain_hours = 72` (finite positive number); `keep_failed_worktrees` unsupported and ignored | Official v0.7.41 may delete terminally failed worktrees |
| `orbi-0.7.41-1a8b2f96` | `worktree_retain_hours = 72`; `keep_failed_worktrees = true` (strict boolean) | Installed pinned build adds failed-worktree retention behavior, not a presence guarantee |

Invalid supported values reject that deployment as `invalid_config`; repair configuration externally and authorize a reload. **72 hours does not imply automatic reclamation of an open blocked scene.** Only observed presence is reported. Source: [release cleanup](https://github.com/orbi-build/orbi/blob/fbafd09fe49a20299e96565f100633bca61ae2af/src/orbi/runner.py#L1121) and [installed retention profile](https://github.com/orbi-build/orbi/tree/1a8b2f9603f6258cb105293f238a8d3f775f3393).

Partial GitHub failures preserve visible candidates and mark incomplete reports. An initial incomplete scope is unavailable, never “no blockers”; only complete empty membership permits that message. Prior successful observations retain their timestamp and become stale on failure. Refresh and foreground polling share Issues' cache/backoff rules. `auth_denied`: ask the operator to repair the daemon user's existing `gh` authentication/permissions outside the plugin, then Refresh. `rate_limited`: wait for the shared GitHub reset gate. `network_failed` / `incomplete`: repair access externally and Refresh; never infer successful delivery or no blockers. Host/deployment/page/issue changes ignore late callbacks.

There is **no recovery execution interface**: no retry/requeue, pause, approval, merge, service control, credential validation/reset, worktree modification, or execution of comments/prose. Orbi and the operator own every recovery decision. Tests use synthetic trusted/untrusted metadata and filesystem stats on both profiles, including cleaned/unreadable/mismatched/escaping scenes. A Playwright fixture preview exercised the registered screen/RPC, real shared GitHub reader and bounded fake-gh GET process at desktop/tablet/mobile widths in light/dark, including auth failure → external fixture repair → Refresh and complete-empty scope, with no browser errors or horizontal overflow. Screenshots are excluded run artifacts. This is not live failed-delivery, installed Paseo, native-device or live-recovery qualification; no live recovery was run.

## Fleet

Open **Orbi → Fleet** on the intended host. Every catalog entry has a card, including rejected entries with safe diagnostics and repair guidance. Only available entries call `fleet.read({deploymentId})`; the server resolves that ID against startup authorization. No paths or command strings come from the client.

Each card reports repository/profile identity, configured capacity (1..5), **Occupancy: unknown**, and **Active deliveries: unknown**. Neither active labels nor leftover PID/lock files establish occupancy. Capacity is not a machine-wide promise. **View active work in Issues** opens Issues with that deployment filter.

For instances `1..max_concurrency`, Fleet independently reads `orbi-<unit_name>@<instance>.timer` and `.service`, or `orbi@<instance>` when `unit_name` is absent. The fixed read is `systemctl --user show <authorized-instance> --property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic --no-pager`. No `Environment`, `ExecStart`, unrestricted properties, control commands, locks or PID probes are requested. Only safe state fields and recognized trigger timestamp strings reach the UI; unknown/missing fields remain unavailable. Monotonic trigger values are not guessed into wall-clock times.

Recorded health comes only from bounded `<repoDir>/.orbi/health.json` reads, validated against the two pinned writers' `runs`, `last_pickup_ts` and `alerted` shape (at most 50 runs). The public projection contains only last pickup and run repository, issue, run ID, reported outcome and timestamp, never raw health JSON, alert keys or fingerprints. Missing/corrupt files are **unavailable**, not an empty successful history. Reported run outcomes are separate from current service state: `inactive/dead` with `Result=success` is not a failed service. No issue pickup is inferred from timers.

Cards keep independent source problems and timestamps. One inaccessible deployment or failed timer does not remove the others. `systemd: process_failed` means that unit read failed; check access to the selected host's user units externally, then **Refresh**. `filesystem: read_failed` means health could not be read/validated; check the health writer/file externally, then **Refresh**. Port deadlines/output limits retain their safe codes. `process_limit` means the foundation's two-child bound was reached; retry Refresh after pending reads finish. Rejected entries require operator configuration/source repair and an authorized plugin reload. Refresh only reads; it never repairs or controls a service.

The shared observation lifecycle polls foreground/connected cards every 30 seconds. A failed refresh preserves previous data with a stale badge; after 60 seconds without success, data is visibly stale. Observed/last-success timestamps remain visible. Text uses theme tokens and compact layouts wrap within the viewport. These are design bounds, not measured performance claims. No new fleet daemon or scheduler is required.

### Authorized installation (not performed here)

Plugins are trusted, unsandboxed host code. Obtain explicit operator approval before enabling plugins or installing. Once approved, inspect the target daemon's `pluginsEnabled` switch, typecheck the tested revision, and use the official direct-Git flow:

```sh
paseo plugin add git:TrebuchetDynamics/paseo-orbi --ref <tested-commit-sha>
paseo plugin ls
paseo plugin logs paseo-orbi
```

Require `running` on the intended host; open Fleet and exercise its read-only success, partial-failure and refresh states, plus shell configuration errors. An initial Git ref does not pin later updates. Git preparation runs `npm ci --omit=dev --ignore-scripts`; host libraries are not bundled. No registry submission, npm publication, service activation, daemon restart or runtime installation is part of this delivery.

## Development

On Node 22.19.0:

```sh
npm ci --ignore-scripts
npm test -- tests/foundation.test.ts
npm test -- tests/issues.test.tsx
npm test -- tests/fleet.test.tsx
npm test -- tests/blockers.test.tsx
npm run test:boundaries
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
```

CI runs the same checks with bounded command timeouts. Committed UI tests use mocked host/RN primitives, a real isolated QueryClient, and react-test-renderer in Node, not a live daemon. Fleet tests also exercise real ConfigRepository/ReadPorts against inert process and health fixtures, asserting exact argv/filesystem access. A separate Playwright check rendered the real Fleet component with React Native Web and fixture RPC transport, checked navigation, refresh failure, 60-second staleness and browser errors, and captured wide/compact light/dark screenshots. This does not qualify an installed Paseo host or live systemd data. The test host supplies React Native's minimal `window` global so QueryClient polling is not silently disabled as SSR; no DOM library is enabled. Vite is overridden to 7.3.8 because unconstrained newer optional devtools peers caused npm 10's dependency resolver to crash with the requested Vitest version. The requested direct dependency versions remain pinned and the lock is synchronized. The install audit reports four development-tree advisories (one low, two moderate, one high), including explicitly pinned Vitest/Zod; no development server is started by these checks. Do not run `npm audit fix --force` to change those pins implicitly.

The npm pack listing must contain manifest, entries and runtime modules. npm excludes `package-lock.json` from packs; it must instead be committed for Git preparation. No npm publishing is supported by this bootstrap.

## Documentation

[Paseo plugin reference and project cautions](docs/paseo-plugins.md). Separate feature and final-integration issues own telemetry collection and live desktop/mobile qualification.
