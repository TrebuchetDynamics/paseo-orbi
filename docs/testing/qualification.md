# Installed Paseo qualification

This is the offline-delivered harness for epic #1, after #7's independent offline/package gate. **No installed browser run, screenshots, native qualification or live Orbi success is claimed by #11.** Saved execution issue #12 owns the browser run; #13 owns named native targets/access and applicable consent. Earlier fixture galleries/mock RN tests do not qualify an installation. No generated image is automatically a visual-regression baseline.

## User journey and permission gate

The execution owner reviews an exact committed candidate, reads the owner's consent comment on #12, prepares locked tools, then runs the real plugin in disposable loopback daemons and the matching bundled web app. The result is a partial evidence index that must pass test, cleanup, provenance and **human image inspection** gates before qualification can be reported.

Plugins are trusted, unsandboxed code. Server code/preparation can access files, processes, credentials and network; client code runs inside the app. Consent must explicitly cover enabling plugins **only on disposable test daemons**, installing the exact candidate, synthetic telemetry stand-ins, browser execution/screenshots and removal/disposal. The execution owner must read and verify the recorded owner instruction. A URL, CLI flag, workflow dispatch, author's identity or green offline tests is **not** technical proof of consent. No current/user daemon, real repository telemetry, agents/model calls, providers, service control or public listener is authorized. Obtain separate consent for any expanded scope.

Without approval, `npm run test:e2e` stops in global setup with `Owner approval required on execution issue #12...` before daemon, plugin, candidate or browser effects. Repair: obtain and verify the owner's instruction and supply all explicit inputs; never use the current/default host as a fallback. Do not enable plugins or run this journey for #11.

## Offline checks (safe for #11)

Use Node **22.19.0**. From the repository root:

```sh
timeout 180 npm ci --ignore-scripts
timeout 60 npm run typecheck
timeout 60 npm run test:e2e:typecheck
timeout 60 npm run test:e2e:unit
timeout 60 npm run test:e2e:list
timeout 240 npm test
timeout 60 npm run test:boundaries
```

`--list` imports declarations only: no global setup, daemon/browser, homes, ports or evidence directory. Harness unit tests use inert process/clock seams, synthetic PNGs/files and pure fixture operations, not Paseo children. Generated browser fixtures also pass through the real configuration/filesystem/GitHub/Fleet/Runs/Blockers adapters offline: active run #42, blocker #43, empty/error/partial states, and real 100-item pagination to issue #142. The bounded journal detail is intentionally partial, not an invented complete success. Listing never overwrites evidence, even if an output directory is supplied. The detached-read self-check models a reparented, separate process group and verifies TERM/KILL escalation, PID/start identity, refusal of unknown group members and bounded failure. These are local safety checks, not OS/live-cleanup evidence.

Production client/shared compilation has no DOM types. `tests/e2e/tsconfig.json` is independent; only this browser lane has DOM types. Server TypeScript explicitly excludes browser specs, Vitest retains its default excludes plus `tests/e2e/**`, and `tests/e2e-harness.test.ts` stays in Node. Ordinary CI runs only offline checks, including the separate E2E typecheck, never the browser journey.

## Explicit authorized setup (NOT run for #11)

Prerequisites: Linux `/proc` with process/fd inspection, free loopback ports, Node 22.19.0, npm, executable `/usr/bin/ps`, `/usr/bin/git`, `/usr/bin/tar`, access to the public npm registry and Playwright downloads, and Chromium/Firefox/WebKit OS libraries. Missing browser libraries are a **named blocking execution prerequisite**; do not use sudo, `--with-deps` or alter system packages under this approval. No production secrets are needed.

Root dev dependency: exact `@playwright/test` **1.65.1**, whose browser revisions govern all three engines. Separate `tests/e2e/runtime/package.json` and lock pin `@getpaseo/cli` **0.15.4**, matching server/client and bundled web UI. Do not use `npx latest`, app.paseo.sh, an arbitrary CLI on PATH, or widen the product's compatibility range. Runtime setup is explicit, not hidden inside daemon activation.

