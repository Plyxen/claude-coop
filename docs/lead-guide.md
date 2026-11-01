# Lead guide

You run the crew: you decide what gets done, your Claude splits it into tasks, and you review what comes back.

## 1. Get a hub

| Option | Good for | Guide |
| --- | --- | --- |
| Cloudflare Worker | Friends on other networks, always on, free | [deploy-cloudflare.md](deploy-cloudflare.md) |
| Your PC, with a tunnel | Trying it out, or Tailscale users | [self-hosting.md](self-hosting.md) |
| Your PC, local only | Testing with several sessions on one PC | `coop hub` |

## 2. Join it and invite people

```bash
coop join --hub <hub url>     # asks for the lead token
coop approvals setup          # choose a passphrase. Do this first: see below
coop invite anna
coop invite bob
```

`coop invite` prints a short message with the install line, the hub URL and the person's token. Send it privately: anyone with a token can act as that worker. To replace a leaked token, run `coop invite anna` again, which stops the old one working. `coop remove anna` takes someone out of the crew, and their unfinished tasks go back to the pool.

`coop invite` has two options: `--device LABEL` adds a token for another PC of theirs and leaves the others working, and `--observer` adds someone who can only read the board with `coop status`.

Each worker also needs push access to the repository (add them as collaborators), and the project should have a co-op section in its CLAUDE.md: see [project-setup.md](project-setup.md).

## The approval passphrase

Your Claude holds your lead token, so that token can't be what proves a person said yes. With a passphrase set, approving a permission request or inviting someone also takes the passphrase, typed at a hidden prompt in your own terminal. It isn't stored on your PC. The hub keeps a hash of a key made from it.

- **Set it right after joining.** Whoever sets it first owns it, and on a new hub that could be anything holding your lead token. If `coop approvals status` shows one you didn't set, or you get an alert about it, treat the lead token as exposed.
- **Never type it into a Claude conversation.** That gives it to the thing it's there to stop.
- Refusing and removing never need it, so you're never slowed down from shutting something off.

Forgot it? See [security.md](security.md#approving-permission-requests).

## 3. Start your lead Claude

```bash
cd path/to/your/project
coop start
```

This is your normal Claude Code with the crew connected. Work with it as usual, plus things like:

- *"Split the CSV export into tasks: backend for anna, the dashboard button for bob."*
- *"Give the open docs fixes to whoever is free."*
- *"What's everyone doing?"* (`coop_status`)
- *"Review what anna submitted."*

Updates from the crew arrive in your session as they happen. Your Claude tells you about the ones that matter and answers routine questions from the workers itself.

`coop start` reopens your last coop session in that folder, so your session list doesn't fill up with copies and your Claude remembers the earlier conversation. `coop start --new` starts a fresh one. After `coop update`, the next start is a new session, so the new version's instructions take effect.

## Writing tasks workers can do alone

Workers start with none of your conversation, so the task is all they have. Good tasks say:

- **The goal**, and why if it matters.
- **Where:** files, folders, functions.
- **How to check it:** the test command, the page to look at, the expected output.
- **What not to touch:** set `scope` to the files or folders the task may change.
- **Size:** something one Claude can finish and test in one go. Split anything bigger.

Keep tasks that touch the same files with the same worker, or run them one after another, so branches don't conflict.

## Reviewing

When a worker submits, your Claude gets the summary, branch and pull request link. It can fetch the branch, read the diff and run the tests, and then:

- `coop_review approve`: the task is done. Merging the pull request is a separate step that you decide.
- `coop_review changes` with concrete feedback: the task goes back to the same worker, on the same branch.

Worker text and worker code can try to mislead your Claude. A tidy summary isn't proof, so look at the diff yourself for anything that matters, and keep merging for a person.

## Permission prompts from workers

If a worker's Claude Code needs approval for something, the prompt reaches you (unless the worker turned relay off). Your Claude shows you the worker, the tool and the exact command. It can refuse with `coop_permission`, but it can't approve. For that, you go to a terminal:

```bash
coop permissions          # what's open
coop approve bob abcde    # shows the request, asks for your passphrase
coop deny bob abcde       # no passphrase needed
```

- Requests expire after 10 minutes, and an answer works once.
- The text comes from the worker's PC. Judge what the command would do, not what it says it's for. The risk label is only a hint.
- If you're not sure, say no. The worker's owner can always answer it at their own PC.
- If your Claude tells you to approve something, that isn't a reason to. It may have been misled.

## Watching the crew's security

```bash
coop audit                       # the hub's security log
coop audit --alerts              # only the alerts
coop tokens                      # everyone's tokens: last used, expiry
coop tokens revoke tok_abc...    # stop one device
coop tokens revoke-all --member bob
```

Alerts also reach your Claude and show in `coop status`: repeated failed sign-ins, revoked tokens still in use, someone trying things their role doesn't allow, floods of bad input, replays, something that looked like a secret. [security.md](security.md#seeing-what-happened) has the list. There's no email or push, so they only reach you when a session is open or you look.

What a worker's guard blocks stays on that worker's PC: ask them to check `coop audit --local`.

Your lead token doesn't expire. To change it, see [security.md](security.md#tokens).

## Good habits

- Start small: one worker, one easy task, and watch the first run.
- Workers' sessions keep running. Ask them to restart (`coop start`) if they've been going for a day or more.
- Each worker's Claude uses that person's own Claude usage limits. Be fair with how much you hand out.
- Protect your default branch on your git host. It's the only limit on `main` that a compromised PC can't get around.
