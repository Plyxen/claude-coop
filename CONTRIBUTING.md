# Contributing

Thanks for helping. claude-code-multi-pc is small on purpose: plain JavaScript (ES modules, no build step), Node 22.13+, and two dependencies (the MCP SDK and zod).

```bash
npm install
npm test
npm run lint
npm run typecheck
```

`npm test` runs the hub tests, an end-to-end test that starts a hub, uses the CLI, and drives a lead and two workers through real stdio MCP connections, and the security, reliability and fuzz tests. `npm run test:security` runs only the security and fuzz tests. Fuzz tests are seeded, so each run repeats exactly and a failure shows its input. `COOP_FUZZ_SEED` and `COOP_FUZZ_ROUNDS` pick another sequence or a longer run.

## Layout

| Path | What |
| --- | --- |
| `src/hub/app.js` | The hub API. Web APIs only, so it runs on Cloudflare and Node alike |
| `src/hub/cloudflare.js`, `node.js` | The two entry points; `d1.js` and `sqlite.js` are the storage adapters |
| `src/hub/schema.js`, `risk.js` | Database schema and migrations; the risk label on permission requests |
| `src/mcp/` | The MCP and channel server: tools, push policy, messages, instructions |
| `src/launch.js` | `coop start`: the Claude Code command line |
| `src/guard.js`, `guard-cli.js`, `paths.js` | The checks `coop start` installs: the tool hook and the pre-push hook |
| `src/validate.js`, `secrets.js` | Input cleaning and allowlists; secret patterns |
| `src/approval.js` | The approval passphrase: the key, and the prompt |
| `src/client.js`, `config.js` | The hub client; local profiles and private files |
| `bin/coop.js` | The CLI |
| `docs/` | User docs |

## Guidelines

- Keep the hub free of Node-only APIs, since it has to run on Workers.
- The MCP server must never write to stdout: that's the protocol channel. Log to stderr.
- Anything that changes what Claude is told (`src/mcp/instructions.js`, `messages.js`) changes behaviour on other people's PCs. Explain why in the pull request.
- Add or update a test with every behaviour change.
- Polling mustn't cost database writes per request, or hubs on Cloudflare's free tier run out of quota. A test checks this.
- Update the hub's API in a way old workers can live with, or say in the changelog that it breaks them.

## Security rules

**Claude isn't the security boundary.** Claude can make mistakes or follow a prompt injection, so a rule that matters is enforced by the hub, Claude Code's hooks and permissions, git, the OS or a person. Instructions to Claude can add to that, never replace it.

- Treat everything from a network, a task, a message, a repository or a Claude as hostile. That includes what the lead's Claude sends with the lead's token, and what a hub sends to a client.
- Check roles on the hub, on every request. Hiding a tool or a command is a convenience, not a control.
- Check against allowlists, and fail closed. A guard that can't decide blocks.
- Never log, store or return in an error a token, key, password or request body.
- Never add a way to turn off TLS checks, a way to run `bypassPermissions` that isn't named as insecure, or a way for a hub or a task to run commands or change launch options.
- Never let anything make a Claude able to approve its own permission requests. Allowing and minting credentials need the person; refusing and revoking never do.
- Every security-sensitive change gets a test, including the case that must be refused.
- Update [security guarantees](docs/security-guarantees.md) and the [threat model](docs/threat-model.md) with what changes. Don't claim what the code doesn't enforce.

Please report vulnerabilities through a [GitHub security advisory](https://github.com/Plyxen/claude-code-multi-pc/security/advisories/new) rather than a public issue.