In a fresh disposable worker checkout after consent, run these commands once (paths are quoted, not interpolated into shell command strings):

```sh
# mkdir must fail rather than reuse an existing setup directory.
mkdir tests/e2e/runtime/.setup
setup="$PWD/tests/e2e/runtime/.setup"
mkdir "$setup/home" "$setup/config" "$setup/data" "$setup/cache" "$setup/tmp"
touch "$setup/npmrc" "$setup/global-npmrc"
setup_path="$(dirname "$(command -v node)"):/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/tests/e2e/runtime/.browsers"
timeout 300 env -i PATH="$setup_path" HOME="$setup/home" XDG_CONFIG_HOME="$setup/config" XDG_DATA_HOME="$setup/data" XDG_CACHE_HOME="$setup/cache" TMPDIR="$setup/tmp" NPM_CONFIG_CACHE="$setup/cache/npm" NPM_CONFIG_USERCONFIG="$setup/npmrc" NPM_CONFIG_GLOBALCONFIG="$setup/global-npmrc" npm ci --prefix tests/e2e/runtime --ignore-scripts
timeout 300 env -i PATH="$setup_path" HOME="$setup/home" XDG_CONFIG_HOME="$setup/config" XDG_DATA_HOME="$setup/data" XDG_CACHE_HOME="$setup/cache" TMPDIR="$setup/tmp" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" ./node_modules/.bin/playwright install chromium firefox webkit
```

Do not copy npmrc, gh profiles, provider/auth settings, Paseo hosts or browser profiles. The four required packages' locks remain synchronized; acquisition audit advisories are not permission to upgrade pins implicitly. Root installation and runtime acquisition are different gates.

## Exact execution inputs

Set **all** of these after personally verifying the owner instruction (replace placeholders; they are not defaults):

```sh
export PASEO_E2E_CANDIDATE_REPO='/absolute/canonical/repository'
export PASEO_E2E_CANDIDATE_SHA='<40-lowercase-hex-committed-SHA>'
export PASEO_E2E_OUTPUT='/absolute/worker/.artifacts/paseo-qualification/<run-id>'
export PASEO_E2E_APPROVAL_URL='https://github.com/TrebuchetDynamics/paseo-orbi/issues/12#issuecomment-<owner-comment-id>'
export PASEO_E2E_ENABLE_TRUSTED_PLUGINS=1
timeout --signal=TERM --kill-after=30 1230 npm run test:e2e
```

Output must not already exist. No default revision, host or home is accepted. Candidate fixes require a **new committed SHA**, review/approval as applicable and a new receipt/output directory. An execution run uses its one correlation ID, including the output directory; do not introduce another tracing ID.

The harness verifies the exact commit, uses `git archive` (not the working tree), rejects tracked symlinks, `.git`, `node_modules` and credential payloads, and prepares the locked production manifest only in its owned disposable candidate. It never runs npm preparation in the worker's source checkout. The archived runtime manifests/locks stay with that candidate. Preparation is limited to the reviewed manifest argv `npm ci --omit=dev --ignore-scripts`.

One worker owns shared host lifecycle. Two fresh homes and reserved loopback ports run the two supported source profiles, with identical deployment labels/IDs. Only the owned process group's `/proc`-verified listener may receive subsequent commands. Each host receives isolated HOME/XDG/npm/tool caches, a whitelist environment and strict fixture executables. The owned bin directory exposes only the real `/usr/bin/ps` as `ps` for pinned runtime process identity checks; executability is checked before launch. This does not add `/usr/bin`, `/bin` or inherited user PATH to the daemon environment. Missing ps is a named prerequisite failure, not fabricated process identity or permission to install packages. Raw process listings are not evidence artifacts. The absolute pinned CLI runs `daemon run --home <owned-home>` with:

