# paseo-orbi

[Orbi](https://github.com/orbi-build/orbi) turns GitHub issues into tested pull
requests. This read-only [Paseo](https://github.com/getpaseo/paseo) plugin shows
that work in Paseo: which issues are in progress, what happened during a run, and
why work stopped. It observes local Orbi deployments an operator has explicitly
authorized, and it never retries, merges, edits or controls them. Work can stop
deliberately, so not every issue ends in a merge.

**An issue stopped moving?** Look in **Blockers** for the reported reason, then
**Runs** for what happened.

## Views

- **Overview** — configured deployments, user timers/services, recorded health, configured capacity.
- **Issues** — lifecycle pages, trusted structured reports, on-demand dependency evidence.
- **Runs** — attributed run/session identity, safe activity kinds, scoped events, observed PR-head checks.
- **Blockers** — reported failures and waits, source attribution, artifact metadata only; no recovery controls.

Version 0.1 is strictly read-only: no timer control, execution-state change,
merge, Orbi CLI, Git or shell execution, and no raw logs, prompts or reasoning.
Reported retry safety is never permission to retry; recovery stays
Orbi/operator-owned. Only deployments already configured on that host are
visible — the plugin does not discover Orbi installations. Offline checks cover
all four views; live installation and installed-client qualification remain
unperformed.

## Setup

Baseline: Linux, Node **22.19.0**, Paseo daemon and app **0.15.4**
(`>=0.15.4 <0.16.0`).

**Already installed and configured?** Open the **Orbi** entry on the intended host. An
unconfigured or invalid catalog shows a setup panel naming the missing
authorization; the operator supplies it and explicitly reloads the plugin.
Refresh only rereads startup configuration; it cannot configure or reload.

### Authorized installation (not performed here)

Plugins are trusted, unsandboxed host code: server code and preparation run with
the daemon user's filesystem, process and network access, and client code runs
in your Paseo apps. Trust the code and its future updates before consenting. Get
explicit operator approval before enabling plugins or installing, then inspect
the target daemon's root `pluginsEnabled` switch. If it is absent or false,
obtain separate explicit consent before enabling it — installing does not grant
that consent. Use the [official direct-Git flow](https://paseo.sh/docs/plugins/publishing.md#share-through-github-or-git)
with the exact offline-tested commit:

```sh
paseo plugin add git:TrebuchetDynamics/paseo-orbi --ref 875c69a101a102a8f14b064f0664069b5e603f4f
paseo plugin ls
paseo plugin logs paseo-orbi
```

That pin predates the current single **Orbi** sidebar entry: it lists Fleet,
Issues, Runs and Blockers as separate sidebar rows, while current `main` opens
one **Orbi** entry on Overview with in-app navigation. Either way, require
`running` in `paseo plugin ls`, open the views the installed revision lists and
select an authorized deployment. These commands are instructions, not observed
results. An initial `--ref` does not pin later ordinary updates, which follow
default HEAD; inspect and authorize updates separately.

## Documentation

- **Operators:** [operator guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md) — authorization JSON/TOML, permissions, repair codes, observation limits.
- **Contributors:** [plugin development reference](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/paseo-plugins.md).
- **Verification:** [installed qualification guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/testing/qualification.md).
- [Listing overview](OVERVIEW.md).

## Moved sections

Now in the operator guide:

### Fleet

[Fleet](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#fleet)

### Runs and log privacy

[Runs and log privacy](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#runs-and-log-privacy)

### Blockers and recovery limits

[Blockers and recovery limits](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#blockers-and-recovery-limits)

### Development

[Development checks](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/paseo-plugins.md#development-and-diagnostics)
