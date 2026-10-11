## What changed

<!-- One paragraph. Link the issue if there is one. -->

## Why

<!-- The behaviour or bug this addresses. -->

## Checks

- [ ] `npm run check` passes (tests + tarball verification)
- [ ] New or updated tests cover the change; no existing assertion was weakened
- [ ] If `lib/state.js` changed: `SCHEMA_VERSION` bumped and a migration test added
- [ ] If the patch writer changed: a recovery case added to `test/rotation.test.mjs`
- [ ] If behaviour changed: both READMEs and the CHANGELOG updated
- [ ] No personal paths, keys, tokens or machine-specific values added

## Rotation edge cases (fill in if this touches the policy engine)

- Empty pool:
- Single usable skin:
- Undo / rollback:
