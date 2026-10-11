# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] — 2026-10-11

### Fixed

- **Every change in the settings card failed on the desktop app** with
  `cross-site-request-rejected`. 2.0.0 required a verifiable `Origin` on `POST`,
  but the desktop shell serves the settings page from an **opaque origin**, so
  its writes arrive with `Origin: null` and were refused while reads kept
  working — the card showed a state it could never edit. The guard now rejects
  only what the browser itself marks as cross-site (`Sec-Fetch-Site:
  cross-site`, which page script cannot forge), which is also the rule the skin
  manager uses.
- `localhost` and `127.0.0.1` are now treated as the same machine instead of a
  cross-origin mismatch.

### Added

- A refusal records the reason code (and whether an `Origin` was present) and
  exposes it as `lastRejection` in the state payload, so a future origin problem
  is diagnosable from one request instead of a reproduction session.

### Testing

- Three route tests pin the new contract: opaque/absent `Origin` accepted,
  `Sec-Fetch-Site: cross-site` refused for reads and writes, a foreign `Origin`
  refused with `origin-mismatch`, and the loopback alias accepted.

## [2.0.0] — 2026-10-11

The release that turns a random-pick plugin into a configurable, inspectable
and recoverable rotation system. The state file changes shape and migrates
automatically; the patch format and the on-disk managed block do not change.

### Added

- **Rotation policies**: `random`, `sequential`, `weighted` and `fixed`, chosen
  from one unified engine (`lib/rotation.js`) shared by boot, the route and the
  tests. Sequential resumes at the right position after a restart; weighted
  accepts any non-negative finite weight and treats `0` as "not in the draw".
- **Rotation pool** with an explicit status per skin: `compatible`, `excluded`,
  `incompatible`, `unavailable`. Excluding a skin never uninstalls it.
- **Recent-repeat control** (`disabled` / `recent-2` / `recent-3`) over the last
  *successful* rotations. It is a preference, never a blocker.
- **Rotation history** in its own bounded file (`.dsh-skin-rotation.history.json`,
  default 100 records, configurable): ISO 8601 time, from → to, trigger, mode,
  outcome, failing stage and a short reason.
- **Restore previous skin**: returns to the most recent successful skin still in
  the pool, and records the restore as its own trigger.
- **Crash-safe config writes**: a journal (`*.tx.json`) captures the pre-write
  content of both patch layers. On the next boot the transaction is finished
  when the writes landed, rolled back when they did not, and *refused* with a
  diagnostic when the files changed in ways the journal cannot explain.
- **State `schemaVersion` with migrations**, plus a separate history file so the
  state file stays small. Corrupt state degrades to defaults instead of failing
  the launch.
- **Rotation presets**: save the current controls under a name, apply them back,
  delete them. A preset naming an uninstalled skin stays valid and reports the
  reason at pick time.
- **Per-skin weights and exclusion list** in the settings card, plus a collapsed
  advanced section and a reset-to-defaults action.
- **Package verification** (`tools/verify-package.mjs`): packs the real tarball,
  unpacks it, loads it from an isolated directory, and rejects repo-only files,
  absolute developer paths and missing entry points. Run by CI.

### Changed

- The settings card is now an overview (switch, mode, recent rule, current skin,
  pool size), the skin list with pool checkboxes and weights, the actions
  (shuffle / restore / refresh) and the recent history, with advanced controls
  collapsed.
- `describeRotation()` returns the mode, recent rule, per-skin status and the
  recent history; it no longer returns any absolute path.
- The HTTP route validates `mode`, `rule`, skin ids and weights, and rejects
  `POST`s whose `Origin` cannot be verified against the host (missing, empty,
  `null` or foreign). Reads without an `Origin` stay available for tooling.

### Fixed

- Exclusions were lost on every save: the in-memory `Set` was neither accepted
  by the normalizer nor serializable, so `exclude` came back empty. Both the
  reader and the writer now handle the `Set` ↔ array conversion.
- Sequential mode shifted its index whenever the current skin was excluded from
  the candidate list, skipping a skin; the index now walks the full ordered pool.
- A recovery pass could treat a hand-edited patch file as "never written" when
  the file had not existed before the crash, and would silently roll it back.

### Security

- Route responses no longer include a local filesystem path, and errors return a
  short machine-readable code instead of internal detail.
- Config writes refuse to touch a patch file whose managed block is duplicated,
  truncated (missing its END marker) or orphaned (missing its BEGIN marker), so
  a plugin can never rewrite a file it does not fully own.

### Testing

- 59 tests: all four policies and the pool states, the once-per-launch guard,
  restore, bounded history, migration, crash recovery (finish / roll back /
  refuse), route validation and the same-origin policy, and the whole card
  render tree.
- Tests no longer read the developer's real DSH_HOME. The live-profile check is
  opt-in via `DSH_LIVE_PROFILE=1` and read-only.

### Documentation

- README (both languages) rewritten around the policy system, the card, the
  scope statement and the roadmap.
- Added CONTRIBUTING.md, SECURITY.md, and issue / pull-request templates.

## [1.0.2] — 2026-10-06

### Added

- `engines.dsh` manifest range so storefronts can show the host requirement.
- Client-mount report (`rendered`, `mounted`, `found`) recorded next to the
  preference, so a profile can be diagnosed without opening devtools.
- Process-level boot key: a hot reload of the plugin no longer re-rolls the
  skin; only a real restart does.
- `tools/e2e-rotation.sh`, which verifies the skin actually served to the
  browser, not just the plugin's own state.

### Fixed

- `npm test` / CI now use Node's own default test discovery (`node --test`),
  which finds the suites on Node 20, 22 and 24 alike; the previous `test/`
  path argument failed on the CI runners.

### Changed

- The card refetches its state whenever it (re)attaches to the skins page.
- README rebuilt as a bilingual pair (`README.md` / `README.zh.md`).

## [1.0.0] — 2026-10-06

### Added

- Host half: skin discovery from the profile manifest, the same `skin.json`
  validation the ecosystem uses, a SemVer evaluator mirroring DSH's plugin
  admission check (including `compatibility.json` grants), random pick that
  never repeats the previous skin, and a rewrite of the shared
  `dsh-skin managed` block in both patch layers.
- Browser half: one card inside the skin manager's Skins page with the
  rotation switch, a shuffle action, the current/picked skin and the pool.
- Preference route `GET/POST /api/dsh/skin-rotation`, same-origin only.
- 29 tests, including a differential SemVer test against node-semver.

[2.0.1]: https://github.com/luoyuejun9/dsh-skin-rotation/releases/tag/v2.0.1
[2.0.0]: https://github.com/luoyuejun9/dsh-skin-rotation/releases/tag/v2.0.0
[1.0.2]: https://github.com/luoyuejun9/dsh-skin-rotation/releases/tag/v1.0.2
[1.0.0]: https://github.com/luoyuejun9/dsh-skin-rotation/releases/tag/v1.0.0
