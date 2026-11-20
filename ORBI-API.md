# Orbi — host services and API surface

Reference for listing and inspecting every Orbi service on a host, plus the
commands and the one HTTP API Orbi actually exposes. Project/repo names in the
examples are anonymized as `orbi-project-01` … `orbi-project-08`.

---

## 0. There is no control-plane API

GitHub Issues and labels are the **only** state store: no database, no queue, no
daemon API, no web UI, no business-task timeout. The single HTTP API in the tree
is the independent Prometheus exporter (section 3).

---

## 1. Services (systemd user units)

| Unit | Role |
|---|---|
| `orbi@.service` (template) | One Runner tick. `Type=simple`, `ExecStart=%h/.local/bin/orbi` (the bare CLI *is* one tick). Two `ExecStartPre` steps under `flock .orbi/base-sync.lock`: (1) CLI probe and, on failure, `uv tool install --force --reinstall --editable` self-heal; (2) `orbi sync-engine-source` (applies `engine_source_track`). `WorkingDirectory` / `ORBI_CONFIG` are rendered from the `{{ORBI_REPO_DIR}}` placeholder at install time. |
| `orbi@.timer` (template) | `OnCalendar=*-*-* *:00/5`, `AccuracySec=30s`, `RandomizedDelaySec=240`, `FixedRandomDelay=true`, `Unit=orbi@%i.service`, `WantedBy=timers.target`. |
| `<prefix>@.service` / `<prefix>@.timer` | Per-deployment names from `scheduler_units.unit_names()`: prefix `orbi` (default) or `orbi-<unit_name>`, instances `1..max_concurrency` (hard cap `MAX_RUNNER_INSTANCES = 5`, generated names only). |
| `orbi-exporter.service` | Prometheus exporter. **Not** installed or managed by `orbi install-units`; `Restart=always`, `RestartSec=5`, and its paths are hardcoded (see section 5). |
| `launchd/org.orbi.runner.plist` | macOS equivalent, one agent per instance. Contract: `launchctl enable gui/<uid>/<label>` **then** `bootstrap gui/<uid> <plist>` (enable first — a stale record in the disabled DB makes bootstrap fail); `bootout` to unload (it kills a running instance); `launchctl print gui/<uid>/<label>` for state. |

Install semantics (`orbi install-units` / `orbi setup`): copy templates,
`daemon-reload`, enable `1..max_concurrency` timer instances and disable the
surplus up to 5. It **never** starts, stops or restarts the service, and never
touches a hand-written non-templated unit.

---

## 2. Commands to list services on the host

```bash
# installed templates and instances
systemctl --user list-unit-files 'orbi*'

# loaded units with ACTIVE/SUB state
systemctl --user list-units 'orbi*' --all

# next/last trigger per timer instance
systemctl --user list-timers 'orbi*' --all --no-pager

# single instance facts
systemctl --user show orbi@1.service -p ActiveState  --value
systemctl --user show orbi@1.service -p LoadState    --value
systemctl --user show orbi@1.service -p FragmentPath --value
systemctl --user is-enabled orbi@1.timer     # non-zero exit + state word is normal

# the journal the exporter reads
journalctl --user -u 'orbi@*' -o json --no-pager
journalctl --user -u orbi@1.service -n 200 --no-pager -q

# unit file sanity
systemd-analyze --user verify orbi@1.service
```

Orbi-native inspection (read-only; `status` is a debug attachment only — the
observability contract is "no human status command, no polling"):

```bash
orbi doctor          # repo commit, engine_source track/resolved/head, deploy_home
                     # clean|DRIFT, transport probe, unit_drift (sha256 repo vs
                     # installed), timer/service state, slots, Pi session,
                     # current Issue, recent journal tail
orbi check           # prerequisite gate: python, commands, user bus, gh auth, pi,
                     # config, repo access, transport, model provider.
                     # Fails fast with reason=, fix= and the docs link
orbi status [--repo R] [--issue N] [--follow]   # active deliveries + live Pi activity
orbi session [--follow] [--pretty]              # live Pi session JSONL path / tail -f
```

Key journal fields to grep when a unit looks dead: `run_start`, `activity`,
`heartbeat` (≤ every 30s, line prefixed `[run_id]`), `model_wait`,
`model_wait_dead`, `pi_idle{,_term,_kill}`, `run_failed`, `run_end`,
`progress_publish_failed`, `unit_drift result=auto_synced`, `runner_source_stale`,
`transport_check_failed`.

---

## 3. HTTP API — Prometheus exporter

`3rd/monitoring/prometheus/orbi-exporter.py` — stdlib only, no third-party
runtime dependency, separate process from the Runner.

| Endpoint | Behavior |
|---|---|
| `GET /metrics` | Prometheus text exposition (`text/plain; version=0.0.4`). A `journalctl` failure returns **500** with `# exporter error (fail fast, no fallback)` + `exporter_error <repr>`; no fallback, no swallowed error. |
| `GET /health` | `200 ok`. |
| anything else | `404`. |

