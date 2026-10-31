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
coop join --hub <hub url> --token <lead token>
coop invite anna
coop invite bob
```

`coop invite` prints a short message with the install line, the hub URL and the person's token. Send it privately: anyone with a token can act as that worker. To replace a leaked token, run `coop invite anna` again, which stops the old one working. `coop remove anna` takes someone out of the crew, and their unfinished tasks go back to the pool.

Each worker also needs push access to the repository (add them as collaborators), and the project should have a co-op section in its CLAUDE.md: see [project-setup.md](project-setup.md).

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

## Permission prompts from workers

If a worker's Claude Code needs approval for something, the prompt reaches you (unless the worker turned relay off). Your Claude shows you the worker, the tool and the exact command, and answers only with your decision. If you're not sure, say no. The worker's owner can always answer it at their own PC.

## Good habits

- Start small: one worker, one easy task, and watch the first run.
- Workers' sessions keep running. Ask them to restart (`coop start`) if they've been going for a day or more.
- Each worker's Claude uses that person's own Claude usage limits. Be fair with how much you hand out.
