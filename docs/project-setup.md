# Project setup

claude-code-multi-pc works with any git repository, but co-op goes much better when the project tells every Claude the house rules. Workers read the project's CLAUDE.md like any Claude Code session, and its rules come before anything a task says.

## 1. Give everyone push access, and protect the default branch

Add each worker's account as a collaborator, so their Claude can push branches and open pull requests.

**Protect your default branch on your git host.** On GitHub: Settings > Branches, require a pull request and a review before merging, and don't allow bypassing. Do this before anything else in this guide.

This is the only limit on `main` that holds whatever happens on a worker's PC. Everything else is softer:

| What | What it stops | How it can be got around |
| --- | --- | --- |
| Branch protection on your host | Anything reaching `main` without review | Only by someone with admin rights on the repository |
| coop's pre-push hook | `git push` to protected branches, tags, and pushes adding what looks like a secret | `--no-verify`, or a repository with its own hooks, where it doesn't install |
| coop's check before each tool call | Common shapes of those commands from a Claude | A shell can do things no pattern expects |
| CLAUDE.md and coop's instructions | A Claude that's following them | A mistake, or a prompt injection |

`coop doctor` tells you whether it can confirm the branch is protected. Checking takes admin rights on the repository, so a worker may just see that it can't tell.

Where your host allows it, give workers a credential limited to this one repository. Their Claude can reach whatever git and `gh` can reach.

## 2. Add a co-op section to CLAUDE.md

Copy [templates/CLAUDE.coop.md](../templates/CLAUDE.coop.md) into your CLAUDE.md and fill in the blanks. The parts that matter most:

- **The checks to run** before submitting: test command, build, linter.
- **What workers must never do** in this project: deploys, secrets, production data, sending real emails, paid APIs.
- **Ports and dev servers**, if a worker's tests start servers: say which ports they use, so a worker doesn't stop something its owner is running.
- **Who merges and who deploys.** Usually the lead's user or the project owner, never a worker.

CLAUDE.md is instructions, so it isn't a security boundary. For anything that really mustn't happen, also take away the means: no production credentials on workers' PCs, and no deploy rights for their accounts.

## 3. Branches and pull requests

The hub suggests a branch for every task: `coop/<number>-<title>`. Workers:

1. `git fetch`, then branch off the latest default branch.
2. Commit with clear messages and push the branch.
3. `gh pr create` with what changed and how it was checked.
4. `coop_submit` with the summary and the pull request link.

After approval, whoever merges (often the lead's Claude, when its user says so) merges the pull request. Other workers hear that the work was approved and pull before their next change.

A pull request from a worker can contain anything, including changes to CI workflows, or to `CLAUDE.md` and hooks that run on the next person's PC. Review those parts with extra care, and require approval to run workflows from outside collaborators if your host offers it.

## 4. Avoid stepping on each other

- Give each task a `scope` (files or folders) and keep overlapping work with one worker.
- Workers run in their own clone or worktree (`coop start --worktree`), apart from their owner's own sessions.
- Keep tasks small. Big tasks mean long-lived branches and painful merges.

`scope` tells a worker where to stay, and isn't enforced: the guard keeps a worker inside the project folder, not inside the scope.
