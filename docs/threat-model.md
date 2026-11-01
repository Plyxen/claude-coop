# Threat model

Who this protects against, and how far. For a table of what's enforced, see [security-guarantees.md](security-guarantees.md).

**The principle: Claude is not the security boundary.** Claude can make mistakes, misread instructions or follow a prompt injection. So a rule that matters has to be enforced by the hub, Claude Code's hooks and permissions, git, your git host, the operating system, or a person. Anything that only exists as an instruction to Claude is listed here as an instruction, not as a control.

## What's being protected

| Asset | Where it lives | What protects it |
| --- | --- | --- |
| Claude Code sessions | Each person's PC | Claude Code's permission mode, coop's guard hook |
| Source code | Each clone, and your git host | The OS account, your git host's access rules. Never sent to the hub by coop |
| Git and cloud credentials | Each person's PC | The OS account. coop's guard blocks common ways to read them, but that isn't a hard limit |
| Crew tokens | Hashes on the hub; the token itself in `~/.claude-coop/config.json` on the PC that uses it | Hashing, expiry, revocation, owner-only file permissions |
| Approval passphrase | A person's memory. The hub holds a hash of a scrypt-derived key | Never stored on a PC, typed at a hidden prompt |
| Hub data: tasks, messages, permission prompts, audit log | D1 or a SQLite file | Bearer auth and roles. Secret patterns removed on the way in. Deleted after the retention period |
| Project configuration | `CLAUDE.md`, `.claude/`, `.mcp.json`, git hooks | The guard blocks a worker's file tools from the ones that change what runs next |

## Trust boundaries

```
 Person ─► Lead's Claude ─► Hub ─► Worker's MCP server ─► Worker's Claude ─► Claude Code ─► OS
                                                                               ▲ hooks, permissions
```

| Layer | Can trust | Must not trust |
| --- | --- | --- |
| **Person at a terminal** | Their own decisions | The text of a permission request: it comes from the worker's PC. Judge what the command would do |
| **Lead's Claude** | Its own person, and `from_role` on channel tags (as far as it trusts the hub) | Anything workers wrote, including PR text and code it reviews. It can't approve anything |
| **Hub** | A token's hash, once it matches, as proof of which member is calling | Everything in a request body, whoever sent it. Including the lead, whose token may be in the hands of its Claude |
| **Worker's MCP server** | Its own local profile, once validated | Everything from the hub: it cleans all text, filters the shape of events, and forwards a verdict only for a request this session has open |
| **Worker's Claude** | Its user, its project's rules, and the lead's tasks within them | Worker-to-worker messages, repository content, web content |
| **Claude Code** | Its own settings, including coop's hook and deny rules | What Claude asks for. That's what the hook and permission mode check |
| **OS** | Nothing above it | Is the only thing here that can draw a hard line, when it's set up to: a separate user account, a VM, or Claude Code's sandbox |

## Threat actors

### A malicious worker (their token, their Claude, their PC)

**Can:** claim tasks, post text, submit branches and PRs with malicious code, ask for permissions, and waste the lead's attention.

**Can't:** create or assign tasks, invite or remove anyone, see other workers' private messages or permission requests, read the audit log, answer a permission request, or pose as the lead. The hub enforces all of that by role. Rate limits and size limits bound a flood, though a member working just under them can still use up a free-tier database quota. Their text reaches the lead marked as a worker's, quoted, and with an instruction that it's data.

**Still open:** a malicious PR needs a person to catch it. Prompt injection in worker text or code can still mislead the lead's Claude. It can't approve permission requests or mint tokens if a passphrase is set, but it can still misjudge code, assign tasks or approve a task. Keep merges human, and protect the default branch.

### A compromised worker PC

Everything above, plus whatever that OS account can reach: that person's credentials, and the worker's token. coop's checks run on that PC, so they can be turned off there.

**Limited by:** your git host's branch protection, which the PC can't turn off. The lead can revoke the token at once. The hub never gets its git credentials, so they don't spread from there.

### A compromised lead PC, or a lead's Claude that has been taken over

**Can:** do anything the lead token can: create tasks that workers' Claudes will act on, deny requests, remove workers, read the audit log, and read everything the crew sends.

**Can't, if a passphrase is set and a person doesn't reveal it:** approve a permission request, invite someone, or replace the passphrase.

