# Paseo plugin development reference

This guide gathers the Paseo contracts relevant to `paseo-orbi`. It is a summary, not a copy of the complete API reference.

**Project status:** planning only. There is no plugin to install or run in this repository.

## Official sources

Reviewed on **2026-11-14**, starting from the [official documentation index](https://paseo.sh/llms.txt).

| Source | Use |
| --- | --- |
| [Quickstart](https://paseo.sh/docs/plugins.md) | Scaffold, runtime entries, installation, and reload |
| [Plugin reference](https://paseo.sh/docs/plugins/reference.md) | UI contributions, settings, RPCs, subscriptions, hosts, and CLI |
| [Hooks](https://paseo.sh/docs/plugins/hooks.md) | Lifecycle events and request changes |
| [Publishing](https://paseo.sh/docs/plugins/publishing.md) | Packages, Git sources, dependencies, and registry review |
| [Migration](https://paseo.sh/docs/plugins/migration.md) | Migration from the old single-entry format |
| [SDK reference](https://paseo.sh/docs/sdk/reference.md) | Normal Paseo agent, workspace, and host operations |

The deployed docs govern this summary. They can describe newer or unreleased APIs. Check both daemon and app compatibility before implementation. This review did not establish a minimum Paseo version for `paseo-orbi`.

GitHub `main` resolved to [`6e2fee462f148fe1aa158976da4435c753cc814a`](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a). The examples below use that revision. This does not prove that the deployed docs came from that commit.

### Source fingerprints

SHA-256 values identify the fetched Markdown content. Full upstream pages are not vendored here.

| Page | SHA-256 |
| --- | --- |
| Quickstart | `1ce239fe67daeb60d491b9b25dab57a4a3140ba0b397d6b2ddf495f547f7783c` |
| Plugin reference | `9e34a76f3d771292a4e364fbfa21a2ac207147cb48c6f8eff83333ad64691dde` |
| Publishing | `4d9d5119618f75079b0e9196051513d9bc126c8c8e03c9b6d9e9fcf1ba71c27b` |
| Hooks | `bd2ca46a7b86c61b6d42c98a18e9aa713a5aa68cffa0b2cc7d1a02dca5daf406` |

## Runtime and file layout

A plugin is a TypeScript project installed into one Paseo daemon. Client contributions run in connected Paseo apps, including mobile apps. Server contributions run in a daemon subprocess.

| Path | Purpose |
| --- | --- |
| `paseo-plugin.json` | Required manifest, default installation ID, and compatibility requirements |
| `index.client.tsx` | Client registration entry |
| `index.server.ts` | Server registration entry |
| `client/` | Components, hooks, styles, and client callbacks |
| `server/` | Node APIs, local resources, credentials, and backend handlers |
| `shared/` | Runtime-neutral contracts, schemas, and values |
| `package.json`, `tsconfig.json` | Dependencies and TypeScript configuration |
| `OVERVIEW.md` | Optional author-maintained listing page |

At least one runtime entry is required. Each entry accepts `.ts` or `.tsx`, default-exports a contribution function, and returns cleanup. Cleanup can be asynchronous.

Do not place other code modules in the root. Client code cannot import server code or Node modules. Server code cannot import client code or React. Shared code cannot import either runtime's modules or types. These restrictions include transitive imports.

Import shared helpers from `@getpaseo/plugin`, client APIs from `@getpaseo/plugin/client`, and server APIs from `@getpaseo/plugin/server`. Host UI belongs to `@getpaseo/plugin/client/ui`. Do not import the private `/client/host` module.

Paseo supplies the supported host libraries at runtime. Keep them in development dependencies for local typechecking. The reference lists the allowed modules. An arbitrary client dependency is not automatically available.

Source: [project files and runtime modules](https://paseo.sh/docs/plugins/reference.md#project-files).

## Contribution map

| Need | API | Relevance to this project |
| --- | --- | --- |
| Full-screen dashboard | `addScreen` | Candidate for Fleet, Issues, Runs, and Blockers |
| Sidebar entry | `addSidebarHeaderItem`, `addSidebarFooterItem` | Open the dashboard through `SidebarRow` |
| Workspace tab | `addWorkspacePanel` | Candidate for repository-specific diagnostics |
| Agent tab | `addAgentPanel` | Only when a corresponding Paseo agent exists |
| Command Center action | `addCommandCenterItem` | Open a screen or panel |
| Settings UI | `addSettingsScreen` | Possible deployment configuration surface |
| Typed backend request | `defineRpc`, `server.handle`, `useRpc` | Read Orbi diagnostics and GitHub data |
| Live backend events | `defineSubscription`, `server.handle`, `useSubscription` | Possible log tail or watcher, subject to version support |
| Normal Paseo operations | `usePaseo()`, handler `{ paseo }` | Use the existing SDK rather than duplicate RPCs |
| Lifecycle hooks | `server.addHook` | Available, but not required for the proposed read-only dashboard |

Other surfaces include file panels, slash commands, composer pills, attachment sources, timeline renderers, themes, sidebar views, and provider plugins. Their contracts are in the [full reference](https://paseo.sh/docs/plugins/reference.md). They are not requirements for v0.1.

Paseo owns a screen's route, header, host picker, error boundary, and query client. The plugin owns its body. Workspace panels use `locations` to select workspace tabs, the Explorer, or both.

## Requests, settings, and live data

### RPCs

Define each RPC contract in `shared/` with Zod input and output schemas. Register its handler with `server.handle` in the server entry. Call it with `useRpc` from client code.

The current contract parses input once in the plugin process and output once on the client. Schema transforms run at the receiving side. Do not assume both schemas run on both sides.

Use TanStack Query for request state and caching. Keep vendor credentials, filesystem access, and process execution in server handlers. Use the normal Paseo SDK for Paseo operations.

Source: [backend behavior](https://paseo.sh/docs/plugins/reference.md#add-plugin-specific-backend-behavior).

### Subscriptions

Subscriptions deliver typed events while a client listens. Each subscriber runs its own server handler. They do not replay missed events. Reconnection starts a new subscription.

Release watchers when the handler's abort signal fires. A synchronous handler that returns nothing remains open. A returned promise that resolves closes the subscription. Await `push` in a producer loop to pace delivery.

Older hosts can reject subscriptions. The current reference does not give a numeric introducing release in this section. Verify support before selecting this transport.

Source: [subscriptions](https://paseo.sh/docs/plugins/reference.md#subscriptions).

### Settings and cached records

`defineSettings`, `server.registerSettings`, and `useSettings` provide typed persistence. Host settings are shared by authorized clients. Device settings hold local preferences. Handle loading, invalid data, errors, and revision conflicts explicitly.

Host settings are ordinary JSON, not a credential vault. Do not store GitHub tokens there as though they were protected secrets.

Read existing workspace and agent data with `useWorkspace(id, selector)` and `useAgent(id, selector)`. Select only needed fields. Both hooks return `null` when a record is unavailable. Do not add an RPC merely to discover the current workspace or agent.

Sources: [settings](https://paseo.sh/docs/plugins/reference.md#settings-screens), [panels](https://paseo.sh/docs/plugins/reference.md#workspace-panels).

## Hosts, lifecycle, and mobile UI

An installation belongs to a daemon. When a plugin exists on several hosts, Paseo can show one sidebar item with a host picker. The selected host supplies its bundle, SDK, RPC transport, and query cache. An offline host does not silently fall through to another host.

`usePaseo()` borrows the selected host's existing connection. Do not open a separate connection inside a surface. The current API also supports explicit cross-host access. App-known hosts and daemon-saved host connections are distinct APIs. This is not automatic Orbi fleet discovery.

Release timers, subscriptions, sockets, and watchers in cleanup. A temporary disconnect can preserve mounted client surfaces and caches. Reload, removal, changed bundles, or connection replacement can dispose them. Show stale or unavailable data instead of presenting it as current.

For UI:

- Use React Native primitives such as `View`, `Text`, `Pressable`, and `ScrollView`.
- Use `onPress`, not DOM event handlers.
- Set text and background colors from `theme.colors`.
- Use `layout.compact` for narrow layouts.
- Keep browser globals out of components. A browser-specific helper belongs in `client/web.ts`, with a platform check and native fallback.
- Check light and dark themes, desktop width, compact layout, loading, empty results, errors, and disconnected hosts.

Sources: [hosts and lifecycle](https://paseo.sh/docs/plugins/reference.md#hosts-and-lifecycle), [cross-platform rules](https://paseo.sh/docs/plugins/reference.md#cross-platform-rules).

## Compatibility cautions

Do not copy an older example without checking the current contract.

| Area | Current documented behavior |
| --- | --- |
| Manifest requirements | Missing `requirements.paseo` means `<0.8.0`. Set an explicit supported range. Both daemon and app check compatibility. |
| Prereleases | Paseo also compares the stable core version. A prerelease minimum does not necessarily exclude earlier prereleases of that core. |
| Manifest display metadata | `name`, `icon`, and `media` require Paseo 0.11.0 or later. |
| Panel API | Unified panel props, `addAgentPanel`, and `useTabState` require 0.13.0 or later. Agent IDs are in `params.agentId`. Older `context` and flat `agentId` forms are deprecated. |
| Hooks | `server.addHook` is available from 0.14. Hooks use names such as `agent.open.before` and require async handlers. Do not use the older `server.on` / `server.before` examples as the current contract. |
| Background fields | Agent snapshot `background` and `backgroundWork` require 0.16.0 or later. |
| Runtime translations | The reference explicitly marks these APIs unreleased. Do not infer release support from their presence in the docs. |
| Registry overview | `OVERVIEW.md` is optional in the current publishing guide. A reviewer can create the listing from the README and verified behavior. |

Sources: [requirements](https://paseo.sh/docs/plugins/reference.md#requirements), [panels](https://paseo.sh/docs/plugins/reference.md#workspace-panels), [hooks](https://paseo.sh/docs/plugins/hooks.md), [publishing](https://paseo.sh/docs/plugins/publishing.md).

## Development and diagnostics

These are upstream workflow examples, not commands that can run against this repository yet. No installation or daemon changes were performed for this documentation.

Create a separate plugin project on the daemon machine:

```bash
paseo plugin init /absolute/path/to/my-plugin
cd /absolute/path/to/my-plugin
npm install
npm run typecheck
```

Before installation, inspect the target daemon's root `pluginsEnabled` configuration. If it is false or absent, an automated tool must obtain explicit permission before enabling it. Plugins are trusted, unsandboxed code. Server code and preparation commands can access the daemon user's files, processes, credentials, and network. Client code runs inside the app.

Once installation is authorized and plugins are enabled:

```bash
paseo plugin install /absolute/path/to/my-plugin
paseo plugin ls
paseo plugin logs my-plugin
```

For source changes:

```bash
npm run typecheck
paseo plugin reload my-plugin
paseo plugin ls
paseo plugin logs my-plugin
```

Require `running` with no error, then exercise the contribution in the intended client. Typechecking alone does not prove that the plugin runs.

Use `paseo --host <url> plugin ...` for another daemon. Directory paths must exist on that daemon. The CLI does not upload local source files.

A failed reload remains failed. Fix the source and reload again. A failed install/update candidate preserves the previous installed revision. Do not confuse these recovery behaviors. Source changes need plugin reload, not a daemon restart.

`paseo plugin logs` returns a snapshot, not a live tail. The current limit is 500 entries and 256 KiB per plugin, with 16 KiB per line. Reload and crashes retain the tail. Removal or daemon restart clears it. Client output stays in the app. Never log secrets.

Sources: [quickstart](https://paseo.sh/docs/plugins.md), [CLI](https://paseo.sh/docs/plugins/reference.md#cli-reference), [logs](https://paseo.sh/docs/plugins/reference.md#debug-backend-output).

## Install in Paseo

**Prerequisite:** these steps require an implemented plugin with a manifest and runtime entries. The current `paseo-orbi` repository does not meet that requirement. Do not try to install this documentation-only revision.

### Install through the app

1. Connect to the daemon that will read the Orbi deployments.
2. Open **Settings → Plugins** on that host.
3. Review the trust warning in the development section. Enable **Enable plugins** only if you accept that access.
4. Enter a source in **Plugin source**:
   - A local development directory: `/absolute/path/to/paseo-orbi`. It must exist on the daemon machine.
   - A future implemented Git source: `git:TrebuchetDynamics/paseo-orbi`.
   - A published registry ID, once approved. Use the exact ID shown on its listing.
5. Select **Install plugin**.
6. Confirm that the installed row reports `running` with no error.
7. Open the contributed screen or workspace panel on the same host. Test its read-only data request and error state.

The installed row provides an enable switch and a menu for settings, logs, reload, and removal. If the app requests a host update, update that host before installation. A compatible daemon does not guarantee a compatible app.

### Install through the CLI

For a local development checkout, run the typecheck and installation commands in [Development and diagnostics](#development-and-diagnostics).

Once an implemented commit is public, direct Git installation does not require registry approval:

```bash
paseo plugin add git:TrebuchetDynamics/paseo-orbi --ref <tested-commit-sha>
paseo plugin ls
paseo plugin logs paseo-orbi
```

Replace `<tested-commit-sha>` with the exact tested revision. The log command assumes the future manifest ID is `paseo-orbi`. Use the actual installation ID if different. The initial Git reference does not pin later ordinary updates.

For a remote daemon, place the global host option before the command:

```bash
paseo --host <url> plugin add git:TrebuchetDynamics/paseo-orbi --ref <tested-commit-sha>
paseo --host <url> plugin ls
```

Installation fetches and prepares the source on that daemon. It does not install a separate copy on each phone or desktop client.

### Enable plugins through configuration

Prefer the app switch for manual setup. For file-based setup, inspect the target daemon's `config.json` and preserve its other fields. After explicit approval, set the root `pluginsEnabled` field to `true` and apply it:

```bash
paseo reload --json
paseo plugin ls
```

For a remote daemon, edit that daemon's file and use `paseo --host <url> reload --json`. Do not change local configuration to enable a remote daemon. This switch affects all configured plugins whose own enabled state permits them to run. No daemon restart is required.

Source: [install and try it](https://paseo.sh/docs/plugins.md#install-and-try-it).

## Register workspace integration

Installation, UI registration, and public registry publication are separate operations.

- **Daemon installation:** makes the plugin available to clients connected to that daemon. There is no separate per-project installation step.
- **UI registration:** the plugin's client entry calls `addScreen`, sidebar registration methods, or `addWorkspacePanel` to expose its interface.
- **Workspace context:** a registered workspace panel receives `workspaceId`. Use `useWorkspace(workspaceId, selector)` to read that workspace's identity and directory.
- **Public registry publication:** makes an approved artifact discoverable and installable by registry ID. It does not install the plugin on your daemon.

For `paseo-orbi`, mapping a Paseo workspace to an Orbi deployment still needs an explicit configuration contract. Installing the plugin alone must not imply that all repositories have been discovered or authorized. There is no implemented project-registration command or deployment settings screen yet.

Sources: [workspace panels](https://paseo.sh/docs/plugins/reference.md#workspace-panels), [hosts and lifecycle](https://paseo.sh/docs/plugins/reference.md#hosts-and-lifecycle).

## Distribution

- Bare `owner/slug` resolves a registry listing. Use `git:owner/repository` or `github:owner/repository` for direct Git installation.
- Local directories, Git sources, and npm packages are supported. `install` and `add` are aliases.
- Registry installations use reviewed pins. Direct Git/npm installation selectors choose initial content, not future update limits.
- Ordinary direct Git updates follow default HEAD. Ordinary npm updates check `latest`. `--check` previews an update.
- Include the manifest, runtime entries, all imported modules, and declared assets in the distributed artifact.
- Runtime dependency trees need locked inputs for registry review. npm packages with installed runtime dependencies need a published `npm-shrinkwrap.json`.
- Git preparation that installs dependencies should use a synchronized lockfile. Manifest `build` contains argv arrays, not shell strings.
- A visual registry listing needs an image of the current interface. Use sample data and remove private details.
- Keep installation commands in the README. An author-supplied `OVERVIEW.md` explains behavior, setup, permissions, data flow, and limitations without plugin installation commands.

Source: [publishing guide](https://paseo.sh/docs/plugins/publishing.md). No package or registry listing was published as part of this work.

### Submit to the public Paseo registry

Use this procedure after the plugin works. A public GitHub repository alone is not a registry listing. The Git route below fits this repository and does not require npm publication.

1. Prepare an implemented revision in `TrebuchetDynamics/paseo-orbi`. Include `paseo-plugin.json`, runtime entries, imported modules, declared assets, and any required dependency locks.
2. Set the manifest's `description` and supported `requirements.paseo` range. Check both the target daemon and app versions.
3. Write installation and development instructions in `README.md`. Optionally add `OVERVIEW.md` beside the manifest to maintain the listing text yourself. Otherwise, the reviewer can create it from the README and verified behavior.
4. Provide at least one image of the working interface. Use sample data without private repository details. An icon alone is not sufficient for a visual plugin. Declare images in manifest `media`, or supply suitable public image URLs in the submission.
5. Run `npm run typecheck`. Push the intended revision through the repository's delivery process. Install that exact Git commit on a test daemon, require `running`, and exercise its contributions. Record the tested revision and limitations.
6. Open the [Paseo plugin submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml). Use the form so the submission label starts intake.
7. Use the plugin name as the title. Enter `https://github.com/TrebuchetDynamics/paseo-orbi` in **Source**, and specify the tested commit in the submission. Select the applicable categories and include interface-image URLs when needed.
8. Follow the review PR opened by the bot. Reply there with corrected revisions or requested image URLs. Do not treat an intake issue or automated validation pass as publication approval.
9. After approval and publication, copy the exact registry ID from the listing and test registry installation:

   ```bash
   paseo plugin add owner/slug
   paseo plugin ls
   ```

   Replace `owner/slug` with the published ID. Do not assume a listing ID exists before approval.

The reviewer inspects the artifact and dependencies without running plugin code, completes the listing, and records the approved commit or version. The [registry review policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md) applies even when automated checks pass. Author-side runtime tests remain necessary.

For later Git releases, submit the desired revision manually for review. Existing registry installations use approved pins. npm releases receive automatic update PRs, but that does not make direct npm installation equivalent to registry installation.

An npm submission is an alternative, not a prerequisite. Follow the [npm publication steps](https://paseo.sh/docs/plugins/publishing.md#publish-on-npm), inspect `npm pack --dry-run --ignore-scripts`, and test the exact published version before submitting its public package name or page. Registry IDs and local directories are not valid submission sources.

No installation, registry submission, npm publication, or release was performed while writing this guide.

Source: [plugin registry](https://paseo.sh/docs/plugins/publishing.md#plugin-registry).

## Upstream examples

These are reference candidates, not audited dependencies. Names and paths were checked at the pinned revision. Inspect their source before reuse.

| Example | What to inspect |
| --- | --- |
| [local-plugin](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a/plugin-examples/local-plugin) | Basic plugin structure |
| [settings](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a/plugin-examples/settings) | Typed settings and drafts |
| [hosts](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a/plugin-examples/hosts) | Explicit host selection |
| [diff-watch](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a/plugin-examples/diff-watch) | Subscription lifetime and watchers |
| [linear](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a/plugin-examples/linear) | External issue integration and attachments |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/6e2fee462f148fe1aa158976da4435c753cc814a/plugin-examples/lifecycle-logger) | Current hook registration |

## Application to paseo-orbi

The following is proposed project scope, not a verified Orbi integration:

1. Use screens for Fleet, Issues, Runs, and Blockers. Add a workspace panel only when it adds useful repository context.
2. Keep Orbi and GitHub reads behind narrow, typed server RPCs. Do not expose arbitrary command strings or unrestricted file paths.
3. Use explicitly configured deployments. Validate repository identity, allowed paths, response size, timeouts, and sensitive output before displaying diagnostics.
4. Show source identity, last refresh, partial failures, and stale results. Reading one repository must not hide another repository's failure.
5. Keep v0.1 read-only. Do not change timers, execution state, permissions, worktrees, or merge state.
6. Do not treat an external Orbi Pi session as a Paseo agent. Log observation does not prove interactive attachment or steering support.

Still to verify before implementation:

- Supported Orbi commands and output schemas, including whether diagnostic commands have side effects.
- Deployment configuration and discovery rules.
- GitHub authentication, rate limits, and issue/PR state mapping.
- Pi log formats, retention, redaction, and session identity.
- Supported Paseo daemon/app versions and whether polling is sufficient before adding subscriptions.

This documentation does not validate Orbi behavior, install a plugin, or qualify live desktop/mobile use.