- `PASEO_HOME=<owned-home>` and `PASEO_LISTEN=127.0.0.1:<owned-port>`;
- `PASEO_WEB_UI_ENABLED=true`, `PASEO_RELAY_ENABLED=false`;
- only generated `PASEO_ORBI_CONFIG`, except the independently isolated unconfigured startup;
- version-1 config with `daemon.listen`, `daemon.relay.enabled=false`, `features.webUi.enabled=true`, disabled MCP/browser-tools/usage/voice/dictation/terminal hooks and agent auto-resume/metadata providers, and consent-gated root `pluginsEnabled=true`.

Startup preserves HTTP health at `/api/health` and listener-ownership checks, then requires a valid **unfiltered** `plugin ls --json` RPC response before installation. HTTP health alone is unconditional in the pinned runtime and does not prove WebSocket readiness. Only the explicit owned endpoint’s known `Unexpected server response: 503` upgrade rejection is retried, using the same 60-second startup deadline and remaining-time-capped CLI attempts; other errors fail immediately. Installation is attempted exactly once, never automatically retried after an ambiguous result. The installed candidate must then reach status `running` within that same budget. Install uses absolute pinned CLI `--host tcp://127.0.0.1:<owned-port> plugin install <archived-candidate> --id paseo-orbi`. Every subsequent command names that owned host. The unconfigured screenshot needs absent startup authorization, not a missing file (which is invalid configuration): it uses another **fresh independent pair**, then disposes it, never restarts/reuses an existing home/port. Generated files remain below owned temporary roots. No system service manager, user daemon or agent is controlled.

Synthetic telemetry is below the real adapters: the existing `release.json.gz`/`installed.json.gz`, generated authorization/TOML/health/session files, and gh/systemctl/journalctl stand-ins. Stand-ins record argv and PID/PGID/start identity, allow only fixed GET/show/journal reads and fail every unknown operation without forwarding. Paseo actually compiles/loads the candidate, transports RPC, and renders the real sidebar/screens/themes/host controls. No replacement RPC, alternate plugin or RN Web gallery is used. Browser contexts are fresh and external HTTP/WebSocket destinations are rejected. Network/profiles/providers are not seeded.

## Inventory and timing

`test:e2e:list` enumerates 73 tests: 23 Chromium functional scenarios, 42 Chromium screenshot scenarios, and four-view functional smoke in Firefox and WebKit (8). Functional coverage includes actual deployment selection/list/detail/keyboard/scroll interactions, safe recovery guidance, refresh serialization, 30-second polling, complete-empty/partial/unavailable/stale, invalid/missing configuration and rejected sources. The two-host case uses identical host labels/deployment IDs while issue detail and page state are selected, delays a real fixture read, disconnects/reconnects only the selected transport, and checks no fallback/late data. It is a discriminating test, not a claim of a preexisting selection bug.

Tests use bounded real waits when claiming 30-second cache/poll and 60-second aging behavior, not fake-clock latency. Scenario timeout is **120 seconds**, global ceiling **20 minutes**, with no silent skips. Timing, browser startup or prerequisite failures must be investigated, not waved through. Console/page errors fail tests and are retained only as sanitized text. No raw trace ZIP/HAR/video is produced.

## Screenshot and inspection contract

Chromium uses deviceScaleFactor 1, real host Appearance **Light/Dark** selection and CSS viewports 375×667, 768×1024, 1920×1080. Four available views × two themes × three sizes = **24**. Four views × empty/partial/stale/unavailable at narrow dark = **16**. Global unconfigured/rejected-profile catalogs at wide light = **2**. Exactly **42 mandatory scenarios**; additional scrolled/details are not substitutes. These sizes/counts are planner targets, not device market-share claims.

Before capture: assert intended data/status/timestamp, fonts ready, stable geometry and at least one second after resize. PNGs are fullPage. Actual PNG width/height are separately decoded/hashed; nested RN ScrollViews do not expand just because fullPage is true, so the suite also scrolls to reachable controls/details and saves supplemental images. Inspect **each actual image**, not merely DOM existence, for theme contrast, no horizontal clipping, reachable nested scroll controls, visible error/timestamps/selection and complete intended content. Additional scrolled images may be necessary at any size, not just the automated narrow supplements.

