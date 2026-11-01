# Troubleshooting

Start with `coop doctor` in the project folder. It checks Node, Claude Code, your crew profile, your token's expiry, the hub, git, gh and coop's checks. `✗` needs fixing, and `!` is worth knowing.

## The worker doesn't react to new tasks

- **Was it started with `coop start`?** Plain `claude` doesn't load the channel.
- **Did you see the channels notice at startup?** A line like `Channels (experimental) messages from server:coop inject directly in this session` should appear under the banner. If there's a warning instead:
  - *blocked by org policy*: on a Team or Enterprise plan, an admin must [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).
  - Channels need Claude Code 2.1.80+ and a claude.ai or Console login (not Bedrock, Vertex or Foundry). Update with `claude update`.
- **Is the window still open?** Closing it stops the worker. Tasks wait on the hub until it's back.
- **Is the PC asleep?**
- **Did the session say it stopped?** A session stops when the hub no longer accepts its token: see below.
- In the session, `/mcp` should show `coop` as connected. If it failed, run `coop mcp` in a terminal to see the error (it should sit and wait; Ctrl+C to stop).
- Pushes are best effort. A worker also gets a reminder about waiting work every 5 minutes. As a fallback, type in the worker session: *check coop_status and take any task assigned to you*.

If channels can't work on your setup at all, a worker can still poll: start Claude in the project folder and tell it *use coop_inbox with wait_seconds 600 in a loop and do the tasks that arrive*.

## The channel doesn't register on newer Claude Code

Claude Code's v2 MCP runtime doesn't register channel servers that negotiate MCP protocol revision 2026-07-28. claude-code-multi-pc uses MCP SDK 1.x, which doesn't, so it registers normally. If you still see it fail, set `MCP_PROTOCOL_NEGOTIATION=legacy` before `coop start` and [open an issue](https://github.com/Plyxen/claude-code-multi-pc/issues).

## "Claude Code (the `claude` command) was not found"

Install Claude Code ([quickstart](https://code.claude.com/docs/en/quickstart)) or point `CLAUDE_BIN` at it, or pass `coop start --claude <path>`.

## "can't reach the hub"

- Open `<hub url>/health` in a browser: it should show `{"ok":true,"service":"claude-code-multi-pc"}`.
- A self-hosted hub only answers while `coop hub` runs, and only on your own PC unless you opened it up ([self-hosting.md](self-hosting.md)).
- A quick Cloudflare Tunnel URL changes when the tunnel restarts. Everyone has to `coop join` again with the new URL.
- coop refuses redirects, so a hub address that redirects, such as `http://` to `https://`, looks unreachable. Use the final `https://` address.

## Certificate errors, and "NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks"

coop won't send a token over https with certificate checks turned off. Unset that variable. If your network uses its own certificate authority, point `NODE_EXTRA_CA_CERTS` at its certificate. If the hub's certificate is really wrong, fix it on the hub.

## "unknown or revoked token"

The lead re-invited or removed you, you rotated your token on another PC, or the hub was reset. Ask for a new invite and run `coop join` again.

If you just ran `coop tokens rotate`, the old token stopped at once: close any open coop session and `coop start` again.

## "this token has expired"

Tokens last 90 days by default. Ask the lead to run `coop invite <your name>` again, then `coop join`. Next time, `coop tokens rotate` before it runs out: `coop doctor` shows how long is left.

## "too many requests" or "too many failed sign-ins"

Hub limits, and they clear by themselves: the message says when. `coop status` and your Claude's tools work again after that. If it keeps happening with normal use, something's looping, so see who's behind it with `coop audit`.

Too many failed sign-ins from an address also answers a refused token with this message rather than "unknown or revoked token". It's still refused. A valid token isn't affected, even from the same address.

## "this request is too old, or this PC's clock is off by more than 5 minutes"

Sensitive requests carry the time, so that an old one can't be sent again. Set your PC's clock to update automatically.

## "this request needs x-coop-request-id", or "this request was already processed"

The first means your coop is older than the hub: run `coop update`. The second means the hub already ran this exact request, usually because the answer got lost on the way back. Check with `coop status` or `coop tokens` before doing it again. For an invite whose answer got lost, run `coop invite` again: that makes a new token.

## "This hub may be older than this coop"

The hub doesn't have that command yet. Update the hub first ([Cloudflare](deploy-cloudflare.md#updating)), or run `coop update` on the PC that runs `coop hub`.

## Approvals

| What you see | What to do |
| --- | --- |
| *first has to set an approval passphrase* | Run `coop approvals setup` in a terminal. Until then requests can only be refused. |
| *needs a person at a terminal* | Approving and setting a passphrase can't run from a Claude's shell or a script. Open your own terminal. |
| *wrong approval passphrase* | Five wrong tries lock approvals for up to 15 minutes. Refusing still works. |
| *has expired* | Requests last 10 minutes. The worker's own prompt is still open on their PC, and they can ask again. |
| *was already answered* | Someone answered it first, and an answer only works once. |
| You forgot the passphrase | Whoever runs the hub can clear it: see [security.md](security.md#approving-permission-requests). |

## "coop guard blocked this"

A worker's Claude tried something coop's check doesn't allow, and Claude sees the reason. Usually it's right to: it should find another way, or ask the lead. If it's blocking real work, such as a file the project keeps outside its folder, do that part yourself, or start the session from a higher folder. `coop audit --local` shows what's been blocked on this PC.

Every tool call blocked, with *could not check this*? Something's wrong with the coop install: run `coop doctor`, and `coop update` if needed.

## "coop guard stopped this push"

The pre-push hook refused a protected branch, a tag, or a commit that adds something that looks like a secret. Push a task branch and open a pull request. For a secret, take it out of the commits, and change the secret if it might have been seen. If it's a false alarm and you're a person who's checked, `git push --no-verify` skips the hook. The guard stops a Claude from doing that.

## "Refusing ..." on `coop start`, `coop join` or `coop hub`

| Message | Why, and what to do |
| --- | --- |
| *Refusing permission mode bypassPermissions* | It removes every check, while tasks come from someone else. Pick another mode. `--insecure-dev-mode` overrides it, for throwaway virtual machines only. |
| *Refusing plain http* | Your token would cross the internet unencrypted. Use https or a private network like Tailscale. |
| *Refusing to listen on 0.0.0.0* | This server speaks plain http. Use your Tailscale address, or stay on 127.0.0.1 behind an https tunnel or proxy. With a firewall in front, add `--public-bind`. See [self-hosting.md](self-hosting.md). |
| *Claude Code's sandbox isn't available on native Windows* | `--sandbox` would silently do nothing there, so coop refuses. Use WSL2, a virtual machine, or a separate user account. |

## The worker keeps asking for permission

Pick a mode that fits (`coop start --permission-mode auto` or `acceptEdits`). Prompts are forwarded to the lead unless you used `--no-relay`. If your plan doesn't have auto mode, Claude Code says so at startup: use `acceptEdits`.

## Two workers edited the same files

Give each task a `scope`, keep overlapping work with one worker, and keep tasks small. See [project-setup.md](project-setup.md).

## Start fresh

`coop profiles` lists your crews. Your settings are in `~/.claude-coop/`: `config.json` holds the profiles and tokens, and `state/` the event cursors. Deleting a file in `state/` just makes that session start from "now". The [configuration reference](configuration.md) lists the rest.
