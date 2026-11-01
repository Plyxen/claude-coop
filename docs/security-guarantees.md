# Security guarantees

What claude-code-multi-pc actually enforces, and what it doesn't. Read this before relying on it. The reasoning behind it is in the [threat model](threat-model.md).

| Status | Meaning |
| --- | --- |
| **YES** | Enforced in code, whatever Claude does, and covered by tests |
| **PARTIAL** | Enforced for some cases. The explanation says which, and what gets through |
| **CONFIGURATION-DEPENDENT** | True only if you set it up as described |
| **NO** | Not provided |

## Authentication and tokens

| Property | Status | Explanation |
| --- | --- | --- |
| Tokens are high-entropy and random | YES | 192 bits from a CSPRNG. Token ids are separate and not usable as credentials. |
| Tokens stored hashed | PARTIAL | On the hub: SHA-256 only, including a self-hosted hub's lead token, and upgrading replaces an older plain file with its hash. On Cloudflare the lead token is also a Worker secret, which the Worker can read. On client PCs the token itself is kept: see the next row. |
| Tokens protected on client PCs | PARTIAL | Stored in the clear in `~/.claude-coop/config.json`, with owner-only permissions on macOS and Linux and the profile folder's ACL on Windows. Anything running as that user can read it, including a Claude's shell if it evades the guard. There's no OS keychain support. |
| Tokens expire | PARTIAL | New tokens last 90 days (configurable). Tokens from before 0.2 and the lead token have no expiry. `coop doctor` shows yours. |
| Tokens can be revoked | YES | One device, or all of a member's, effective on the next request. The lead token is changed on the hub rather than through the API. |
| Tokens can be rotated | YES | `coop tokens rotate`. The old token stops at once. |
| Devices tracked separately | YES | Each device token has its own id, label, last-used time and expiry. |
| Failed sign-ins are limited | YES | 20 a minute per source, of which the first 10 are logged. Nothing is written past that. Valid tokens always pass, so an attacker on the same tunnel can't lock anyone out. On Cloudflare each instance counts for itself. Behind a proxy, all clients count as one source. |

## Authorization

| Property | Status | Explanation |
| --- | --- | --- |
| RBAC enforced server-side | YES | Lead, worker, observer, checked by the hub on every request. Tools hidden from a Claude are a convenience, not the control. |
| Lead's Claude can't approve permissions | PARTIAL | The hub requires a key from a passphrase that's stored nowhere on the PC. It doesn't hold if a person pastes the passphrase into a chat, if malware captures it, or if a Claude sets the passphrase first on a hub that has none (you'd get an alert, and `coop approvals status` would show one you didn't set). |
| Tokens stay out of a Claude's conversation | PARTIAL | There's no invite tool for Claude, and tool arguments and hub text are scanned for token patterns. But a lead's Claude can run `coop invite` in its shell and read the token it prints, unless a passphrase is set, in which case the hub refuses without it. |
| A worker can't pose as the lead | YES | The sender's name and role come from the token. Text can't close the tag it's shown in. |
| Separate admin role | NO | One lead per crew. The lead token plus the passphrase is the highest level. |

## Requests

| Property | Status | Explanation |
| --- | --- | --- |
| Replay attacks prevented | PARTIAL | A repeated request id doesn't run twice. Sensitive requests need a fresh timestamp (5 minutes) and an id. Permission answers work once, for the exact worker and request. This covers retries and accidental repeats. Someone who captured a request also has the bearer token, so only TLS helps there. Requests aren't signed. |
| Duplicate task claims | YES | Atomic state checks: one wins. |
| Permission approvals expire | YES | 10 minutes, on the hub and on the worker. A late answer is refused. |
| Permission approvals work once | YES | Atomic. Duplicates are refused and logged. |
| Answer matched to its request and worker | YES | Hub and worker's server both check. |
| A compromised hub can't forge a verdict | NO | Verdicts aren't signed end to end. Use `coop start --no-relay` if you don't trust the hub. |
| Payload limits | YES | 64 KB bodies, per-field limits, 2 KB URLs, 4 MB client responses, 40 KB per push. |
| Rate limits | YES | Hourly limits per member and kind of change, in the database. Per-minute limits on all reads and all changes, in memory, so that a flood costs no writes. On Cloudflare each instance keeps its own per-minute counts, so those are approximate. |
| Database write quota safe from floods | PARTIAL | Floods are cut off in memory, and refusals past a limit aren't logged. But a member working just under the limits, or an attacker with many addresses, can still use up a free-tier D1 write quota. Reads then keep working, and changes fail until it resets. Revoke the token, and use Cloudflare's own rate limiting rules. |
| Malformed input refused | YES | Names, ids, branches and URLs by allowlist. Free text is cleaned and length-limited. Fuzz-tested for crashes and 500s. |

## Worker's PC