Each `.shot.json` records SHA/dirty=false, daemon/app/tool/browser versions, time, synthetic host alias, viewport, theme, scenario, fixture profile/hash, expected/observed result, PNG dimensions/path/SHA256. Automated capture writes `inspection: null`: it cannot bless its own pictures. After viewing each PNG, the execution owner records:

```json
{"horizontalClipping":false,"scrollReachable":true,"contrast":"pass","stateVisible":true,"reviewedBy":"<execution-owner>","at":"<ISO-time>"}
```

Use failing values when applicable, repair the candidate and rerun rather than manufacturing a pass. No private prompts, raw provider configuration, real user/repository telemetry, token-bearing URLs or unredacted traces may be included. Secret canaries, unsafe paths/symlinks, absent/corrupt images, dimensions/hash/provenance mismatches, duplicate/missing cases, uninspected images, failed/skipped/missing mandatory tests and cleanup failure all prevent PASS.

## Evidence, cleanup and reporting

`.artifacts/paseo-qualification/<run-id>/` is gitignored. It contains receipt, JSON/Markdown index, PNGs/shot metadata, sanitized failure logs, test results, cleanup status and validation report. Evidence survives failure. Installation state distinguishes never attempted, uncertain and confirmed. Never-attempted hosts need no removal; uncertain installs first use an ownership-checked unfiltered list. Present candidates require removal; absent-after-uncertain is recorded as an observation, **not** a successful remove or proof a server-side install has finished. Unverifiable state is a cleanup failure. Sanitized command stderr/stdout is retained with removal diagnostics, and `startup.log` preserves the primary startup failure even if cleanup also fails (both errors are surfaced). Teardown snapshots descendants **before** requesting `plugin remove`/disposal on each owned installation, then terminates only proven owned groups with bounded TERM/KILL and verifies closed ports/no owned processes. Detached ReadPorts children register start identity; reparenting does not escape ownership accounting. PID reuse or an unaccounted descendant/group member is a cleanup failure, **not** permission for killall/pkill, service stop or broad kills. Temporary trees are removed only after safe process cleanup; unsafe cleanup retains them for explicit investigation. There is no daemon restart command.

The manual `paseo-qualification.yml` workflow is opt-in, ubuntu-24.04/Node 22.19.0, read-only permissions, no production secrets. It checks the recorded owner comment and requires the dispatching execution owner's explicit confirmation of having read the instruction. Its always-run safety scanner rejects secret-bearing/unknown artifacts before always-upload of sanitized failures, with **30-day retention**. Unsafe output is not uploaded. The job summary links the exact Actions run artifact and discloses expiration. A timeout/terminated runner can prevent cleanup; never report success without the cleanup receipt.

Downloaded evidence is initially **partial**, even if browser assertions pass. After image inspection, add the inspection entries in `manifest.json`, exact `artifactUrl` from the workflow summary/upload step, actual ISO `expiresAt` (30-day retention), and `status: "pass"` only when justified. Keep original files and report amendments explicitly; this inspection report refers to that exact uploaded run/artifact, not to an invented permanent URL. Verify the report at the real side-effect-free entry point:

```sh
timeout 60 npm run test:e2e:verify -- '/absolute/downloaded/evidence'
```

The validator writes `validation.json`, exits nonzero for partial/failed/missing evidence, and never launches a browser/daemon. Link its JSON/Markdown index, exact run/artifact URL, expiration and limitations from #12/epic #1. A green workflow or unit-generated PNG does not replace manual inspection. Do not rewrite provenance to make failed/skipped tests pass.

## Separate native and live gates

Browser emulation is **not native-app evidence**. #13 must name compatible desktop/iOS/Android targets, access, versions and applicable consent first. Native uses a distinct `evidenceKind: "native"` envelope with all three required slots:

```json
{"id":"ios-pending","platform":"ios","targetClass":"simulator","osVersion":"unknown","paseoVersion":"unknown","status":"not_run","missingInput":"Exact missing compatible iOS simulator access and owner consent"}
```

