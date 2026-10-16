# Connect your phone

The hosted dashboard is at [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app). Its browser bridge runs on your agent's computer. Keep that computer awake. A phone on another network needs a reachable HTTPS connection to the bridge's loopback port; the hosted dashboard does not supply a relay.

## Generate setup commands

After following the README's local installation, run this in the repository:

```bash
npm run --silent bridge -- setup
```

The helper prints local-start, optional tunnel, public-start, and diagnostic commands. It does not read keys, create configuration, install software, or start a tunnel. Add `--port NUMBER`, `--config-dir PATH`, `--app-url ORIGIN`, or `--public-url ORIGIN` to generate commands for your configuration. Add `--json` for structured output. Generated commands use POSIX shell quoting; Windows command shells need their own quoting.

The default setup app origin is the hosted dashboard. Start and doctor commands default to the bridge's own origin unless `--app-url` is supplied. Use the same options for startup and diagnosis. Environment equivalents are `KEEP_SAFE_PORT`, `KEEP_SAFE_CONFIG_DIR`, `KEEP_SAFE_APP_URL`, and `KEEP_SAFE_PUBLIC_URL`.

## Optional temporary tunnel

Use a tunnel or private network you control. For a temporary development connection, Cloudflare's [official Quick Tunnel guide](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) describes installing `cloudflared` and running:

```bash
cloudflared tunnel --url http://127.0.0.1:4318
```

This command has not been run against the owner's bridge. Keep Safe does not install or run it automatically. Quick Tunnels need no domain or account, use a temporary hostname, and have no uptime guarantee. They are a development option rather than an always-on service. Do not add a paid plan or domain within this project's £0 budget.

Run the bridge first so the tunnel has a local destination. Keep the tunnel in a separate terminal. Copy the HTTPS origin it assigns. Stop the bridge with Ctrl+C in its own terminal, then restart it with that origin:

```bash
npm run bridge -- \
  --public-url https://YOUR-TUNNEL.trycloudflare.com \
  --app-url https://keep-safe-eight.vercel.app
```

Replace the placeholder before running the command. Finish or end any active login before restarting: stopping the bridge closes managed browsers and clears its in-memory queue. Do not remove a live `bridge.lock` to start a second bridge.

Only expose the authenticated bridge. Keep Chromium debugging ports on loopback. Confirm the tunnel's destination yourself before opening the bridge's private pairing link on your phone. Pairing links contain owner authority; do not put them in logs, screenshots, issues, chat, or Git. Website cookies stay on the computer.

If a temporary hostname changes, restart with the new `--public-url` and pair the phone again. For same-origin bridge hosting, omit `--app-url`; it then defaults to `--public-url`.

## Diagnose a connection

Run doctor **on the agent's computer**, using the running bridge's actual options:

```bash
npm run --silent bridge -- doctor \
  --public-url https://YOUR-TUNNEL.trycloudflare.com \
  --app-url https://keep-safe-eight.vercel.app
```

Doctor reads existing configuration without changing files, permissions, locks, keys, or browser sessions. It works while the bridge holds its normal configuration lock. No bridge must be stopped just to run diagnostics. No configuration is generated when it is missing.

The owner key is sent only to the constructed `http://127.0.0.1:PORT/api/info`. Local diagnostic transports use private direct agents so environment proxy settings cannot route loopback authority through a proxy. See [Node's proxy behavior](https://nodejs.org/api/http.html#built-in-proxy-support) for why default global transports are insufficient for this boundary. Public health, CORS preflight and WebSocket checks carry no keys, cookies or authentication frames. Redirects are not followed. Responses have bounded size/time and error output omits remote bodies and redirect locations.

| Check | What to do if it fails |
| --- | --- |
| Existing local configuration | Confirm `--config-dir` matches the running bridge. Start the bridge once to initialize a new installation. Repair invalid local configuration before continuing. |
| Local bridge | Confirm the bridge is running on `--port`. A free dashboard cannot keep the computer awake or start the bridge remotely. |
| Local owner authentication | The port may belong to a bridge with different keys. Confirm its configuration directory; restart it after key replacement. Do not copy keys into diagnostic arguments. |
| Local Chromium binary | Run `npx playwright install chromium`. Binary presence alone does not prove Linux libraries or browser launch work. |
| Local/public app origin | Restart the bridge with the dashboard's exact `--app-url`, including scheme and any non-default port. CORS needs the correct app origin. |
| Local/public WebSocket transport | Check the app origin and the tunnel's WebSocket support/protection. An HTTP health response alone does not establish live-stream support. |
| Public health transport | Check the current tunnel hostname, TLS, and destination. Redirects or HTML may indicate a tunnel login/protection page. |

Without `--public-url`, doctor reports that remote transport was not checked. Loopback HTTP is accepted for development and produces a phone-access warning. Public/app URLs must be root origins, without credentials, paths, query strings or fragments.

Exit status is `1` when any check fails and `0` when none fail. Warnings can remain on exit `0`; it is not a certification that a phone can connect. Use `--json` with `npm run --silent` for machine-readable reports.

Public probes run from this computer. They do **not** prove the remote endpoint belongs to you, that another network can reach it, that browser security restrictions permit the connection, or that physical push works. Tunnel protection that needs an interactive browser login can also block cross-origin API and WebSocket requests. Do not bypass an access policy just to make a diagnostic pass.

After diagnostics, open the private pairing link on your phone and verify approval, live taps/typing/scrolling on a non-sensitive test site, explicit handback, and agent resume. Physical-device push delivery remains a separate unverified check.
