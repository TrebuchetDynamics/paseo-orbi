# Installed Paseo qualification

This is the offline-delivered harness for epic #1, after #7's independent offline/package gate. **No installed browser run, screenshots, native qualification or live Orbi success is claimed by #11.** Saved execution issue #12 owns the browser run; #13 owns the Linux-only native lane described below, with iOS and Android explicitly deferred. Earlier fixture galleries/mock RN tests do not qualify an installation. No generated image is automatically a visual-regression baseline.

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

`--list` imports declarations only: no global setup, daemon/browser, homes, ports or evidence directory. Harness unit tests use process/clock seams, synthetic PNGs/files, pure fixture operations and disposable synthetic Node/native programs, never Paseo children. The native continuity fixture is compiled with the existing Linux C compiler (`cc`); no dependency or runtime is acquired by these tests. Generated browser fixtures also pass through the real configuration/filesystem/GitHub/Fleet/Runs/Blockers adapters offline: active run #42, blocker #43, empty/error/partial states, and real 100-item pagination to issue #142. The bounded journal detail is intentionally partial, not an invented complete success. Listing never overwrites evidence, even if an output directory is supplied. The detached-worker self-check captures an actual synthetic worker before its launcher exits, observes reparenting and a separate kernel process group, then verifies TERM/KILL escalation from the captured ledger. Other regressions cover pre-entry ordering, compiler threads, competing publishers, IPC/readiness descriptors, native exec identity/standard I/O, PID reuse, refusal of unknown group members and bounded failure. These are local OS-mechanism checks, not live Paseo cleanup evidence.

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

One worker owns shared host lifecycle. Two fresh homes and reserved loopback ports run the two supported source profiles, with identical deployment labels/IDs. Only the owned process group's `/proc`-verified listener may receive subsequent commands. Each host receives isolated HOME/XDG/npm/tool caches, a whitelist environment and strict fixture executables. The owned bin directory exposes acknowledged Node gates for `ps` and esbuild, plus Node and the three generated telemetry stand-ins; it adds no npm link. Native targets are independently resolved and digested before launch. The ps gate permits only the pinned Linux parent/argv table below, then replaces itself with `/usr/bin/ps` using `process.execve`, preserving PID/start/PGID and standard I/O. This does not add `/usr/bin`, `/bin` or inherited user PATH to the daemon environment. Missing ps or execve is a prerequisite failure, never permission for a spawn fallback or package installation. Raw process listings are not evidence artifacts. The absolute pinned CLI runs `daemon run --home <owned-home>` with:

- `PASEO_HOME=<owned-home>` and `PASEO_LISTEN=127.0.0.1:<owned-port>`;
- `PASEO_WEB_UI_ENABLED=true`, `PASEO_RELAY_ENABLED=false`;
- only generated `PASEO_ORBI_CONFIG`, except the independently isolated unconfigured startup;
- version-1 config with `daemon.listen`, `daemon.relay.enabled=false`, `features.webUi.enabled=true`, disabled MCP/browser-tools/usage/voice/dictation/terminal hooks and agent auto-resume/metadata providers, and consent-gated root `pluginsEnabled=true`.

Startup preserves HTTP health at `/api/health` and listener-ownership checks, then requires a valid **unfiltered** `plugin ls --json` RPC response before installation. HTTP health alone is unconditional in the pinned runtime and does not prove WebSocket readiness. Only the explicit owned endpoint’s known `Unexpected server response: 503` upgrade rejection is retried, using the same 60-second startup deadline and remaining-time-capped CLI attempts; other errors fail immediately. Installation is attempted exactly once, never automatically retried after an ambiguous result. The installed candidate must then reach status `running` within that same budget. Install uses absolute pinned CLI `--host tcp://127.0.0.1:<owned-port> plugin install <archived-candidate> --id paseo-orbi`. Every subsequent command names that owned host. The unconfigured screenshot needs absent startup authorization, not a missing file (which is invalid configuration): it uses another **fresh independent pair**, then disposes it, never restarts/reuses an existing home/port. Generated files remain below owned temporary roots. No system service manager, user daemon or agent is controlled.

Synthetic telemetry is below the real adapters: the existing `release.json.gz`/`installed.json.gz`, generated authorization/TOML/health/session files, and gh/systemctl/journalctl stand-ins. Stand-ins use the same acknowledged pre-entry protocol as other children; their call log is advisory telemetry, not ownership authority. They allow only fixed GET/show/journal reads and fail every unknown operation without forwarding. Paseo actually compiles/loads the candidate, transports RPC, and renders the real sidebar/screens/themes/host controls. No replacement RPC, alternate plugin or RN Web gallery is used. Browser contexts are fresh and external HTTP/WebSocket destinations are rejected. Network/profiles/providers are not seeded.

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

