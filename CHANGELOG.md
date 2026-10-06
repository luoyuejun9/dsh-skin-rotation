# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-10-06

### Added

- `engines.dsh` manifest range so storefronts can show the host requirement.
- Client-mount report (`rendered`, `mounted`, `found`) recorded next to the
  preference, so a profile can be diagnosed without opening devtools.
- Process-level boot key: a hot reload of the plugin no longer re-rolls the
  skin; only a real restart does.
- `tools/e2e-rotation.sh`, which verifies the skin actually served to the
  browser, not just the plugin's own state.

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

[1.0.2]: https://github.com/luoyuejun9/dsh-skin-rotation/releases/tag/v1.0.2
[1.0.0]: https://github.com/luoyuejun9/dsh-skin-rotation/releases/tag/v1.0.0
