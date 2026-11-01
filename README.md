# claude-code-multi-pc

**Run Claude Code across multiple PCs and multiple Claude accounts, as one team.**

You and your friends each have Claude Code on your own computer, signed in to your own account. With this, your Claude becomes the **lead** and theirs become the **crew**. Your Claude hands out tasks, their Claudes do them on their own PCs and open pull requests, and every Claude sees what the others are doing. Your friends don't have to babysit anything. They start it once, minimize the window, and get on with their day.

```
        YOUR PC                                                FRIENDS' PCs
 ┌────────────────────┐        ┌───────────────────┐       ┌────────────────────┐
 │  Claude Code       │        │       hub         │       │  Claude Code       │
 │  (lead)            │◄──────►│  task board,      │◄─────►│  (worker: anna)    │
 │  assigns, reviews, │        │  crew, messages   │       │  claims, codes,    │
 │  answers questions │        │  Cloudflare Worker│       │  pushes, submits   │
 └────────────────────┘        │  or your own PC   │       └────────────────────┘
                               └───────────────────┘       ┌────────────────────┐
              code moves through git: one branch           │  (worker: bob) ... │
              and pull request per task                    └────────────────────┘
```

**What it isn't:** an account switcher (one person, many accounts), a multi-agent framework on one machine, or remote desktop. Each Claude stays on its own PC, under its own person's account and usage, and they cooperate on one git repository.

> A community project, not made or endorsed by Anthropic.

## Why use it

- **Two to nine PCs, one team.** One lead and up to 8 workers. It's built for a group of 2 to 5 friends.
- **Hands-free workers.** New tasks are pushed straight into the worker's running Claude Code session through [channels](https://code.claude.com/docs/en/channels), so it starts on its own. Nobody types anything on the worker's PC, and nothing takes over the screen or the mouse.
- **Everyone knows what's going on.** The lead hears every claim, progress note, question and submission as it happens. Workers hear about their tasks, open tasks they could take, and merged work they should pull. `coop status` shows the whole board.
- **Git does the code.** Each task gets its own branch (`coop/12-add-csv-export`). The worker pushes it and opens a pull request, and the lead reviews it before anything is merged.
- **Each friend keeps control of their PC.** Each one picks their Claude's permission mode. Workers are told to stay in the project folder and away from `main`, deploys and secrets, and `coop start` adds checks that run whatever Claude decides. A Claude can't approve a permission prompt by itself: that takes a person. These limit mistakes and common attacks, and they aren't a sandbox: [here's exactly what's enforced](docs/security-guarantees.md).
- **Free to run.** The hub fits in Cloudflare's free tier, or runs on your own PC. Each Claude uses its own person's plan.

## How a task flows

1. You tell your Claude what you want: *"Split the export feature into tasks for anna and bob."* It creates the tasks with `coop_assign`, for a named worker or open for whoever is free.
2. The task appears in the worker's session. Their Claude claims it, branches off the latest `main`, does the work, runs the checks, pushes and opens a pull request.
3. Their Claude hands it in with `coop_submit`. Yours is told, reads the diff and runs the tests, then approves it or sends it back with feedback. Merging stays your call.
4. Questions go both ways with `coop_send`. A stuck worker marks the task blocked, and your Claude (or you) answers.

## Requirements

