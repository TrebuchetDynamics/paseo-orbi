# Source compatibility fixtures

`release.json.gz` and `installed.json.gz` are gzip-compressed JSON maps of finite relative paths to raw UTF-8 upstream file contents, not executable test modules. They were fetched from `https://raw.githubusercontent.com/orbi-build/orbi/<commit>/<path>` during implementation. Tests unpack them into isolated temporary directories and run the production bounded filesystem reader and hash gate, never import or execute the Python source.

- release: `fbafd09fe49a20299e96565f100633bca61ae2af`, aggregate `ff662193032fc0caf59e2742a3892c31af90a6d66726f38b2ac2256cb663140e`
- installed: `1a8b2f9603f6258cb105293f238a8d3f775f3393`, aggregate `ae5bd552aef7e1689b7352d99794f6dc0a04e257cf3668cad08be9473b9d859d`

- v0748: `f405e1dc4ff938ab99ec0742cfd3459d45e26948`, aggregate `f7d966479d4121b3cebecc116dd723eb0d0c7e2198d535b460230d06e118678e`. `v0748.json.gz` uses the same format, built with `git cat-file blob <commit>:<path>` from the tagged v0.7.48 commit, not working-tree or deployment files.

Release paths are exactly `docs/public-contracts.mdx` and `src/orbi/{base_ci_red,config,delivery_labels,failure,journal,pi_activity,run_state,runner_health,scene,scheduler_units,status_observe}.py`; installed additionally includes `src/orbi/worktree_retention.py`. v0748 includes the installed paths plus `src/orbi/{blocked_record,comment_kind,progress,question,requeue}.py`, pinning the stop-record prefix, comment envelope, progress, question/answer and requeue marker producers. This does not authorize answering or requeueing. Sort paths lexicographically, concatenate `path + NUL + lowercase hex SHA256(raw bytes) + LF`, and SHA256 that UTF-8 manifest. The independently downloaded aggregates matched both issue pins. Fixtures prove compatibility only for these inspected subsets, not authenticity of any whole engine.

`host.ts` mocks only Paseo/RN modules. `environment.ts` supplies React Native's window-without-DOM host global before QueryClient initialization. QueryClient, configuration, read ports, hashing and RPC contracts themselves are not mocked.