| Property | Status | Explanation |
| --- | --- | --- |
| Hub cannot read worker project files | PARTIAL | The hub has no path to them, and coop sends none. But a compromised hub can ask a worker's Claude to include file contents in a message, and Claude may do it. |
| No remote command execution in coop | YES | There's no such feature. But tasks are text that a Claude acts on, so see the next row. |
| A lead or hub can't get commands run on a worker | NO | That's what the tool does: a Claude takes tasks and runs commands, within its permission mode and guards. |
| Worker cannot access outside project | PARTIAL | Claude's file tools are checked, as the next row says. Its shell, MCP tools, WebFetch and WebSearch aren't confined by coop, and plain `claude` has no guards at all. A hard limit takes the OS. |
| Worker's file tools stay in the project | YES | With `coop start`, Read, Edit, Write, Glob and the rest are checked against the real path: `..`, symlinks, junctions, UNC, drive-relative paths, device names and data streams. Exceptions: Claude Code's own folders, and the temp folder. |
| Worker's shell stays in the project | CONFIGURATION-DEPENDENT | The guard refuses common shapes, such as an `rm`, `rd`, `del` or `Remove-Item` that names a path outside the project, but a shell can reach anything the user can. A path in a variable, `find -delete`, or a script gets past it. Only `coop start --sandbox` (macOS, Linux, WSL2), a dedicated user account or a VM confine it. |
| Worker cannot push a protected branch | CONFIGURATION-DEPENDENT | Only your git host's branch protection is a hard limit. coop's guard and pre-push hook stop ordinary attempts, including `HEAD:main`, but a compromised PC or a clever script can get past them. A pre-push hook can be skipped with `--no-verify` by anyone at a terminal. |
| Secrets can't be read by a Claude | PARTIAL | The guard and deny rules block known credential locations from file tools and from commands that name them. A shell command can avoid naming them. |
| Sandbox available | CONFIGURATION-DEPENDENT | `coop start --sandbox` uses Claude Code's sandbox and fails if it can't start. Not available on native Windows, where coop refuses rather than running without one. It covers shell commands, not file tools (the guard covers those) or WebFetch. The settings coop generates are tested. The OS sandbox itself isn't, by this project. |
| VM-level isolation | NO | coop doesn't provide it. Run a worker in a VM or a dedicated OS account if you need it. |
| Guards can't be turned off from outside | YES | Only `--insecure-dev-mode`, typed on that PC. Nothing from a hub or a task reaches the launch options, except names that have been validated. |
| Guards can't be bypassed by a Claude on that PC | NO | They catch mistakes and common payloads. Claude Code's hook runs before each tool, but a shell can do things no pattern expects. Quoted text counts as a mention unless a shell or a process call will run it, so a script that builds a command out of such text gets past. |
| Guards fail closed | PARTIAL | Claude Code 2.1.295 or newer blocks if the guard fails or times out (verified with 2.1.316 on Windows). On older versions, a hook that can't start lets the call through. The guard's own errors always block. Plain `claude`, without `coop start`, has no guards. |
| Prompt injection is prevented | NO | Nobody can promise this. The controls limit what a misled Claude can do. |

## Secrets

| Property | Status | Explanation |
| --- | --- | --- |
| Secret scanning available | PARTIAL | Pattern matching for common kinds: GitHub, AWS, Anthropic, OpenAI, Slack, Stripe, Google, coop tokens, JWTs, private keys, database URLs and password assignments. It runs on tool arguments, on the hub, on pre-push and in CI. It only knows what popular secrets look like. Treat it as a safety net. |
| Secrets not logged by coop | YES | Tokens, keys and bodies aren't written to the audit log or server logs. Tests check the log's content. |
| Git credentials never reach the hub | YES | No coop code reads or sends them. |

## Network and storage

| Property | Status | Explanation |
| --- | --- | --- |
| Encrypted in transit | CONFIGURATION-DEPENDENT | Cloudflare and https proxies: yes. Tailscale: yes. Plain http on a LAN: no, and coop warns. Plain http to a public address is refused unless you pass `--insecure-dev-mode`. |
| coop never disables TLS verification | YES | There's no option for it, and redirects are refused. The client also refuses to send a token to an https hub if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in its environment. |
| Hub is private by default | YES | `coop hub` listens on 127.0.0.1. All interfaces or a public address need `--public-bind`. |
| Encrypted at rest | CONFIGURATION-DEPENDENT | coop adds no encryption of its own. A self-hosted SQLite file is as protected as its disk. On Cloudflare it's up to their storage: check their documentation rather than relying on this page. |
| Data minimised | PARTIAL | No code and no conversations. Tasks, messages and permission previews are stored, with known secret patterns removed. |
| Data retention | YES | 90 days by default, configurable, 0 keeps everything. Active tasks and members stay. Cleanup runs at most hourly, on a request. |
| Audit log available | YES | `coop audit`, lead only. No secrets. |
| Audit log tamper-proof | NO | The API can't edit it, but whoever has access to the database can. Source addresses are stored only as short hashes, which someone with the database could guess back for IPv4. Worker disconnects aren't logged, since polling has no disconnect: the board shows who's online. |
| Alerts | PARTIAL | The lead hears about repeated failures through the channel, `coop status` and `coop audit`. They only reach someone who's looking: there's no email or push. Thresholds are simple counts. What the guard blocks on a worker's PC goes in a log on that PC (`coop audit --local`). It doesn't reach the hub, so the lead isn't told. |

## Reliability

| Property | Status | Explanation |
| --- | --- | --- |
| Survives hub restart, session restart | YES | State is in the database, cursors on disk. Tests cover it. |
| Survives losing an answer | YES | Retries reuse the request id, and get the first answer back. Sensitive requests get a refusal instead, since their answers can hold a token and aren't stored: check what happened and run them again. |
| Atomic multi-step changes | YES | On both D1 and SQLite. The tests use SQLite. The upgrade from 0.1 and the main flows were run on Cloudflare's runtime and D1 locally through Miniflare, before release, not on Cloudflare's production service. |
| Delivery of pushes | PARTIAL | Pushes are best effort. The board is the source of truth, and reminders back it up. |
| Timeouts on network calls | YES | 15 s per call in the client, with bounded retries. Server timeouts on the self-hosted hub. |
