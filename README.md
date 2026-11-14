# paseo-orbi

A proposed read-only [Paseo](https://github.com/getpaseo/paseo) plugin for supervising [Orbi](https://github.com/orbi-build/orbi) across repositories.

**Status:** planning; no plugin implementation yet.

## Responsibilities

- **Kit** plans work and creates GitHub Issues.
- **Orbi** owns execution, recovery, code review, and PR delivery.
- **Paseo** provides the control room for observing that work.

This plugin is not another scheduler or orchestrator.

## Planned v0.1

| View | Purpose |
| --- | --- |
| Fleet | Deployments, timers, health, active work, and capacity |
| Issues | Ready, implementing, reviewing, blocked, and merged work grouped by repository |
| Runs | Pi session activity, run IDs, logs, branches, tests, and PR status |
| Blockers | Failures, preserved worktrees, evidence, and recovery guidance |

The server component will discover explicitly configured Orbi deployments, collect local diagnostics and GitHub Issue/PR state, and expose narrow, typed RPCs to the Paseo UI. Integration details and available data must be validated against supported upstream interfaces.

Version 0.1 is strictly read-only: no timer control, execution-state mutation, merging, or arbitrary shell execution exposed through RPCs. Paseo plugin server code is trusted host code, so configuration and diagnostic output must be handled carefully to avoid exposing credentials or other sensitive data.

Observing Orbi's background Pi session logs does not imply those sessions are Paseo-managed or support interactive attachment. Live steering requires separate investigation.

## Later possibilities

Explicit controls for pausing timers, approving blocked work, or submitting trusted instructions may be considered through supported Orbi interfaces, without taking ownership of orchestration.

## Documentation

- [Paseo plugin development reference](docs/paseo-plugins.md): official sources, runtime boundaries, UI and RPC APIs, compatibility, development, publishing, and proposed Orbi integration limits.

## References

- [Paseo plugin API](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md)
- [Orbi CLI](https://github.com/orbi-build/orbi/blob/main/src/orbi/cli_parser.py)
