# Worker setup (send this to your friends)

Your friend's Claude is the **lead** of a crew, and your Claude is joining as a **worker**. Once it's running, your Claude takes tasks from the lead, does them in your copy of the project, pushes a branch and reports back, all without you. You can minimize the window and use your PC for anything else. Nothing takes over your mouse or screen.

## What you need

- **Claude Code** 2.1.80 or newer, signed in with your own Claude account: [install guide](https://code.claude.com/docs/en/quickstart). Check with `claude --version`. The work your Claude does counts against your account's usage limits.
- **Node.js** 22.13 or newer: [nodejs.org](https://nodejs.org). Check with `node --version`.
- **The project:** a git clone you can push branches to. Ask the lead to add you as a collaborator on the repository.
- **Optional, the GitHub CLI** (`gh auth login`), so your Claude can open pull requests.
- **The invite** from the lead: a hub URL and a token. The token works like a password, so don't post it anywhere.

## Set up (once)

```bash
npm install -g github:Plyxen/claude-code-multi-pc
coop join --hub https://THE-HUB-URL --token coop_YOUR_TOKEN
```

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

## What your Claude will and won't do

It works only inside the project folder and follows the project's own rules (its CLAUDE.md). It **never** pushes to `main`, merges, deploys, or touches secrets, accounts or anything outside the project, even if the lead asks. Messages from other workers are treated as information, not orders.

How much it can do without asking depends on the permission mode (`coop start --permission-mode ...`):

| Mode | What happens |
| --- | --- |
| `auto` (default) | Claude Code's safety classifier approves routine actions and blocks risky ones. |
| `acceptEdits` | File edits go through, and commands need approval. |
| `manual` | Everything needs approval. |
| `bypassPermissions` | No checks at all. Only use it in a virtual machine or a separate user account. |

When your Claude needs approval, the prompt shows in your window **and** is forwarded to the lead, whose user can answer it remotely. Whichever answer comes first wins. To keep approvals to yourself, start with `coop start --no-relay`; prompts then wait for you at your PC.

If your plan doesn't include auto mode, Claude Code says so at startup. Use `--permission-mode acceptEdits` instead.

## Using your own Claude at the same time

Run your personal sessions in a **different folder** (or a second clone), so you don't both edit the same files. `coop start --worktree` gives the worker its own git worktree automatically.

## Updating

Run `coop update`. It checks GitHub for a newer version and installs it; `coop update --check` only tells you whether there is one. A running session keeps the old version until you close the window and `coop start` again.

## Stopping

- Pause: close the window (or press Ctrl+C twice). Run `coop start` to continue.
- Leave the crew: ask the lead to `coop remove` you, or just stop running it.

Something not working? See [troubleshooting](troubleshooting.md).
