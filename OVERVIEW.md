# Orbi observations in Paseo

The single **Orbi** sidebar entry opens **Overview**, with internal **Overview · Issues · Runs · Blockers** navigation on the selected Paseo host. Existing four screen IDs and deployment links remain supported:

- Overview (Fleet): host-scoped user service families (failed/running/scheduled/installed, expandable per slot), configured deployments, one selected detail with user timers/services, recorded health and capacity. Occupancy and active delivery counts remain unknown.
- Issues: repository lifecycle pages, source labels, trusted structured reports and on-demand dependency evidence.
- Runs: attributed run/session metadata, limited activity kinds, scoped lifecycle events and observed PR-head checks. Retained issue history is separate from active membership.
- Blockers: reported failure/wait guidance, source attribution and stat-only artifact presence, size and modification time. Recovery remains Orbi/operator-owned.

## Setup and compatibility

The operator supplies an existing authorization JSON file through the daemon's startup environment variable `PASEO_ORBI_CONFIG`. It selects exact repositories, canonical local roots, TOML configuration, trusted report publisher logins and a supported source profile. Authorization and configuration changes require an explicitly authorized plugin reload; Refresh only rereads observations. See the [operator guide](https://github.com/TrebuchetDynamics/paseo-orbi/blob/main/docs/operator-guide.md#setup) for the exact JSON/TOML example and operator procedure.

Unconfigured or globally invalid catalogs use one shared setup/repair panel on every route, with at most one catalog Refresh and no feature reads. Refresh cannot configure authorization or reload startup configuration. Configured-empty means no configured deployments; rejected entries retain diagnostics without granting reads. Catalog transport freshness is not a deployment-health badge. Offline observations never fall through to another host.

A separate host-scoped `services.inventory({})` RPC is opt-in at startup through `PASEO_ORBI_HOST_INVENTORY=1` (independent of `PASEO_ORBI_CONFIG`) and otherwise returns `off` without spawning. It observes only Orbi-prefixed user units with two fixed bounded `systemctl` list reads and reports `complete`/`partial`/`unavailable` with per-source timestamps instead of an assumed empty result. Unit-family association is display-only, unique-prefix validated and never a repository read capability; unsupported-profile, ambiguous and out-of-profile units remain observed without authority. Overview renders this snapshot above the configured-repository section, offers "View repository" only for a current unique authorized mapping, and loads one deployment detail instead of every repository; with inventory off the section reports an undecided state and one setup disclosure, never a zero/absence claim, a never timestamp or an enabling Refresh, and lists no observed family or repository action.

The baseline is Linux, Node 22.19.0 and Paseo daemon/app 0.15.4 (manifest range `>=0.15.4 <0.16.0`). Existing user systemd/journal access and the daemon user's authenticated GitHub CLI with repository read permissions are required. No provider credentials are configured by the plugin. The supported Orbi profiles are `orbi-0.7.41-release` at `fbafd09fe49a20299e96565f100633bca61ae2af`, `orbi-0.7.41-1a8b2f96` at `1a8b2f9603f6258cb105293f238a8d3f775f3393`, and `orbi-0.7.48-release` at `f405e1dc4ff938ab99ec0742cfd3459d45e26948`. A finite source fingerprint gate rejects changed/unknown subsets before telemetry; it does not authenticate the whole engine.

## Data access and limitations

Plugins are trusted, unsandboxed code with the daemon user's permissions. This plugin reads the explicit authorization/TOML, inspected source files, bounded health/run/session records, fixed systemd properties and a bounded journal window. It sends read-only GitHub.com API requests using existing `gh` authentication. Validated projections cross the Paseo RPC connection to the selected host's clients; caches are memory-only. Git preparation downloads the locked `smol-toml` runtime dependency from npm with lifecycle scripts disabled. Runtime observation installs no software and sends no prompts or tool results to agent providers.

Safe activity is metadata, not raw logs: prompts, reasoning, arguments, targets, tool output, raw journals/test logs, environment values and private roots are not transported. Artifact contents are not opened by Blockers. Partial/unavailable sources remain explicit; previous evidence may be retained stale with timestamps. Missing evidence never establishes idle, successful checks, an empty queue or permission to recover.

There are no writes to Orbi runtime/configuration/GitHub, service controls, Orbi/Git execution, arbitrary command/path RPCs, retries, merges, session attachment or live steering. Reported retry safety is never approval. Release cleanup may remove failed worktrees; retention settings do not guarantee presence or automatic cleanup.

## Qualification status

Offline checks compose real registrations, validation, adapters, QueryClient and all four screens with isolated filesystem fixtures and injected process/network responses. Both pinned profiles and tracked Git production-only preparation are checked. This is installation readiness, not deployment or live-client qualification.

Not run: separately authorized test-daemon installation; consent to enable `pluginsEnabled` if absent/false; running-status confirmation; selected-host live RPC success/failure; wide/compact and light/dark physical clients; reload cleanup. No installation approval, real-client screenshots, registry listing or npm publication is claimed.