`.artifacts/paseo-qualification/<run-id>/` is gitignored. It contains receipt, JSON/Markdown index, PNGs/shot metadata, sanitized failure logs, test results, cleanup status and validation report. Evidence survives failure. Installation state distinguishes never attempted, uncertain and confirmed. Never-attempted hosts need no removal; uncertain installs first use an ownership-checked unfiltered list. Present candidates require removal; absent-after-uncertain is recorded as an observation, **not** a successful remove or proof a server-side install has finished. Unverifiable state is a cleanup failure. Sanitized command stderr/stdout is retained with removal diagnostics, and `startup.log` preserves the primary startup failure even if cleanup also fails (both errors are surfaced). Teardown reconciles the cumulative validated ledger **before, during and after** requesting `plugin remove`/disposal on each owned installation. One fixed monotonic shutdown deadline covers removal, collection, TERM/KILL and final verification. Only independently proven safe groups may be signaled; the harness's actual kernel PGID is refused. A separate-group worker captured while its parent was live remains accounted for after reparenting. Missing or malformed registration history remains a failure even when other safe groups can be cleaned. PID reuse or an unaccounted descendant/group member is a cleanup failure, **not** permission for killall/pkill, service stop or broad kills. Temporary trees are removed only after safe process cleanup; unsafe cleanup retains them for explicit investigation. There is no daemon restart command.

The manual `paseo-qualification.yml` workflow is opt-in, ubuntu-24.04/Node 22.19.0, read-only permissions, no production secrets. It checks the recorded owner comment and requires the dispatching execution owner's explicit confirmation of having read the instruction. Its always-run safety scanner rejects secret-bearing/unknown artifacts before always-upload of sanitized failures, with **30-day retention**. Unsafe output is not uploaded. The job summary links the exact Actions run artifact and discloses expiration. A timeout/terminated runner can prevent cleanup; never report success without the cleanup receipt.

Downloaded evidence is initially **partial**, even if browser assertions pass. After image inspection, add the inspection entries in `manifest.json`, exact `artifactUrl` from the workflow summary/upload step, actual ISO `expiresAt` (30-day retention), and `status: "pass"` only when justified. Keep original files and report amendments explicitly; this inspection report refers to that exact uploaded run/artifact, not to an invented permanent URL. Verify the report at the real side-effect-free entry point:

```sh
timeout 60 npm run test:e2e:verify -- '/absolute/downloaded/evidence'
```

The validator writes `validation.json`, exits nonzero for partial/failed/missing evidence, and never launches a browser/daemon. Link its JSON/Markdown index, exact run/artifact URL, expiration and limitations from #12/epic #1. A green workflow or unit-generated PNG does not replace manual inspection. Do not rewrite provenance to make failed/skipped tests pass.

## Detached ownership admission — issue #62 (offline prerequisite)

Only the daemon environment receives an absolute CJS `NODE_OPTIONS=--require=...` preload and per-host immutable registration configuration. Setup/preparation, management CLI, browser, Electron and serialized lease environments remain preload-free; inherited `NODE_OPTIONS` is never copied. Installation is restricted to exact `install <canonical-absolute-candidate> --id paseo-orbi`. Both `ls --json` and `ls paseo-orbi --json`, and fixed-ID remove/reload/enable/disable, remain available at the owned endpoint. Managed sources, update, `--path`, `--ref` and arbitrary passthrough are refused. Candidate entries, manifest and separately locked preparation are unchanged; pinned 0.15.4's local-directory branch does not run managed-install preparation. Unexpected npm is not an exempt role.

The collector anchors root identity to the actual returned spawn, not to a child's request. It validates live PID/start ticks/PGID, parent identity, executable, entry digest, argv, host invariants and a closed role graph before committing ownership and publishing a nonce/digest/identity-bound acknowledgment. Allowed edges are root → supervisor → daemon; daemon → plugin/terminal-launcher/esbuild/ps; terminal-launcher → terminal-worker; terminal-worker → ps; plugin → generated stand-ins. Compiler threads share daemon identity and do not register or wait. In-place preload preserves plugin IPC and terminal-worker FD3; only the two native gates use execve. The esbuild gate requires exactly `--service=0.25.12 --ping`. The ps identity form is `-ww -p <positive-decimal-PID> -o lstart= -o command=` for daemon/terminal-worker only; the Linux table form `-A -ww -o pid= -o ppid= -o sid= -o lstart=` is terminal-worker-only.