| Flag | Default |
|---|---|
| `--bind` | `127.0.0.1` |
| `--port` | `9106` |
| `--units` | `orbi@*` |
| `--instances` | `1,2` |
| `--cache-ttl` | `5.0` s |

Source chain: user systemd journal of `orbi@*` → exporter → Prometheus → Grafana.
It also probes `systemctl --user is-active` per instance.

Metrics emitted:

- Gauges: `orbi_service_active`, `orbi_run_active`, `orbi_run_idle_seconds`,
  `orbi_run_seconds`
- Counters: `orbi_run_start_total`, `orbi_run_end_total`,
  `orbi_run_failed_total`, `orbi_progress_publish_failed_total`,
  `orbi_model_wait_total`, `orbi_pi_idle_total`, `orbi_pi_idle_term_total`,
  `orbi_pi_idle_kill_total`

Label contract (low cardinality, anything wider is a bug): only `slot`, `repo`,
`issue`, `role`, `phase`, `state`, `reason`, `result`. Never `run_id`, branch,
worktree, command or prompt text. The per-Runner dimension is **`slot`**, not
`instance` — a scraped `instance` label is renamed `exported_instance`, otherwise
`sum by (instance)` would group by the scrape target instead of the slot.

Independence is a design rule: a failure of the exporter, Prometheus or Grafana
can never affect Issue claiming, Pi execution, review, merge or fail-fast.

---

## 4. CLI command surface

```
orbi                                              # NO subcommand = one Runner tick
                                                  # (what the service ExecStart runs)

add <title> [--body] [--repo]                     # create Issue + ai-ready
suggest [--json]                                  # propose up to 3 Issues (interactive)
draft [--session-dir] [--create]                  # one request -> deliverable Issues
status [--repo] [--issue] [--follow]
session [--follow] [--pretty]
install-units [--installed-dir]                   # idempotent, never restarts a Runner
sync-engine-source                                # apply engine_source_track (ExecStartPre)
doctor [--installed-dir]
check
setup [--repo] [--installed-dir] [--json]
milestone set <title>                             # manual active_milestone advance
notify <subcommand>                               # send / check notification setup
fix-base <issue>                                  # ticket command, same receipt as the comment
amend <issue>
split <issue>
```

Global flags: `-h/--help`, `--version`, `--config <path>` (default from
`ORBI_CONFIG`, else `./orbi.toml`). The help text is pinned by a golden test;
`orbi.py` must never exist at the checkout root (it would shadow the package).

Ticket commands are driven by `ticket_command_registry.TICKET_COMMANDS`
(`fix-base`, `amend`, `split`, `milestone set`, `answer`): the registry is the
source, so a registered command gets its terminal spelling without edit.

---

## 5. Observed host state (anonymized)

8 deployments installed → 16 unit files (8 templates × service+timer), 21 loaded
units, 10 timer instances:

```
orbi-project-01@1  dead      orbi-project-01@3  failed
orbi-project-02@1  running   (timer running)
orbi-project-03@1  dead
orbi-project-04@1  running   (timer running)
orbi-project-05@1  dead, timer inactive dead (~17h since last trigger)
orbi-project-06@1  dead
orbi-project-07@1  dead      @2 dead      @3 dead
orbi-project-08@1  dead
```

Reading this state: `inactive dead` with `ExecMainStatus=0` is a oneshot tick
that finished — the timer starts the next one. That is the design working, not
breakage. A `failed` instance and an `inactive dead` timer are the two states
worth investigating.

Exporter: **not deployed** on this host —
`systemctl --user list-unit-files '*exporter*'` returns 0 units and nothing
listens on `127.0.0.1:9106`.

Recommended deploy (template is self-contained, stdlib only):

```bash
mkdir -p ~/.config/systemd/user
cp 3rd/monitoring/prometheus/orbi-exporter.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orbi-exporter.service
curl -s http://127.0.0.1:9106/health && curl -s http://127.0.0.1:9106/metrics | head
```

---

## 6. Known inconsistency in the shipped exporter unit

`systemd/orbi@.service` became path-independent (`{{ORBI_REPO_DIR}}` placeholder
substituted by `orbi install-units`), but `systemd/orbi-exporter.service` still
hardcodes:

```
WorkingDirectory=%h/Documents/orbi/orbi
ExecStart=/usr/bin/python3 %h/Documents/orbi/orbi/3rd/monitoring/prometheus/orbi-exporter.py
```

Consequences: the exporter only runs from that one directory layout, it points at
the system `python3` rather than the deployment's interpreter, it is not part of
`orbi install-units`, and it is not covered by `orbi doctor`'s `unit_drift`
comparison. Either the template should take the same placeholder treatment and
join `install-units`/`unit_drift`, or the asymmetry should be stated in the docs —
it is currently neither, which is what makes a manual copy the de-facto install
step.

Note also: the unit ships as `orbi-exporter.service` without `[Unit]`
`WantedBy=`-time enablement by Orbi, and its description does not include the
`Orbi — ` prefix the Runner units use.
