# Self-host the hub

`coop hub` runs the same hub on your own PC, with Node's built-in SQLite for storage:

```bash
coop hub --lead-name yourname --crew my-crew
```

| Option | Default |
| --- | --- |
| `--port` | `8765` (or `$PORT`) |
| `--host` | `127.0.0.1`: only this PC can connect |
| `--data` | `~/.claude-coop/hub` (the database, a hash of the lead token, and the lead name) |
| `--lead-name` | `lead`, remembered after the first run |
| `--crew` | `coop` |

The [configuration reference](configuration.md) lists the rest.

The first run creates a lead token and prints it **once**. Only a hash of it is saved, so keep it somewhere safe. Lost it? `coop hub --rotate-lead-token` makes a new one, and you run `coop join` again with it. You can also set `COOP_LEAD_TOKEN` yourself.

Upgrading from before 0.2: the plain `lead-token` file is replaced by its hash the first time you start the hub. Your token still works, but it can't be read back from that folder any more.

The hub only runs while that terminal is open, so your friends can only get new tasks while your PC is on. For an always-on hub, use [Cloudflare](deploy-cloudflare.md).

This server speaks plain http. For anything beyond your own PC, something has to protect it on the way: Tailscale, or an https tunnel or proxy.

## Letting friends reach it

By default the hub only listens on your own PC. Pick one way to open it up:

### Tailscale (private, recommended)

Everyone installs [Tailscale](https://tailscale.com) and joins your tailnet (or you share the machine with them). Keep the hub on 127.0.0.1 and let Tailscale give it an https address that's only reachable on your tailnet:

```bash
coop hub
tailscale serve --bg 8765
```

Friends use `https://<your-machine>.<your-tailnet>.ts.net` as the hub URL.

Or have the hub listen on your Tailscale address directly. Tailscale encrypts the traffic, so plain http is fine here:

```bash
coop hub --host 100.x.y.z
```

Friends use `http://<your-tailscale-name>:8765`.

### Cloudflare Tunnel (public https URL)

```bash
cloudflared tunnel --url http://localhost:8765
```

This prints a `https://….trycloudflare.com` URL to use as the hub. A quick tunnel gets a new URL every time it starts, and everyone would have to `coop join` again, so for anything lasting set up a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or deploy the Worker.

### A reverse proxy

Keep the hub on 127.0.0.1, and have your proxy terminate https. Caddy, for example:

```
hub.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

Things to know:

- **Use real certificates.** coop checks them and has no option not to. Redirect http to https at the proxy only for browsers: coop itself refuses to follow redirects, so give people the `https://` address.
- **Limit body size and rate at the proxy too**, if you can. The hub has its own limits, but a proxy stops load sooner. A 64 KB body limit is plenty.
- **Don't expose anything else.** `/health` is the only route that doesn't need a token, and it doesn't say whose hub this is.
- Behind a proxy, the hub sees every client as coming from the proxy, so failed sign-ins all count as one source. Valid tokens get through anyway. It doesn't trust `X-Forwarded-For`, which a client could fake.
- WebSockets aren't involved: the hub is plain JSON over HTTP, polled by clients. There's no WSS to set up.

### A firewall

If the hub has to listen on an address other PCs can reach, allow only the addresses that need it, and only that port.

```bash
coop hub --host 192.168.1.20
```

A private address is allowed, with a warning, since anyone on that network can read plain http, tokens included. All interfaces (`0.0.0.0`, `::`) and public addresses are refused unless you add `--public-bind`.

### Port forwarding

Not recommended. Tokens would cross the internet unencrypted unless you put an https reverse proxy in front, and coop refuses plain http to public addresses for that reason.

## Protecting the data folder

The database holds task text, messages, permission prompts and the audit log, but no raw tokens. The folder gets owner-only permissions on macOS and Linux. On Windows, it inherits your user profile's. If your Claude runs on the same PC as the hub, remember that a shell can reach that file: the approval passphrase protects you less there. A hub on another machine, or on Cloudflare, keeps them apart.

## Backups and cleaning up

Copy `hub.db` while the hub is stopped. History older than 90 days is deleted by default: `--retention-days` changes that, and `0` keeps everything.
