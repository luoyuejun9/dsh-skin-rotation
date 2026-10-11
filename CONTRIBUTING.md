# Contributing

Thanks for helping. This plugin is small on purpose: no runtime dependencies,
Node's built-in test runner, and a browser half that is one file. Please keep it
that way unless there is a strong reason.

## Requirements

- Node.js 20, 22 or 24 (CI runs all three; the host itself runs Node 24).
- No package manager step: `npm install` is not needed, the package has no
  dependencies.
- Optional: `node-semver` next to the checkout, so the differential range test
  runs instead of skipping (`npm install --no-save semver@7`).

## Run the tests

```sh
node --test                 # every suite
node --test test/host.test.mjs   # one suite
node --test --test-name-pattern="weighted"   # one behaviour
```

The suite is deterministic: random picks take an injected `random`, and every
test builds its own throwaway profile under the OS temp directory.

### The opt-in live-profile test

Two assertions read a real DSH profile. They are skipped by default and
read-only when enabled:

```sh
DSH_LIVE_PROFILE=1 DSH_LIVE_PROFILE_PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml" node --test
```

Never point this at a profile you cannot afford to have read; it still writes
nothing, but it inspects the file.

## Verify the package

```sh
npm run verify:package   # pack, unpack, load, and reject leaks
npm run check            # tests + package verification
```

`tools/verify-package.mjs` fails the build when a shipped file is missing, a
repo-only file leaks into the tarball, an `exports` target does not exist, or an
absolute developer path appears in a shipped file.

## Real-host check

`tools/e2e-rotation.sh` boots a real DSH host against an **isolated**
`DSH_HOME` and asserts that the skin the browser receives is the picked one:

```sh
tools/e2e-rotation.sh /tmp/dsh-rotation-test web 19487
```

It needs a `dsh` binary (`DSH_BIN` overrides), curl and node. It never touches
your own profile: create the isolated home, install the bundle into it, and keep
it outside the repository.

## Code style

- ES modules, `node:` prefixed built-ins, `.mjs` for tests and tools.
- JSDoc on exported functions; comments explain *why*, not *what*.
- Pure business logic in `lib/rotation.js` and `lib/state.js`; the HTTP route and
  the browser half only wire things together.
- The browser half (`lib/client.js`) is a plain script registering a factory on
  `window.__ModuleLoader__`. It may use React through `require('react')` and
  nothing else from the host; no bundler, no JSX.
- Error messages are short machine-readable codes (`invalid-weight`,
  `fixed-not-installed`) that the UI can translate; never leak a stack or a path
  to the browser.

## Reporting a bug

Use the bug report template. The three facts that make a report actionable:
the DSH version (`dsh --version`), the plugin version, and the last few lines of
the host log around the failure. Redact anything personal — never paste your
home directory, keys or tokens.

## Proposing a feature

Open an issue first for anything larger than a fix. Rotation proposals should
say how the new rule behaves when the candidate pool is empty, when only one
skin is usable, and how it is undone. Features that need a DSH API must name the
API and the version that provides it; an idea that needs an unverified host
interface belongs in the roadmap, not in a pull request.

## Pull requests

1. Keep the diff focused; no drive-by reformatting.
2. Add or update tests for the behaviour you changed. Do not weaken an existing
   assertion to make a change pass.
3. Run `npm run check` and paste the result in the description.
4. If the change touches `lib/state.js`, bump `SCHEMA_VERSION` and add a
   migration step with a test.
5. If the change touches the patch writer, add a recovery case to
   `test/rotation.test.mjs`.
6. Update both READMEs and the CHANGELOG (Added / Changed / Fixed / Security /
   Testing / Documentation) when behaviour changes.

## Releasing

Maintainers only:

```sh
npm run check
npm version <patch|minor|major>
npm pack --pack-destination dist
```

Publish the tag and attach the tarball to the GitHub release with the
**version-free** asset name `dsh-skin-rotation.tgz` (the catalog entry and the
README both point at `releases/latest/download/dsh-skin-rotation.tgz`, which
only stays valid while the asset name carries no version).