Requests are advisory, exclusive atomic publications in fresh private storage: at most 256 immutable 4-KiB records (1 MiB payload). Temporary files, acknowledgments, configuration and phase control have separate fixed bounds. Conflicts, overflow, missing history, unknown roles/edges and missed ancestry are sticky failures. No record recycling erases ownership history. Each admission has a fixed five-second monotonic deadline; startup additionally uses its original deadline, normal running does not reuse an expired startup deadline, and shutdown additionally uses its single fixed deadline. The producer waits using bounded regular-file reads and short `Atomics.wait` intervals. Denial, collector death or timeout prevents application entry. Repair a concrete registration failure and create fresh runtime/evidence; never bypass the collector or enroll a PID retrospectively.

`tests/e2e/fixtures/process-registration-provenance.json` records source digests for published server/CLI 0.15.4 and esbuild 0.25.12, including server archive SHA256 `c6fed3d03ec403521a4c949dcfce90a6d92dfac2c2002ce83f85c49dc45be4a2` and terminal bundle SHA256 `bdcd1e46afe37c2ffdb96980c8c40672d37e49c1afcf8556ec190b934602f9ab`. The exact copied runtime name is derived with the pinned algorithm from bundle bytes + node-pty package.json bytes + platform/arch, not a version/prefix match. The worker's ≤5-second acknowledgment consumes part of the launcher's **existing 15-second readiness budget**, which starts at worker spawn; the outer launch call remains bounded to 20 seconds.

Upstream worker JSON may discover unknown processes or corroborate an already captured identity, never authorize enrollment. Optional reads have a separate 1-MiB per-file limit; contents/secrets are withheld from parse diagnostics. Nonempty `terminals[]` is refused: this harness does not support real terminal-program ownership. Registration failures, unsafe groups, survivors or open ports retain runtime/registry and sanitized failure evidence. No historical run is enrolled, signaled or deleted by this repair.

Offline success proves this mechanism with test-owned programs, **not** actual 0.15.4 live teardown, later-version role compatibility, or full screenshot-matrix capacity. #23/#32 retain separate live consent, per-runtime setup/locks, capacity validation, image inspection and remote evidence/readback gates. Historical FAIL/NOT_RUN receipts below remain unchanged. This is operational isolation of trusted pinned code, not an adversarial same-UID sandbox or a pidfd-atomic signaling guarantee.

## Separate native and live gates

Browser emulation is **not native-app evidence**. #13 selects Linux desktop only; iOS/Android slots are preserved as owner-deferred `not_run` entries so no matrix is silently shrunk. Native uses a distinct `evidenceKind: "native"` envelope with all three required slots:

```json
{"id":"ios-pending","platform":"ios","targetClass":"simulator","osVersion":"unknown","paseoVersion":"unknown","status":"not_run","missingInput":"Exact missing compatible iOS simulator access and owner consent"}
```

Allowed platform values: desktop/ios/android; targetClass: physical/simulator/emulator; target status: pass/fail/not_run. Unknown versions are permitted only for not_run with exact missingInput. Each passing target requires eight baseline PNGs (four views × light/dark, available). Case IDs are `<targetId>-<view>-available-<theme>`; cases record targetId, view/theme/scenario, actual PNG pixel width/height, path/hash/time, plugin provenance, daemon/app/tool versions, synthetic fixture provenance and inspection. Native cases must **not** invent CSS viewports or deviceScaleFactor. Common manifest status is pass/fail/partial. All three targets must pass for full-native PASS; missing/failed/partial targets exit nonzero with a usable report. Simulators remain labeled simulators, never physical proof. Native validation neither applies nor waives the browser matrix.

#7's offline distinction and the [README](../../README.md)'s plus the [operator guide](../operator-guide.md)'s live installation/privacy/trust cautions remain unchanged. This guide delivers tooling for #11 only; #12 owns browser execution after explicit disposable-daemon trusted-plugin consent, and #13 owns the Linux native lane with iOS/Android deferred and unclaimed. Never run `test:e2e` against a user/default profile. Real Orbi/GitHub telemetry, provider/auth behavior, physical accessibility, user-host lifecycle and upstream product regression remain separately authorized live work, not claims this synthetic installed harness can make.

## Linux native Electron lane (issue #13)

Owner decisions recorded on issue #13 select **Linux desktop only**, with iOS and Android explicitly deferred, assistant-operated desktop automation, a separate compatible app/profile and test-only plugin enablement on a dedicated disposable daemon ([native trust receipt](https://github.com/TrebuchetDynamics/paseo-orbi/issues/13#issuecomment-6909863490)). No production app/profile/daemon, `/opt/Paseo` change, sudo, system package or relay scope is granted. Mobile results stay `not_run`; the historical three-platform matrix above is preserved as provenance, not as current scope.

