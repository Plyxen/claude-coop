# Changelog

## 0.2.0

Security hardening. See [security guarantees](docs/security-guarantees.md) for what is and isn't enforced, and the [threat model](docs/threat-model.md).

**Upgrade in this order:** deploy the hub, then the lead runs `coop update` and `coop approvals setup`, then workers run `coop update`. Older workers keep working against the new hub. An older lead client can't allow or refuse permission requests, invite or remove until it's updated.

Breaking changes:

- Allowing a permission request takes `coop approve` and an approval passphrase. Until one is set, requests can only be refused. `coop_permission` can only refuse, and the `coop_invite` tool is gone.
- New tokens expire after 90 days, and history is deleted after 90 days. Both are configurable.
- `/health` no longer shows the crew or version.
- `coop hub --host 0.0.0.0` needs `--public-bind`.
- Plain http to public addresses, and bypass flags on `coop start`, need `--insecure-dev-mode`.
- A self-hosted hub's lead token file is replaced by a hash, so it isn't shown again. `coop hub --rotate-lead-token` makes a new one.
- Sensitive API calls need `x-coop-request-id` and `x-coop-timestamp`. API errors carry a `code`.
- Stricter branch names, reserved member names, and lead tokens of at least 24 characters.
- `coop start` adds guard settings, and installs a pre-push hook for workers. Worker file tools are limited to the project, common dangerous commands are blocked, and pushes are scanned for secrets.
- Workers don't get a prompt for `coop_status`, `coop_task`, `coop_inbox` or `coop_claim`, in any mode. They send nothing off the PC but a task number, and the hub decides what they may do. Tools that carry text still ask in `acceptEdits` and `manual`.
- The hub limits each member to 120 changes a minute, on top of hourly limits per kind of change.
- The client refuses to send a token to an https hub if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Use `NODE_EXTRA_CA_CERTS` for a private certificate authority.

Added: `coop approvals`, `coop permissions`, `coop approve`, `coop deny`, `coop audit` (with `--local` for what the guard blocked on this PC), `coop tokens`, `coop start --sandbox`, the observer role, per-device tokens, an audit log with alerts, rate limits, CI security checks, and docs for the [threat model](docs/threat-model.md), [security guarantees](docs/security-guarantees.md) and [configuration](docs/configuration.md).

## 0.1.4

- `coop start` reopens your last coop session for that crew and folder (`claude --resume`) instead of starting a new one every time, so the session list doesn't fill up with copies. `coop start --new` starts a fresh session. A new one also starts after a coop update (a resumed session keeps the instructions it began with), when the old one's history is gone, when the last session still looks open in another window, with `--worktree`, and when you pass your own session flags after `--`.

## 0.1.3

- `coop update` installs the latest version from GitHub; `coop update --check` only says whether there is one. A coop that runs from a git clone isn't reinstalled: it tells you to `git pull` instead.

## 0.1.2

- Renamed from claude-coop to claude-code-multi-pc, so people looking for Claude Code across several PCs and accounts can find it. The command is still `coop`, settings stay in `~/.claude-coop`, and the old GitHub address redirects. To switch an existing install: `npm uninstall -g claude-coop`, then `npm install -g github:Plyxen/claude-code-multi-pc`.
- A new hub's default crew name is now `coop`, and the Cloudflare example names the Worker and database `coop-hub`. Hubs you already run keep their names.

## 0.1.1

- CLI commands (`coop join`, `status`, `doctor`, ...) no longer make you look online or tell the lead "your Claude is online". Only a running Claude session counts. The hub skips presence for requests with `X-Coop-Presence: off`; update the hub too.
- Suggested branch names keep whole words and don't end on words like "for" or "the" when a long title is shortened.

## 0.1.0

First release.

- Hub with crew, task board, event log and permission relay. Runs as a Cloudflare Worker (D1) or self-hosted on Node (built-in SQLite).
- `coop` CLI: `hub`, `join`, `invite`, `remove`, `start`, `status`, `doctor`, `profiles`, `use`, `token`, `mcp`.
- MCP server that is also a Claude Code channel: lead and worker tools, pushes crew events into the session, reminders for waiting work, and `coop_inbox` for sessions without channels.
- Docs for leads, workers, project setup, deployment, security and troubleshooting.
