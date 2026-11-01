# Security

claude-code-multi-pc lets one person's Claude hand work to Claude sessions on other people's PCs. That's the point of it, and it's also why everyone in a crew should trust the lead. This page is the practical guide. For exact claims see [security guarantees](security-guarantees.md), and for the reasoning the [threat model](threat-model.md).

**Claude is not the security boundary.** Instructions to Claude help, but anything that matters is enforced by the hub, Claude Code's hooks and permissions, git, your git host, the OS, or a person.

## What the lead can make a worker do

The lead sends **text**: tasks, feedback and messages. The worker's Claude reads that text and acts on it **with the worker's Claude Code permissions, on the worker's PC, inside the folder where `coop start` ran**. It is not remote desktop: nobody sees the screen or moves the mouse. But a Claude that follows instructions can do whatever its permissions let it, so only join crews whose lead you'd let use your PC's Claude.

## What limits a worker

From the hardest limit to the softest:

1. **The operating system.** A VM, a separate user account, or `coop start --sandbox` on macOS, Linux or WSL2. **This is the only hard limit on what commands can do.** On native Windows, Claude Code has no sandbox: use a VM or a separate account if you need one.
2. **Your git host's branch protection.** The only hard limit on what reaches `main`. See [project setup](project-setup.md).
3. **Claude Code's permission mode and deny rules**, enforced by Claude Code whatever Claude decides. `auto` is the default for workers. `acceptEdits` or `manual` make commands wait. `bypassPermissions` removes every check, so `coop start` refuses it unless you add `--insecure-dev-mode`.
4. **coop's guards**, which `coop start` installs:
   - A check that Claude Code runs before each file and shell tool call. It keeps a worker's file tools in the project (following symlinks and junctions, and catching Windows path tricks), keeps them off credential folders and off files that change what runs next, and refuses commands like `git push origin main`, `git push --no-verify`, `gh pr merge`, `npm publish`, deploys, `curl | sh`, deletes that name something outside the project, and starting a nested Claude with its checks off. It looks at what a command runs, so a commit message or a search that only mentions those words is fine.
   - A git pre-push hook that refuses protected branches, the remote's default branch, tags, and commits that add something that looks like a secret. It won't overwrite a hook that's already there.

   They catch mistakes and common prompt-injection payloads. **They aren't a sandbox:** a shell can do things no pattern expects.
5. **The hub's rules**, which limit what a worker's token can do at all.
6. **Instructions**, which tell a worker's Claude to stay in the folder, follow the project's CLAUDE.md, and refuse to deploy or touch secrets. They help, and they're the weakest layer.

## Approving permission requests

If a worker's Claude Code needs approval, the prompt can reach the lead. **The lead's Claude can show it to you and refuse it, but it can't approve it.** Approving takes a person:

```bash
coop approvals setup      # once: choose a passphrase. It isn't stored on this PC
coop permissions          # see what's open
coop approve bob abcde    # shows the request, asks for the passphrase
coop deny bob abcde       # no passphrase needed
```

- Until a passphrase is set, requests can only be refused.
- A request can be answered once, and only within 10 minutes. After that it's refused, and the worker's own prompt stays open on their PC.
- **Open doesn't mean waiting.** The person at the worker's PC can answer there, and in `auto` mode Claude Code's own check decides without waiting. Neither reaches the hub, so a command may already have run while its request still shows as open. Claude Code drops a late answer, so approving it then does nothing.
- The text of a request comes from the worker's PC. Judge what the command would do, not what it says it's for. The risk label is a hint, not a check, and no label ever gets a request approved.
- Five wrong passphrases lock approvals for up to 15 minutes. Refusing still works.
- **Never type the passphrase into a Claude conversation.** That would give it to the thing it's there to stop.

With a passphrase set, `coop invite` needs it too, so whatever holds only your lead token can't mint new credentials.

Forgot it? Whoever runs the hub can clear it. On a self-hosted hub: `coop hub --reset-approval`. On Cloudflare:

```bash
npx wrangler@4 d1 execute coop-hub --remote --command "DELETE FROM settings WHERE key LIKE 'approval_%'"
```

A worker's owner who doesn't want the lead's person approving anything can start with `coop start --no-relay`, and prompts stay on their own PC.

## Roles

| | Lead | Worker | Observer |
| --- | --- | --- | --- |
| Read the board and tasks | yes | yes | yes |
| Claim and work on tasks | yes | yes | no |
| Send messages | yes | yes | no |
| Create, assign, review, cancel tasks | yes | no | no |
| Invite and remove members | yes (passphrase to invite, if set) | no | no |
| Ask for permission | no | yes | no |
| Answer permission requests | refuse: yes. approve: with the passphrase | no | no |
| Rotate and revoke their own tokens | not via the API | yes | yes |
| Revoke others' tokens | yes | no | no |
| Read the audit log, change security settings | yes | no | no |

