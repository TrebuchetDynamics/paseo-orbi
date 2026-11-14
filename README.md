# paseo-orbi

A read-only [Paseo](https://github.com/getpaseo/paseo) plugin foundation for observing explicitly authorized local [Orbi](https://github.com/orbi-build/orbi) deployments.

**Status:** installable bootstrap, not a working telemetry dashboard. Fleet, Issues, Runs, and Blockers register as React Native screens and explicitly show **feature not implemented**. The deployment selector and rejected-deployment cards use the safe `deployments.list` catalog. No live installation or desktop/mobile qualification has been performed.

## Responsibilities

- **Kit** plans work and creates GitHub Issues.
- **Orbi** owns execution, recovery, code review, and PR delivery.
- **Paseo** observes that work. This plugin is not another scheduler or orchestrator.

## Planned v0.1

| View | Planned purpose (not collected yet) |
| --- | --- |
| Fleet | Deployments, timers, health, active work, and capacity |
| Issues | Ready, implementing, reviewing, blocked, and merged work by repository |
| Runs | Structured Pi activity, run IDs, branches, tests, and PR status |
| Blockers | Failures, preserved worktrees, evidence, and recovery guidance |

Version 0.1 is strictly read-only: no timer control, execution-state mutation, merging, Orbi CLI, Git commands, or arbitrary shell/path RPCs. No raw logs, prompts, reasoning, or interactive Pi attachment. External Pi sessions are not Paseo-managed sessions. Future feature work may share entry files and must reconcile edits there.

## Setup

Baseline: Linux, Node **22.19.0**, Paseo daemon and app **0.15.4** (`>=0.15.4 <0.16.0`). Existing user systemd and authenticated GitHub CLI will be needed by later collectors; this shell invokes neither. No provider/model/auth changes are required or performed.

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

Internal process ports allow only fixed `systemctl show`, bounded `journalctl`, and GitHub.com `gh api --method GET` forms. Shell is off, stdin ignored, two children maximum, 10 seconds and 1 MiB combined output per child; timeout and disposal kill each operation's isolated Linux process group (including helpers holding output pipes), then reap the direct child. Internal raw output is not a public RPC. Future collectors must project/redact it before transport. Caches are memory-only. Client observations poll mounted foreground/connected surfaces every 30 seconds, coalesce refreshes, retain failed data as stale, mark it stale after 60 seconds without success, and guard cancelled host/deployment generations.

### Authorized installation (not performed here)

Plugins are trusted, unsandboxed host code. Obtain explicit operator approval before enabling plugins or installing. Once approved, inspect the target daemon's `pluginsEnabled` switch, typecheck the tested revision, and use the official direct-Git flow:

```sh
paseo plugin add git:TrebuchetDynamics/paseo-orbi --ref <tested-commit-sha>
paseo plugin ls
paseo plugin logs paseo-orbi
```

Require `running` on the intended host; open each shell screen and exercise configuration errors there. An initial Git ref does not pin later updates. Git preparation runs `npm ci --omit=dev --ignore-scripts`; host libraries are not bundled. No registry submission, npm publication, service activation, daemon restart or runtime installation is part of this delivery.

## Development

On Node 22.19.0:

```sh
npm ci --ignore-scripts
npm test -- tests/foundation.test.ts
npm run test:boundaries
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
```

CI runs the same checks with bounded command timeouts. UI tests use mocked host/RN primitives, a real isolated QueryClient, and react-test-renderer in Node, not a live daemon. The test host supplies React Native's minimal `window` global so QueryClient polling is not silently disabled as SSR; no DOM library is enabled. Vite is overridden to 7.3.8 because unconstrained newer optional devtools peers caused npm 10's dependency resolver to crash with the requested Vitest version. The requested direct dependency versions remain pinned and the lock is synchronized. The install audit reports four development-tree advisories (one low, two moderate, one high), including explicitly pinned Vitest/Zod; no development server is started by these checks. Do not run `npm audit fix --force` to change those pins implicitly.

The npm pack listing must contain manifest, entries and runtime modules. npm excludes `package-lock.json` from packs; it must instead be committed for Git preparation. No npm publishing is supported by this bootstrap.

## Documentation

[Paseo plugin reference and project cautions](docs/paseo-plugins.md). Separate feature and final-integration issues own telemetry collection and live desktop/mobile qualification.
