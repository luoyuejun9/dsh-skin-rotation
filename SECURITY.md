# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
private reporting instead: **Security → Report a vulnerability** on
[the repository](https://github.com/luoyuejun9/dsh-skin-rotation/security/advisories/new).
If that is unavailable, open an issue that says only that you have a private
report to make, without the details, and a maintainer will open a private
channel.

Useful in a report:

- the plugin version and the DSH version,
- what an attacker would gain, and what they need to start with,
- the smallest reproduction you can manage,
- whether the issue is already public anywhere.

## What this project can actually affect

Knowing the blast radius helps triage:

- The plugin runs **inside the DSH host** with the host's own file permissions.
  It writes exactly three things: the shared `dsh-skin managed` block in the
  profile patch and the home patch, the preference file
  `<profile>/.dsh-skin-rotation.json`, and the bounded history file
  `<profile>/.dsh-skin-rotation.history.json` (plus a short-lived `*.tx.json`
  journal during a rotation).
- It **never** writes to a skin package, a `skin.json`, or any other plugin's
  configuration. It refuses to touch a patch whose managed block it cannot
  delimit unambiguously.
- It exposes one same-origin HTTP route, `GET/POST /api/dsh/skin-rotation`.
  Cross-site requests are rejected; state-changing `POST`s additionally require
  an `Origin` that matches the host.
- It has **no** runtime dependencies, makes no network requests of its own, and
  sends no telemetry or rotation history anywhere.

## Maintainer process

1. Acknowledge the report in the private thread.
2. Reproduce it against a throwaway `DSH_HOME`, never a reporter's profile.
3. Fix it, and add a regression test where the bug is testable.
4. Publish a patch release; credit the reporter unless they prefer otherwise.
5. Publish a GitHub security advisory once the fix is available.

This is a volunteer project: there is no guaranteed response time, and no
bug-bounty program. Reports are handled as capacity allows.
