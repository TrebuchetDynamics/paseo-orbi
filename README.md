# paseo-orbi

[Orbi](https://github.com/orbi-build/orbi) turns GitHub issues into tested pull
requests. This [Paseo](https://github.com/getpaseo/paseo) plugin shows that work
in Paseo: which issues are in progress, what happened during a run, and why work
stopped. It observes local Orbi deployments an operator has explicitly
authorized. It never retries, merges or edits Orbi work. Start, Stop and Restart
are available only where the operator explicitly granted that action on that
deployment; without a grant the deployment stays read-only. Work can stop
deliberately, so not every issue ends in a merge.

**An issue stopped moving?** Look in **Blockers** for the reported reason, then
**Runs** for what happened.

A deployment entry may designate one optional workspace shortcut
(`workspaceShortcut: { directory, name }`). Pressing **Inspect shortcut** in that
deployment's detail reports only **Symlink present**, **Present, not a symlink**,
**Not present**, **Cannot inspect** or **Not configured**. It never reads,
follows, resolves, compares or displays the target, writes nothing, and proves
neither that a checkout exists nor that the link opens. Opening the view reads
nothing.

## Views

- **Work** — the default view for a configured repository: issue rows with open-issue icon, number, wrapping title, label chips and read-only Inspect/Open-on-GitHub actions, plus open/closed/all and exact-label filters. A readable service health line (**10 service groups · No failures observed**) is followed by a separate **View services** action that opens Services; configured deployments, one loaded detail with timers/services, recorded health, capacity and one explicit presence/type check of an optional designated shortcut stay under **Configured repositories**.
- **Services** — the host-scoped service screen and the default landing for a host without linked repositories: every observed group failures first, with worker and scheduler facts, the first failed slot and no hidden inventory. **Details** opens a separate host-scoped view that leads with the service display name, its failed-first slot facts, freshness and one short association note, and offers **View diagnostics** for the slot explanation, the full association context and raw unit data, plus Start/Stop/Restart only for an operator-granted deployment; **Back to services** returns to the list.
- **Issues** — lifecycle pages, trusted structured reports, on-demand dependency evidence.
- **Runs** — attributed run identity, safe activity, scoped events, observed PR-head checks. Without a linked repository it shows one instruction, **Link a repository to see its runs.**, with the shared **Setup guide** and no selection prompt.
- **Blockers** — reported failures and waits, source attribution, metadata only; no recovery controls.

Monitoring is read-only: no timer or unit mutation invented by this plugin, no
merge, Orbi CLI, Git or shell execution, and no raw logs, prompts or reasoning.
Granted Start/Stop/Restart actions run only the operator's own bound Orbi
lifecycle command, one at a time per deployment, and report a re-observed
outcome; a timeout is reported as unknown and never retried. Reported retry
safety is never permission to retry; recovery stays Orbi/operator-owned. Only
deployments already configured on that host are visible — the plugin does not
discover repositories. The pinned Paseo host cannot separate viewers from
operators, so a grant is an explicit statement that every admitted client of
that host may operate the approved targets; see the
[operator guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#service-controls-operator-grant-default-off). Offline checks cover
all five views; the Linux Electron qualification lane is implemented but has
not been executed, iOS/Android are deferred, and live installation, installed
qualification and the [phone Services and action review (#91)](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/testing/qualification.md#phone-services-and-work-review-issue-91) remain unperformed.

## Setup

Baseline: Linux, Node **22.19.0**, Paseo daemon and app **0.15.4**. The manifest
declares admission `>0.15.0`, which only decides whether Paseo installs or
loads the plugin; installed 0.15.1, 0.15.4, 0.16.0-beta.2 and 0.16.0 rows remain
NOT_RUN (#23).

### Supported Orbi engine releases

The deployment's `adapter` selects one of four engine profiles. The subset
profiles `orbi-0.7.41-release`, `orbi-0.7.41-1a8b2f96` and
`orbi-0.7.48-release` pin a finite inspected source subset. The contract
profile `orbi-0.7.65-release` (current) pins the contract-facts manifest plus
`src/orbi/runner_health.py` and `src/orbi/run_state.py` whole: it accepts the
verified v0.7.64 and v0.7.65 releases and later releases whose facts and both
writer files match. Any other engine release is rejected as
`unsupported_source_profile`; there are no profiles for v0.7.49 through
v0.7.63. A contract profile is compatibility evidence for the listed facts and
two writers, not for the rest of the engine and not authentication: behavior
changes with unchanged facts are not detected, and structural changes to those
facts or writers show as invalid records and are rejected. Commit ids, subset,
contract-facts and writer digests, and the retention each profile supports are
in the
[operator guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#setup).

**Already installed and configured?** Open the **Orbi** entry on the intended host.
A host without linked repositories lands on **Services** and shows one notice —
"Repositories aren’t linked. Link repositories to see GitHub issues." — with a
**Setup guide** that only explains the operator procedure; an invalid catalog
names the repair instead. **Runs** keeps the same one **Setup guide** but names
its own capability: "Link a repository to see its runs." The operator supplies the authorization and explicitly
reloads the plugin. Refresh only rereads startup configuration; it cannot
configure or reload.

### Authorized installation (not performed here)

Plugins are trusted, unsandboxed host code: server code and preparation run with
the daemon user's filesystem, process and network access, and client code runs
in your Paseo apps. Trust the code and its future updates before consenting. Get
explicit operator approval before enabling plugins or installing, then inspect
the target daemon's root `pluginsEnabled` switch. If it is absent or false,
obtain separate explicit consent before enabling it — installing does not grant
that consent. Use the [official direct-Git flow](https://paseo.sh/docs/plugins/publishing.md#share-through-github-or-git):

```sh
paseo plugin add git:TrebuchetDynamics/paseo-orbi
paseo plugin ls
paseo plugin logs paseo-orbi
```

Without `--ref`, Paseo installs the repository's current default HEAD (`main`)
at install time; it does not install a GitHub Release. This is not a promise
that every `main` commit has passed live qualification: the plugin has offline
checks only, and live installation plus installed qualification remain
unperformed. Require `running` in `paseo plugin ls`, open the **Orbi** entry on
Work and select an authorized deployment. These commands are instructions,
not observed results.

An existing Git installation stays at its installed revision until the operator
reviews and applies `paseo plugin update paseo-orbi`. That update checks the
current default HEAD, shows the current and proposed revision and asks for
approval; declining or a failed update keeps the installed content.

**Historical offline evidence (reproducing that revision only).** Commit
`875c69a101a102a8f14b064f0664069b5e603f4f` is the revision of the recorded
offline qualification run. It is not needed for a fresh install and is not a
permanent update pin. It predates the current **Orbi** entry and host-first
Work: it lists Fleet, Issues, Runs and Blockers as separate sidebar rows,
while current `main` opens one **Orbi** entry on Work with in-app
navigation. To reproduce that revision deliberately:

```sh
paseo plugin add git:TrebuchetDynamics/paseo-orbi --ref 875c69a101a102a8f14b064f0664069b5e603f4f
paseo plugin ls
paseo plugin logs paseo-orbi
```

An initial `--ref` does not pin later ordinary updates; inspect and authorize
updates separately.

## Documentation

- **Operators:** [operator guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md) — setup, permissions, repair codes, limits.
- **Contributors:** [plugin development reference](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/paseo-plugins.md).
- **Verification:** [installed qualification guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/testing/qualification.md).
- [Listing overview](OVERVIEW.md).

## Moved sections

### Fleet

[Fleet behavior and repairs](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#fleet)

### Runs and log privacy

[Runs and log privacy](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#runs-and-log-privacy)

### Blockers and recovery limits

[Blockers and recovery limits](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#blockers-and-recovery-limits)

### Development

[Development checks](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/paseo-plugins.md#development-and-diagnostics)