Allowed platform values: desktop/ios/android; targetClass: physical/simulator/emulator; target status: pass/fail/not_run. Unknown versions are permitted only for not_run with exact missingInput. Each passing target requires eight baseline PNGs (four views × light/dark, available). Case IDs are `<targetId>-<view>-available-<theme>`; cases record targetId, view/theme/scenario, actual PNG pixel width/height, path/hash/time, plugin provenance, daemon/app/tool versions, synthetic fixture provenance and inspection. Native cases must **not** invent CSS viewports or deviceScaleFactor. Common manifest status is pass/fail/partial. All three targets must pass for full-native PASS; missing/failed/partial targets exit nonzero with a usable report. Simulators remain labeled simulators, never physical proof. Native validation neither applies nor waives the browser matrix.

#7's offline distinction and the [README](../../README.md)'s plus the [operator guide](../operator-guide.md)'s live installation/privacy/trust cautions remain unchanged. This guide delivers tooling for #11 only; #12 owns browser execution after explicit disposable-daemon trusted-plugin consent, and #13 separately requires named native targets/access and applicable consent. Never run `test:e2e` against a user/default profile. Real Orbi/GitHub telemetry, provider/auth behavior, physical accessibility, user-host lifecycle and upstream product regression remain separately authorized live work, not claims this synthetic installed harness can make.

## Verified contracts

