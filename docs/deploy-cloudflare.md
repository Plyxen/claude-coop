# Deploy the hub to Cloudflare

A Cloudflare Worker with a D1 database gives your crew an always-on hub at a fixed `https://` address. The free plan is plenty: a crew of five, all running all day, makes about 40,000 requests a day, well under the free 100,000. Keeping track of who's online writes about 16,000 rows a day for those five, and the actual work adds a little on top, also well under the free 100,000.

You need a Cloudflare account and a clone of this repository:

```bash
git clone https://github.com/Plyxen/claude-code-multi-pc
cd claude-code-multi-pc
npm install
```

## 1. Sign in and create the database

```bash
npx wrangler@4 login
npx wrangler@4 d1 create coop-hub
```

The second command prints a `database_id`.

## 2. Configure

```bash
cp wrangler.example.toml wrangler.toml
```

In `wrangler.toml`, paste the `database_id` and set your names:

```toml
[vars]
COOP_LEAD_NAME = "yourname"     # your crew name as the lead
COOP_HUB_NAME = "my-crew"       # the crew's name, shown on the board
COOP_TOKEN_TTL_DAYS = "90"      # how long new tokens last, 0 for no expiry
COOP_RETENTION_DAYS = "90"      # how long the hub keeps history, 0 for always
```

`wrangler.toml` is in `.gitignore`, so your IDs stay out of the repository.

## 3. Set the lead token

```bash
coop token                                   # prints a new random token; copy it
npx wrangler@4 secret put COOP_LEAD_TOKEN    # paste it when asked
```

Keep the token somewhere safe, like a password manager: it's the key to your crew. It has to be at least 24 characters, and the hub refuses to run without it.

## 4. Deploy and join

```bash
npx wrangler@4 deploy
```

Wrangler prints the URL, such as `https://coop-hub.<your-subdomain>.workers.dev`. The database tables are created on the first request.

```bash
coop join --hub https://coop-hub.<your-subdomain>.workers.dev    # asks for the lead token
coop approvals setup                                             # do this before anything else
coop invite <friend>
```

## Updating

`git pull`, then `npx wrangler@4 deploy` again. Your data stays in D1, and the hub upgrades its own tables on the next request.

**Update the hub first, then the clients.** New clients use routes an old hub doesn't have, while old clients' routine calls keep working on a new hub. See the [changelog](../CHANGELOG.md) for what each version needs.

## Changing the lead token

Run `npx wrangler@4 secret put COOP_LEAD_TOKEN` with a new token, then `coop join` again with it. Workers' tokens don't change.

## Flooding

The hub limits what it writes during a flood, but it can't protect your free-tier quota from a crew member working just under its limits, or from an attacker with many addresses. If the write quota runs out, reads keep working, and changes fail until it resets. To cut a flood off before it reaches the hub, add a [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on your Worker's route, if your plan has one, and revoke any token that's behind it.

## What Cloudflare can see

Everything the hub stores and everything sent through it is available to Cloudflare, and to anyone with access to your Cloudflare account. The lead token is a Worker secret, which the Worker can read while it runs. The database holds only a hash of it. Protect that account: someone with access to it can pose as you to your whole crew ([threat model](threat-model.md#a-compromised-hub-or-its-host)).