**Still open:** tasks are instructions. A taken-over lead can tell a worker's Claude to do damaging things in that project, within the worker's permission mode and guards. That's why you should only join crews whose lead you'd trust, and why a worker keeps its own permission mode. With control of the PC, an attacker can also capture the passphrase as it's typed. If the lead's Claude gets there first, on a hub with no passphrase yet, it can set one itself: `coop doctor` and an alert show that one is set, and whoever runs the hub can reset it.

### A stolen token

**Worker token:** acts as that worker until revoked or expired (90 days by default, tokens from before 0.2 have no expiry). The lead revokes it with `coop tokens revoke-all --member NAME`.

**Lead token:** see the previous section. Change it on the hub: `coop hub --rotate-lead-token`, or `wrangler secret put COOP_LEAD_TOKEN`.

Repeated use of a revoked token, and failed sign-ins from one source, raise alerts. Nothing detects a stolen token that's used normally.

### A compromised hub (or its host)

This is the weakest point in the design, and worth being plain about.

**Can:** read everything sent through it. Create tasks and messages that look as if the lead wrote them, since no message is signed end to end. **Forge a permission verdict for a request that's open** on a worker: the worker's server checks the request id, the time and the claimed role, but has no way to verify that the hub is telling the truth. It can also leave stale data, or stop serving.

**Can't:** read project files or run commands directly. There's no such path in coop. It only sends text. It can however tell a worker's Claude to send it things through `coop_submit` or `coop_send`, within the worker's permissions.

**Limited by:** the worker's permission mode and guard, which are local. `coop start --no-relay` takes away verdict forging, since prompts then stay on the worker's own PC. Run the hub somewhere you trust as much as the lead. A signed-verdict design would close the forging gap: it isn't built.

### A malicious repository

A worker's Claude reads project files, and those can contain prompt injection. Claude Code loads `CLAUDE.md` and settings from the project. Scripts in `package.json` and git hooks in a repository run as that user.

**Limited by:** the guard blocks common dangerous shapes. The permission mode applies. Only work on repositories you trust. The tool does not make hostile repositories safe to work on: that takes a VM.

### Malicious task input and prompt injection

Text in a task, a message, a PR or a web page may try to redirect a Claude.

**Enforced:**
- Control characters, escape sequences and bidirectional overrides are removed. Text can't open or close the tags Claude reads it in, so it can't pass as coop or another sender. `from_role` comes from the hub.
- Worker text is quoted and marked as data.
- The guard blocks known dangerous commands.
- Approvals take a person.
- Secrets matching known patterns are taken out.

**Not enforced:** that Claude isn't persuaded. Prompt injection stays an unsolved problem. These controls limit what a misled Claude can do, not whether it's misled.

### A network attacker

**HTTPS (Cloudflare, or a proxy or tunnel in front of a self-hosted hub):** protects tokens and content. TLS verification is never turned off in this code. Redirects are refused, so a token can't follow one somewhere else or down to plain http.

**Plain http:** `coop join` and the client refuse it to public addresses, and warn on a private network. On Tailscale, Tailscale encrypts the traffic. `--insecure-dev-mode` overrides the refusal, by name, on that PC only.

**Replay:** a repeated request id doesn't run twice, and sensitive requests must carry a timestamp within 5 minutes. **This isn't protection against someone who can read your traffic:** they would have the bearer token too. TLS is what prevents that.

### A malicious dependency

Runtime dependencies are only the MCP SDK and zod. The lockfile pins them for development and for hub deploys, but `npm install -g github:...` ignores a package's lockfile and resolves them from the version ranges in `package.json` when it installs. CI runs `npm audit`, dependency review, and CodeQL. Dependabot proposes updates. A malicious update that passes those would run on every PC that installs it. `coop update` installs what's on `main`, which isn't a signed release.

## Out of scope

- Protecting a person from a lead they chose to trust, beyond the limits above.
- Protecting against the operating system account being compromised, on any PC.
- Claude Code's own security. coop relies on its hooks, permissions and sandbox working as documented.
- Denial of service against Cloudflare, or by your own lead.

## Reporting a vulnerability

Please open a [GitHub security advisory](https://github.com/Plyxen/claude-code-multi-pc/security/advisories/new) rather than a public issue.