Pinned [Paseo 1c00b365](https://github.com/getpaseo/paseo/tree/1c00b365c9e0b74c1580eba33d905d693125ae21): public-docs/configuration.md, web-ui.md; CLI daemon/start.ts, plugin/index.ts and output/json.ts; app surface-screen.tsx, host-filter/host-picker/combobox, browser Appearance tests and settings helpers. [Playwright screenshots](https://playwright.dev/docs/screenshots). Selector/library/runtime discrepancies remain useful failures for #12, not proof from listing/typechecking alone. See execution results below.


## Execution results — issue #12 recovery

Approval receipts: [disposable plugin trust](https://github.com/TrebuchetDynamics/paseo-orbi/issues/12#issuecomment-6889124990) and [bounded harness recovery](https://github.com/TrebuchetDynamics/paseo-orbi/issues/12#issuecomment-6889391400). These do not authorize changes to the existing daemon, native access or genuine telemetry.

### Historical run `c2e778e6` — FAILED (unchanged)

Candidate `20f6b11af2ec09c22748eb0bf47ab241aa9b6291`. HTTP health preceded a plugin-install WebSocket 503; independently, the isolated runtime lacked `ps`. Cleanup reported removal failure and hid the primary error, discarding removal stderr, so its exact removal cause is unknown. The later bounded process/listener absence observation is **not** a retroactive cleanup PASS. Original local receipt/log/cleanup bytes remain in that run’s retained worktree; they were not uploaded.

Functional: PASS 0 / case FAIL 0 / NOT_RUN 31. Mandatory screenshots: PASS 0 / case FAIL 0 / NOT_RUN 42; captured/inspected 0. Setup FAILED; cleanup receipt FAILED. No artifact URL, downloaded hash readback or retention verification exists.

### Recovery run `0d691aba` — FAILED; qualification blocked

Bounded changes are confined to harness readiness, narrow real-ps exposure, state-aware failed-start cleanup, focused offline regressions and this report. No plugin, upstream, dependency or screenshot-matrix changes. Local offline verification on Node v22.19.0: `npm ci --ignore-scripts`, `npm run test:e2e:unit` (15 tests), `npm run typecheck`, `npm run test:e2e:typecheck`, `npm run test:e2e:list` (73 declarations), `npm test` (114 tests) and `npm run test:boundaries` (6 tests) all exited 0 under bounded timeouts. The focused red phase failed five new regressions before implementation; original safety negatives remain intact. CI on the reviewed PR remains the delivery authority.

Fresh local acquisition used the documented isolated runtime/browser setup: Node v22.19.0, Paseo 0.15.4, Playwright 1.65.1; Chromium 159.0.8154.6, Firefox 159.0 and WebKit 27.2 each launched/closed successfully. Fresh path ownership/canonicality, proc/fd inspection, executable ps and loopback reservation preflights passed before runtime setup. Acquisition used existing pins, no system package changes or inherited profiles.

**Executed candidate:** `6da3afc7f835706e258f1e373bcdfb7e514af301`, archived from the committed tree, at receipt time `2026-11-15T05:01:08.885Z`. All five explicit inputs were supplied; commands were the documented setup and `timeout --signal=TERM --kill-after=30 1230 npm run test:e2e`. Local evidence remains untracked at `.artifacts/paseo-qualification/0d691aba/` (receipt, startup log, host-a log, cleanup receipt), with exact commands and exit codes in the excluded `.orbi/` directory. This is **not** a downloadable artifact URL.

Installed execution exited **1** before installation: the pinned read-only `plugin ls --json` returned a structured `DAEMON_UNREACHABLE` error containing the owned endpoint’s WebSocket 503. The initial readiness matcher incorrectly expected human-readable stderr. The subsequent bounded correction parses the pinned CLI’s JSON error and matches both exact code and owned-host message; focused tests use the observed JSON contract and reject wrong-host/wrong-code 503s. That correction is offline-verified only: **no live qualification of the final corrected tree is claimed**.

The separate real-ps exposure worked: the owned bin contained node/npm/ps and the three unchanged strict stand-ins; `ps` linked to `/usr/bin/ps`, the terminal worker launched, and no `spawn ps ENOENT` appeared. Target disposable config had `pluginsEnabled: true`; existing/user config was not read or changed.

Cleanup receipt is **FAIL**: `Unaccounted owned descendant; refusing broad kill`. Installation was `never-attempted`, removal `not-attempted`; the original readiness error and separate cleanup error both reached the caller. A read-only follow-up at `2026-11-15T05:02:06.541Z` found four exact-owner-marked processes and one listener on the owned loopback port 33251. The detached terminal worker was reparented and in its own process group; the current descendant/fixture registry did not account for it. This is an ownership-accounting blocker, **not** permission to change guards or signal it by name/PID. 620 process environments and cwd entries were unreadable, so the observation is bounded, not universal. Private exact identities/root are retained in `.orbi/cleanup-followup.json`; no raw process listing was added to uploadable evidence. Runtime trees remain retained. No additional signals, deletion, guard bypass or live retry was performed.

**Counts:** setup FAIL 1; cleanup FAIL 1; functional PASS 0 / case FAIL 0 / NOT_RUN 31; mandatory screenshot PASS 0 / case FAIL 0 / NOT_RUN 42. Captured PNGs 0/42, inspected 0; lifecycle installation/removal/reload/disable/re-enable and browser journeys NOT_RUN. Pinned app version in the receipt is bundle provenance, not an observed rendered-client version. Host-b was not started.

`timeout 60 npm run test:e2e:verify -- <explicit-output>` exited **1** (missing `manifest.json`, as global setup never produced a lease); no passing/inspected manifest was fabricated. `timeout 60 node tests/e2e/evidence.mjs --check-upload <explicit-output>` exited **0**, indicating upload safety only, not qualification or actual upload. Workflow dispatch, sanitized remote upload/download/readback/hash agreement and 30-day retention were **NOT_RUN**; no workflow/artifact/expiration link exists. Original failed evidence remains unchanged. No remote screenshot-save claim is made.

**Next required decision:** authorize/review a narrowly scoped solution for pinned Paseo’s detached terminal-worker ownership accounting and identity-safe cleanup of the retained run, without weakening PID-reuse/unknown-descendant refusal. Stop live execution until that blocker is resolved. A future qualification requires another committed candidate, fresh homes/ports/output, all functional/image/cleanup gates and actual artifact publication/readback. Full issue acceptance is unmet; these bounded repairs and offline tests do not close the qualification gate. Native-device and genuine Orbi/GitHub source-data qualification remain unmet. Evidence publication must name the actual workflow run/artifact with verified download/readback and 30-day retention; no local path is a remotely accessible artifact link.