- [Claude Code](https://code.claude.com/docs/en/quickstart) 2.1.80 or newer on every PC, each signed in to its own claude.ai account (Pro or Max) or a Console API key. Use 2.1.295 or newer if you can: on older versions, coop's safety check lets a tool call through if the check itself can't run. On Team and Enterprise plans an admin has to [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).
- [Node.js](https://nodejs.org) 22.13 or newer.
- A git repository everyone can push branches to (GitHub, GitLab or anything else), plus the [GitHub CLI](https://cli.github.com) for pull requests.
- A hub everyone can reach: a free Cloudflare Worker (recommended), or the lead's own PC.

## Quick start

### You (the lead)

```bash
npm install -g github:Plyxen/claude-code-multi-pc
```

Set up a hub. For friends on other networks, deploy it to Cloudflare ([about 5 minutes, free](docs/deploy-cloudflare.md)). To try it on your own PC first:

```bash
coop hub --lead-name yourname --crew my-crew
```

The hub prints your lead token and the `coop join` line to run next. Then:

```bash
coop join --hub <hub url>   # asks for the lead token
coop approvals setup    # choose a passphrase, so that only you, not your Claude, can approve things
coop invite anna        # prints the steps to send anna; the token is a password, so DM it
cd path/to/your/project
coop start              # your Claude, now the lead of the crew
```

Then talk to your Claude as usual, plus things like *"Give the open docs fixes to whoever is free"* or *"What's everyone doing?"*. The [lead guide](docs/lead-guide.md) has more.

### Each friend

Send them what `coop invite` printed, or [the worker setup page](docs/worker-setup.md). It comes down to:

```bash
npm install -g github:Plyxen/claude-code-multi-pc
coop join --hub <hub url> --token <their token>
cd path/to/their/clone/of/the/project
coop doctor             # checks Node, Claude Code, the hub, git and gh
coop start
```

On the first start Claude Code asks them to trust the folder. It also warns about development channels (on every start, in some versions), because channels are a research preview and this project isn't on Anthropic's allowlist: they choose **I am using this for local development**. Then they minimize the window and leave it running.

## Day to day

| Command | What it does |
| --- | --- |
| `coop start` | Starts Claude Code in this folder, connected to the crew. It reopens your last coop session here, so your session list doesn't fill up with copies. |
| `coop start --new` | Starts a fresh session instead. |
| `coop status` | The crew board: who's online, who's on what, what waits for review. |
| `coop update` | Installs the latest version. Your next `coop start` is a new session, so the new instructions take effect. |
| `coop doctor` | Checks this PC's setup. |
| `coop invite NAME` · `coop remove NAME` | Lead only: add a friend, or remove one (their unfinished tasks go back to the pool). |
| `coop permissions` · `coop approve WORKER ID` · `coop deny WORKER ID` | Lead only: answer a worker's permission prompts. Approving asks for your passphrase, in your own terminal. |
| `coop audit` | Lead only: the hub's security log. `coop audit --local` shows what coop's checks blocked on this PC. |
| `coop tokens` · `coop tokens rotate` | List tokens, or renew yours. New tokens last 90 days. |

`coop help` lists everything. If someone's PC is off, their tasks wait on the hub until they `coop start` again.

## What each Claude gets

| Lead tools | Worker tools | Both |
| --- | --- | --- |
| `coop_assign`: create a task | `coop_claim`: take a task | `coop_status`: the board |
| `coop_review`: approve or send back | `coop_progress`: note a milestone, or blocked | `coop_task`: one task in full |
| `coop_manage_task`: reassign, cancel, reopen, comment | `coop_submit`: hand in for review | `coop_send`: message someone or everyone |
| `coop_remove`: take someone out of the crew | `coop_release`: give a task back | `coop_inbox`: updates, for sessions without channels |
| `coop_permission`: refuse a worker's permission prompt (approving takes a person: `coop approve`) | | |

## Questions

**Does it take over my friend's PC?**
No. It's their own Claude Code in a normal terminal window, working in the project folder with the permissions they chose. Nobody sees their screen or moves their mouse. They can use the PC for anything else, including their own Claude in another folder.

**Whose usage does a task use?**
The worker's. Each Claude runs on its own person's plan or API key. The lead uses some of its own when it hands out work and reviews.

**Do we need to be on the same network?**
No. With the hub on Cloudflare, every PC only needs the internet. A hub on your own PC works on your network, or anywhere through a tunnel or [Tailscale](docs/self-hosting.md).

**Can a worker's Claude do something harmful because the lead said so?**
Yes, it can. Workers follow the lead's instructions, so only join crews whose lead you'd trust with your PC's Claude. The limits are the worker's own permission mode and coop's checks, which catch common cases but aren't a sandbox. For a hard limit, run the worker in a VM or a separate user account, or with `coop start --sandbox` on macOS, Linux or WSL2. [Security](docs/security.md) spells it out.

**Is it secure?**
It's a young project that was hardened on purpose, and it can't make Claude immune to prompt injection or protect you from a hub or lead you shouldn't have trusted. The rule it's built on is that Claude isn't the security boundary, so what matters is enforced by the hub, Claude Code's hooks, git, your git host, the OS or a person. [Security guarantees](docs/security-guarantees.md) lists what's enforced, what's only partly enforced and what isn't, and the [threat model](docs/threat-model.md) explains why.

## Docs

- [How it works](docs/how-it-works.md): hub, channels, events, task states, reliability
- [Lead guide](docs/lead-guide.md): running a crew, writing good tasks, reviewing
- [Worker setup](docs/worker-setup.md): the page to send your friends
- [Project setup](docs/project-setup.md): the CLAUDE.md section and git workflow that make co-op smooth
- [Deploy the hub to Cloudflare](docs/deploy-cloudflare.md) · [Self-host the hub](docs/self-hosting.md)
- [Security](docs/security.md): the practical guide: what a worker can be asked to do, approvals, tokens, recommended setup
- [Security guarantees](docs/security-guarantees.md) · [Threat model](docs/threat-model.md): what's enforced and what isn't, and why
- [Configuration reference](docs/configuration.md) · [Troubleshooting](docs/troubleshooting.md) · [Hub API](docs/api.md) · [Changelog](CHANGELOG.md)

## Status

Version 0.2: young, but tested end to end. `npm test` drives a real hub, the CLI and an MCP server per crew member, and an earlier version has run live between two PCs on two Claude accounts. Channels are a Claude Code research preview, so launch flags may change as Anthropic updates them. Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, please open a [security advisory](https://github.com/Plyxen/claude-code-multi-pc/security/advisories/new).

## License

[MIT](LICENSE)
