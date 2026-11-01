# Configuration reference

## Hub: `coop hub` (self-hosted)

| Option | Environment | Default | What |
| --- | --- | --- | --- |
| `--port` | `PORT` | `8765` | Port to listen on |
| `--host` | | `127.0.0.1` | Address to listen on. All interfaces or a public address also need `--public-bind` |
| `--public-bind` | | off | Allows that, and warns. Only with a firewall or proxy in front |
| `--data` | | `~/.claude-coop/hub` | The database, a hash of the lead token, and the lead's name |
| `--lead-name` | `COOP_LEAD_NAME` | `lead` | The lead's name in the crew. Remembered after the first run |
| `--crew` | `COOP_HUB_NAME` | `coop` | The crew's name, shown on the board |
| | `COOP_LEAD_TOKEN` | generated | Use this token instead of generating one. It's then read from the environment each time |
| | `COOP_MAX_WORKERS` | `8` | Workers and observers allowed |
| `--token-ttl-days` | `COOP_TOKEN_TTL_DAYS` | `90` | How long new tokens last. `0` means no expiry |
| `--retention-days` | `COOP_RETENTION_DAYS` | `90` | How long to keep history. `0` keeps it all |
| `--rotate-lead-token` | | | Makes a new lead token, prints it once, and stops the old one working |
| `--reset-approval` | | | Clears the approval passphrase, and exits. Needs access to the hub's data, not a token |

## Hub: Cloudflare

Set in `wrangler.toml` under `[vars]`: `COOP_LEAD_NAME`, `COOP_HUB_NAME`, `COOP_MAX_WORKERS`, `COOP_TOKEN_TTL_DAYS`, `COOP_RETENTION_DAYS`, with the same meanings. `COOP_LEAD_TOKEN` is a secret: `npx wrangler@4 secret put COOP_LEAD_TOKEN`. It must be at least 24 characters, and `coop token` prints a good one.

## Fixed hub limits

| Limit | Value |
| --- | --- |
| Request body | 64 KB |
| URL | 2 KB |
| Task title / details / scope | 200 / 20,000 / 2,000 characters |
| Message or note | 20,000 characters |
| Branch name, PR link | 200, 500 characters; strict format |
| Active tasks on the board | 2,000 |
| Open permission requests per worker | 20 |
| Permission request lifetime | 10 minutes |
| Request timestamp tolerance | 5 minutes |
| Request id log | 1 day |
| Tasks created per member | 120 an hour |
| Task actions per member | 600 an hour |
| Messages per member | 240 an hour |
| Permission requests per member | 120 an hour |
| Member changes, token changes per member | 30 an hour each |
| Reads per member | 600 a minute |
| All changes per member | 120 a minute |
| Refusals logged per member or source | 30 a minute |
| Failed sign-ins per source | 20 a minute, of which 10 are logged |
| Wrong approval passphrases | 5 per 15 minutes, then locked |

The per-minute limits are kept in memory, so that a flood costs no database writes. On Cloudflare each instance counts for itself, which makes them approximate.

Self-hosted server: 256 connections, 30 s per request, 15 s for headers, 10 s keep-alive, 60 s socket idle.

## Your PC

| Variable | Default | What |
| --- | --- | --- |
| `COOP_HOME` | `~/.claude-coop` | Where profiles, tokens and session state are kept |
| `COOP_PROFILE` | your default | Which crew profile to use |
| `CLAUDE_BIN` | found on `PATH` | The Claude Code executable |
| `COOP_POLL_MS` | `8000` | How often the MCP server polls the hub |
| `COOP_RELAY_PERMISSIONS` | on | `0` is the same as `coop start --no-relay` |

### Files in `~/.claude-coop`

| File | What |
| --- | --- |
| `config.json` | Crew profiles: hub URL, **token**, name, role. Owner-only |
| `state/<profile>.json` | The event cursor |
| `run/<profile>.mcp.json` | What `coop start` gives Claude Code to load the server. No token |
| `run/<profile>.settings.json` | coop's guard hook and deny rules for that crew |
| `run/<profile>.session.json` | Which session `coop start` reopens |
| `guard.log`, `guard.log.old` | What coop's guard blocked on this PC: the reason, not the command. Read it with `coop audit --local`. Rolls over at 1 MB |
| `hub/` | A self-hosted hub's data |

## `coop start`

| Option | What |
| --- | --- |
| `--new` | Start a fresh session rather than reopening the last one |
| `--permission-mode MODE` | `auto` (workers' default), `acceptEdits`, `manual`, `dontAsk`, `plan`. `bypassPermissions` also needs `--insecure-dev-mode` |
| `--worktree` | Work in a separate git worktree |
| `--no-relay` | Keep permission prompts on this PC |
| `--sandbox` | Confine shell commands with Claude Code's sandbox: macOS, Linux, WSL2. Refused on native Windows. Network limited to GitHub and npm |
| `--insecure-dev-mode` | Turn coop's guards off. Throwaway VMs only |
| `--prompt TEXT` | The first message |
| `--claude PATH` | The Claude Code executable to use |
| `--dry-run` | Print the command and exit |
| `-- ARGS` | Pass the rest to Claude Code. Options that turn off permission checks are refused |

## `coop join`

| Option | What |
| --- | --- |
| `--hub URL` | The hub. Must be https, or http on a private network |
| `--token TOKEN` | Your token. Leave it out to be asked, which keeps it out of your shell history |
| `--profile NAME` | Name for this profile. Defaults to the crew's name |
| `--insecure-dev-mode` | Allow plain http to a public address. Saved in the profile. Testing only |

## What coop's guard refuses

The guard's rules are in [src/guard.js](../src/guard.js). They catch common shapes rather than every possibility: see [security guarantees](security-guarantees.md).

**For every Claude:** credential locations (`~/.claude-coop`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `.git-credentials`, `.netrc`, `.npmrc`, `gh`'s config, `.docker/config.json`, `.kube/config`, Claude Code's credentials, private key filenames). `git credential`, `gh auth token`. Credential stores. Starting anything with checks off. Clearing the approval passphrase.

**For workers, also:** file tools outside the project, and `.env` files (a deny rule that Claude Code enforces). Writing `.git/`, `.mcp.json`, `.claude/settings*.json`, `.claude/hooks/`. Pushing protected branches, `--force`, `--mirror`, `--delete`, `--tags`, `--all`, `--no-verify`. Changing `core.hooksPath`. Merging or approving PRs. GitHub releases, secrets and repository settings. Publishing packages. Deploys and cloud CLIs. Running downloaded or encoded scripts. `sudo` and `runas`. Deleting outside the project. Scheduled tasks, registry changes and system-wide installs.

`--force-with-lease` is allowed. A person in their own terminal isn't affected, since the check only sees a Claude's tool calls. Only the pre-push hook applies there, and `--no-verify` skips it.