The hub enforces this on every request. Each crew has one lead, and there's no separate admin role. `coop invite NAME --observer` adds an observer, who can read the board with `coop status` but doesn't run a Claude session.

## Tokens

- Every member has their own token, 192 random bits. The hub stores only SHA-256 hashes.
- Tokens live in `~/.claude-coop/config.json` with owner-only permissions where the OS supports it. Never in the project folder, never in `.mcp.json`, and no longer in a Claude's conversation: there's no invite tool for Claude.
- New tokens last 90 days. `coop tokens rotate` renews yours, and `coop doctor` warns when it's close. Tokens from before 0.2 have no expiry until they're rotated.
- Send tokens privately. If one leaks:

```bash
coop tokens --member bob                 # list bob's tokens
coop tokens revoke tok_0123456789abcdef  # stop one device
coop tokens revoke-all --member bob      # stop all of them
coop invite bob                          # or replace them with a new one
```

- **The lead token** is changed on the hub: `coop hub --rotate-lead-token` on a self-hosted hub, or `npx wrangler@4 secret put COOP_LEAD_TOKEN` on Cloudflare. Then run `coop join` again.
- On a self-hosted hub, the data folder holds only a hash of the lead token, so nothing there signs anyone in. The token is printed once.

## Network

Use https, or a private network like Tailscale, between PCs. `coop join` refuses plain http to public addresses, and warns on private ones. `coop hub` only listens on your own PC unless you say otherwise. See [self-hosting](self-hosting.md) for Tailscale, reverse proxies and firewalls.

coop never turns off TLS checks, and refuses redirects, so a token can't follow one anywhere. It also refuses to send a token to an https hub if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. If a certificate fails, fix the certificate.

## Developer-only switches

`--insecure-dev-mode` allows plain http to public addresses (on `coop join`), and turns coop's guards off and allows `bypassPermissions` (on `coop start`). It prints a warning, and it's for throwaway VMs and local testing. No hub or task can set it directly, and the guard refuses commands that use it, as far as a pattern can tell.

## What the hub stores

Task titles and details, messages, progress notes, permission prompts (tool name, description, a preview of the command, and the folder relative to the home directory), who's in the crew, and the audit log. It never sees code, files or anyone's Claude conversation, and it makes no outbound requests. Known secret patterns are taken out of text on the way in, on a best-effort basis. There's no telemetry.

Old events, audit entries, permission requests and finished tasks are deleted after 90 days by default: see the [configuration reference](configuration.md).

## Seeing what happened

`coop audit` shows the security log: sign-ins after being away, failed sign-ins, tokens, members, roles, task claims, assignments, hand-ins and reviews, permission requests and answers, refused input, replays, and alerts. It leaves out messages (they're in the crew's history), requests that expire unanswered (`coop permissions --status expired`), answers given on a worker's PC, and what the guard blocks there (`coop audit --local` on that PC). `coop audit --alerts` shows only alerts. Alerts also reach the lead's Claude and appear in `coop status`:

| Alert | When |
| --- | --- |
| Repeated failed sign-ins | 10 unknown tokens from one source in 10 minutes |
| Revoked or expired token still in use | 3 times in 10 minutes |
| Someone keeps trying things their role doesn't allow | 10 times in 10 minutes |
| Malformed or refused input | 30 times in 10 minutes |
| Requests replayed | 3 times in 10 minutes |
| Rate limits hit | 3 times in 10 minutes |
| Wrong approval passphrase | 3 times in 15 minutes |
| Something looked like a secret | Once an hour per member |
| Approval passphrase set or changed | Every time |

These are simple counts in fixed windows, and each fires once per window. There's no email or push, so they reach you when a session is open or you look.

On a worker's PC, `coop audit --local` shows what coop's guard has blocked there. That log stays on that PC, and holds the reason rather than the command. The lead isn't told.

## Recommended setup

**Hub:** on Cloudflare, or self-hosted on 127.0.0.1 behind Tailscale or an https proxy.

**Lead's PC:** run `coop approvals setup` right after `coop join`. Keep merges for a person.

**Worker's PC:** a separate clone, `coop start` with the default `auto` mode, or `acceptEdits`. For anything you don't fully trust, a VM or a dedicated user account. On macOS, Linux or WSL2, add `--sandbox`. Keep your own credentials out of that account if you can.

**Git:** protect the default branch on your host, and require a pull request and a review: `coop doctor` checks this where it can. Workers get push access to branches only. Use a token limited to that repository if your host supports it.

**Claude Code:** version 2.1.295 or newer, so that a guard that fails blocks the tool call. Never `bypassPermissions` outside a throwaway VM.

## Reporting a vulnerability

Please open a [GitHub security advisory](https://github.com/Plyxen/claude-code-multi-pc/security/advisories/new) rather than a public issue.