Files: `tests/e2e/native/fixture.ts` (owned profile/display/app acquisition, Playwright fixture, capture), `tests/e2e/native/linux.spec.ts` (real renderer journeys), `tests/e2e/native/playwright.config.ts`, `tests/e2e/native/verify.mjs` (Linux-integrity wrapper) and the offline seam tests in `tests/e2e-native.test.ts`. The lane reuses `tests/e2e/harness.ts`'s `makeHost`, fixture ports, `prepareCandidate`, `startHosts`, ownership-aware `release` and the existing #12 identity guards. **That reuse did not include a completed detached-worker repair**: #12's terminal-worker accounting failure remained unresolved when #13 was delivered. Issue #62 supplies the shared offline pre-entry mechanism described above; actual runtime teardown still requires separate live validation. The native lane adds no second process design, dependency or production build step.

### Isolation and launch contract

- Pinned `Paseo-x86_64.AppImage` 0.15.4 (`sha256:a35de13bb9642e75e418c2906ef54ab24c5364140645199d2cf2d9ef3d5c7797`, re-checked against `gh api repos/getpaseo/paseo/releases/tags/v0.15.4`) is downloaded only into owned storage, hash-verified before execution, then extracted with `--appimage-extract`. The extracted `squashfs-root/Paseo.bin` is launched directly through Playwright 1.65.1 `_electron.launch` with `chromiumSandbox: true`; the packaging wrapper and Playwright's default no-sandbox behaviour are refused. No installed-app downgrade or substitute revision.
- `PASEO_ELECTRON_USER_DATA_DIR` points at a fresh owned directory before startup and the single-instance lock stays enabled (`PASEO_DISABLE_SINGLE_INSTANCE_LOCK` is never set). `<userData>/desktop-settings.json` is written with the exact pinned document `{"version":1,"settings":{"daemon":{"manageBuiltInDaemon":false,"keepRunningAfterQuit":false}},"migrations":{"legacyRendererSettingsImported":true,"daemonStopOnQuitDefaultApplied":true}}`, so the app manages no built-in daemon and imports no legacy renderer settings; omitted `releaseChannel`/`notifications` take their pinned schema defaults.
- Electron receives its own owned `HOME`/`XDG_*`/`PASEO_HOME`/`TMPDIR`, distinct from both fixture daemon homes, plus an allowlisted environment. `SHELL` is an owned 0700 wrapper executing `/bin/bash --noprofile --norc "$@"`, so personal shell files cannot restore secrets or settings, and no inherited `GH_TOKEN`/`PASEO_HOST`/provider/auth variable reaches the app.
- One worker owns one `/usr/bin/Xvfb` display (`:N`, 1920x1080x24, `-nolisten tcp`); an existing display socket is refused rather than attached. Startup is bounded to 60 seconds inside the existing 20-minute ceiling. Owned daemon, display and app identities share one cleanup lifecycle: proven `pid`+`pgid`+start identity, bounded TERM/KILL only for owned groups, `electronApp.close()` for the app, and closed-port/no-owned-process verification. Unknown descendants, PID reuse or an unaccounted group member remain cleanup failures, never permission for broad kills.
- Journeys drive the actual `paseo://app` renderer and the real Add Host/direct-loopback UI to the two owned fixture daemons, including identical labels/IDs (selection isolation), keyboard activation, nested scrolling, light/dark, refresh/error/stale, a never-listened-on loopback endpoint for disconnect/reconnect without fallback, window background/foreground, and test-only reload/disable/re-enable/remove/reinstall. No relay, LAN, real agent or model call is used; only actual test-window pixels are captured.

### Commands (Linux, Node 22.19.0)

```sh
timeout 60 npm run typecheck
timeout 60 npx --no-install vitest run tests/e2e-native.test.ts
timeout 60 npm run test:e2e:unit
timeout 60 npm run test:e2e:typecheck
timeout 60 npx --no-install playwright test -c tests/e2e/native/playwright.config.ts --list
timeout 240 npm test
timeout 60 npm run test:boundaries
```

Offline commands never start a GUI, daemon or display. The real native run takes the same explicit inputs as the browser lane, but `PASEO_E2E_APPROVAL_URL` must be an **issue #13** comment; an issue-12 approval is rejected for this lane:

