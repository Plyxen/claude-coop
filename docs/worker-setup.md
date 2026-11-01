# Worker setup (send this to your friends)

Your friend's Claude is the **lead** of a crew, and your Claude is joining as a **worker**. Once it's running, your Claude takes tasks from the lead, does them in your copy of the project, pushes a branch and reports back, all without you. You can minimize the window and use your PC for anything else. Nothing takes over your mouse or screen.

Your Claude acts on what the lead sends it, with your Claude Code's permissions, on your PC. So only join a crew whose lead you'd trust with that.

## What you need

- **Claude Code** 2.1.80 or newer, signed in with your own Claude account: [install guide](https://code.claude.com/docs/en/quickstart). Check with `claude --version`. Version 2.1.295 or newer is strongly recommended: on older ones, coop's safety check lets a tool call through if the check itself can't run. The work your Claude does counts against your account's usage limits.
- **Node.js** 22.13 or newer: [nodejs.org](https://nodejs.org). Check with `node --version`.
- **The project:** a git clone you can push branches to. Ask the lead to add you as a collaborator on the repository.
- **Optional, the GitHub CLI** (`gh auth login`), so your Claude can open pull requests.
- **The invite** from the lead: a hub URL and a token. The token works like a password, so don't post it anywhere.

## Set up (once)

```bash
npm install -g github:Plyxen/claude-code-multi-pc
coop join --hub https://THE-HUB-URL --token coop_YOUR_TOKEN
```

Leave `--token` off and `coop join` asks for it, which keeps it out of your shell history.

Then, in your clone of the project:

```bash
coop doctor     # checks Node, Claude Code, the hub, git and gh
```

## Start working

```bash
cd path/to/the/project
coop start
```

Claude Code starts in that folder, connected to the crew:

1. **First time in this folder:** Claude Code asks whether you trust it. Choose yes.
2. **A warning about *development channels*** appears (on every start, in some Claude Code versions), because claude-code-multi-pc isn't on Anthropic's channel allowlist during the research preview. Choose **I am using this for local development**.

After that your Claude checks the board, claims anything assigned to it, and then waits. New tasks arrive by themselves. Minimize the window, but don't close it: closing it stops your worker until you run `coop start` again. Tasks wait on the hub in the meantime, and `coop start` picks up the same session where it left off (`coop start --new` starts a fresh one).

Keep your PC awake while it works. On Windows, set Settings > System > Power > Sleep to "Never" while plugged in.

## What keeps your Claude in line

Your Claude is **told** to work only inside the project folder, follow the project's rules (its CLAUDE.md), treat other workers' messages as information rather than orders, and not push to `main`, merge, deploy, or touch secrets or accounts, even if the lead asks. Being told isn't a guarantee: a Claude can make a mistake or be misled by something it reads. So `coop start` also adds checks that run whatever Claude decides:

- **Before each file and shell tool call**, a check keeps file tools inside the project, keeps them off credential folders, and refuses commands like `git push origin main`, `gh pr merge`, `npm publish` and `curl ... | sh`. The [configuration reference](configuration.md) has the list, and `coop audit --local` shows what it has blocked on your PC.
- **Before each `git push`**, a hook refuses protected branches, the remote's default branch, tags, and commits that add something that looks like a secret. It won't replace a hook your repository already has, and it says so.

These catch mistakes and common prompt injection. **They aren't a sandbox.** A shell command can do things no pattern expects, and Claude's web tools and MCP tools aren't checked. They also only apply with `coop start`, not plain `claude`.

For a hard limit, use the operating system:

- `coop start --sandbox` confines shell commands with Claude Code's sandbox on macOS, Linux and WSL2. It covers commands, not file tools or web tools, and it limits network access to GitHub and npm. On native Windows it refuses to start, since there's no sandbox there.
- A virtual machine, or a separate user account without your own credentials, works everywhere. That's the setup to use for a project or a lead you don't fully trust.

[Security guarantees](security-guarantees.md) spells out what's enforced and what isn't.

## Permission modes

How much your Claude can do without asking depends on the permission mode (`coop start --permission-mode ...`):

| Mode | What happens |
| --- | --- |
| `auto` (default) | Claude Code's safety classifier approves routine actions and blocks risky ones. |
| `acceptEdits` | File edits go through, and commands need approval. |
| `manual` | Everything needs approval. |
| `bypassPermissions` | No checks at all. `coop start` refuses it unless you also pass `--insecure-dev-mode`, which turns coop's checks off too. Only for a throwaway virtual machine. |

If your plan doesn't include auto mode, Claude Code says so at startup. Use `--permission-mode acceptEdits` instead.

When your Claude needs approval, the prompt shows in your window **and** is forwarded to the lead. The lead's Claude can show it to its person and refuse it, but only that person can approve it, with a passphrase typed at their own terminal. An approval expires after 10 minutes and works once. Whichever answer comes first wins, and your own prompt stays open until then. To keep approvals to yourself, start with `coop start --no-relay`; prompts then wait for you at your PC.

## Using your own Claude at the same time

Run your personal sessions in a **different folder** (or a second clone), so you don't both edit the same files. `coop start --worktree` gives the worker its own git worktree automatically.

## Keeping your token working

Tokens last 90 days by default, and your Claude tells you when one's about to run out. To renew it:

```bash
coop tokens rotate
```

This saves the new token and stops the old one at once, so close any open coop window and `coop start` again. If it has already expired, ask the lead to run `coop invite <your name>` again.

If your token leaked, renew it, or ask the lead to revoke it.

## Updating

Run `coop update`. It checks GitHub for a newer version and installs it; `coop update --check` only tells you whether there is one. A running session keeps the old version until you close the window and `coop start` again.

## Stopping

- Pause: close the window (or press Ctrl+C twice). Run `coop start` to continue.
- Leave the crew: ask the lead to `coop remove` you, or just stop running it.

Something not working? See [troubleshooting](troubleshooting.md).