```sh
export PASEO_E2E_APPROVAL_URL='https://github.com/TrebuchetDynamics/paseo-orbi/issues/13#issuecomment-<owner-comment-id>'
timeout --signal=TERM --kill-after=30 1230 npx --no-install playwright test -c tests/e2e/native/playwright.config.ts
node tests/e2e/native/verify.mjs "$PASEO_E2E_OUTPUT"
```

### Evidence and honest result

Automatic capture writes `receipt.json` with `evidenceKind: "native"`, one `desktop-linux-xvfb` target classed `emulator` with explicit Xvfb provenance, and `ios`/`android` slots `not_run` with owner-deferred reasons. Eight baseline captures (`desktop-linux-xvfb-<view>-available-<theme>`) plus detail/error/stale/disconnected cases are written as `.shot.json` with actual PNG width/height, SHA-256, plugin SHA, app/daemon/tool versions, the host OS version, the owned Xvfb virtual-display provenance, fixture provenance, observation time and `inspection: null`. The native worker teardown also asserts the browser lane's read-only invariant that every recorded host call was allowed. The desktop target stays `fail` and the manifest stays `partial` until the execution owner inspects every image and records inspection, the exact artifact URL and the expiry; the raw full-native validator result stays nonzero.

`node tests/e2e/native/verify.mjs <downloaded-dir>` is the Linux-integrity wrapper. It first requires the structural facts (native kind, partial status, exactly one passing `emulator` desktop target with Xvfb provenance, both mobile slots `not_run` with owner-deferred reasons, then real PNG/hash/dimension/provenance checks) and only then requires the complete validator error set to be exactly the two known full-native diagnostics. Missing, malformed, hash-mismatched or extra-diagnostic Linux evidence fails closed with exit 1. Exit 0 means **Linux image integrity only** — not journeys, not visual inspection, not physical-display coverage and not full-native PASS.

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

## Execution results — issue #13 native Linux lane

Receipt: [native trusted-plugin consent for the disposable daemon](https://github.com/TrebuchetDynamics/paseo-orbi/issues/13#issuecomment-6909863490), recorded together with the owner's Linux-only scope and explicit iOS/Android deferral on issue #13. They authorize nothing on the existing app/profile/daemon, no production maintenance and no mobile target.

### Offline implementation — verified; native execution NOT_RUN

`tests/e2e-native.test.ts` delivers seven injected-seam regressions before any Paseo launch: the issue-13 approval lane (an issue-12 receipt, a missing flag, a non-owned output and an inherited environment are all refused before any effect), the exact pinned `desktop-settings.json` document with both migrations applied, an allowlisted owned environment whose `SHELL` is the 0700 `--noprofile --norc` wrapper and whose `PATH` excludes `/usr/bin`, AppImage digest refusal before execution with extraction bound to the verified file and `squashfs-root/Paseo.bin`, display ownership (missing Xvfb and an existing socket are refused), a sandboxed bounded launch that closes a partial launch (including the aggregated close failure), failed-start teardown through the shared ownership-aware `release` with PID-reuse/unaccounted-group refusal intact, and the `verify.mjs` contract (structure-first, then exactly the two known full-native diagnostics; missing/not_run desktop, malformed, hash-mismatched, extra-diagnostic and validator-throw cases all fail closed). The documented wrapper command is executed as a real child process in both the accepting and rejecting directions.

Local offline runs used Node v26.8.2 — the agent host has no Node 22.19.0, no `/usr/bin/Xvfb` and no display — so the lane's own Node 22.19.0 requirement is exercised through its injectable runtime seam, and CI (Node 22.19.0) stays the delivery authority. `npm run typecheck`, `npm run test:e2e:typecheck`, `npx --no-install playwright test -c tests/e2e/native/playwright.config.ts --list` (6 tests, no global setup) and `npx --no-install vitest run tests/e2e-native.test.ts` (7 tests) exited 0. `npm run test:e2e:unit` shows one failure that already fails at the delivery base `784bf7c` on this host (`isolated_runtime_exposes_only_required_ps` expects `PATH` without `/usr/bin`, but the local Node binary lives in `/usr/bin`); it is untouched here.

**Every real native gate is NOT_RUN:** AppImage acquisition/extraction, Xvfb readiness, Chromium sandbox operation in the extracted bundle, packaged Electron inspector attachment, the six renderer journeys, and all native PNGs. No native image, artifact URL, download/hash readback or 30-day retention exists. The desktop target remains `fail`, iOS/Android remain `not_run` with owner-deferred reasons, the manifest remains `partial`, and full-native PASS is not claimed. Linux desktop qualification remains unproven until an approved execution supplies exact inputs and the image inspection, cleanup and readback gates pass.
