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

For a same-computer check using the hosted dashboard and a loopback bridge, allow the dashboard's local-network access prompt if Chromium shows it. A phone still needs the computer's reachable HTTPS address; localhost on the phone refers to the phone.

After diagnostics, open the private pairing link on your phone and rehearse approval, live input, explicit handback and agent resume before using a real account. Physical-device push delivery remains a separate unverified check.

## Rehearse a login handoff

Start the bridge and pair the phone first. Keep both the bridge and your trusted connection running, then use another terminal in the repository on the agent computer:

```bash
npm run --silent bridge -- rehearse
```

For a custom installation, use its actual local port and configuration directory:

```bash
npm run --silent bridge -- rehearse --port 5318 --config-dir ./private-keys
```

`KEEP_SAFE_PORT` and `KEEP_SAFE_CONFIG_DIR` supply defaults, with explicit options taking precedence. Only port/configuration selection applies here; the phone continues using its existing paired connection. The command reads existing local configuration, uses the separate agent key on loopback, and creates no keys, lock, bridge or tunnel.

1. On the paired phone, open **Practice browser handoff** from **Keep Safe rehearsal** and approve it.
2. In the live browser, focus **Practice phrase**. You can use **Page controls**, then **Type text → Send** to enter the public fixed phrase `PRACTICE`. Never use a real username, password or verification code.
3. Choose **Practice sign-in** in the live browser, or press its remote Enter key. Wait for **Practice sign-in complete**, then choose **Done, hand back**.
4. The command verifies the returned browser remains signed in after reload. It reports success only after that check and closes the practice browser.

The `practice.keep-safe.invalid` address exists only inside this isolated browser. Do not open it directly on the phone. Its pages are fulfilled locally, and its synthetic cookie stays in the temporary browser. The fixture has no named form field and the helper does not read its submitted body. It does not send browser input to an external site or to Vercel. Its network routes, deny proxy and restrictive content policy are separate from the managed browser's existing DNS/IP restrictions; no `--allow-local-urls` or bridge restart is needed.

The request lasts five minutes. Decline, expiry, failure and Ctrl+C close the practice browser. Ctrl+C waits for cleanup; any unfinished request can still appear on the phone until you decline it or its original deadline expires. The agent command has no owner permission to decline it automatically. Finished request metadata follows normal history retention.

Exit `0` means the synthetic login/resume check passed. Exit `1` means it did not complete or cleanup failed. Interrupt/termination/terminal hangup normally return `130`/`143`/`129` after cleanup. Use `npm run --silent bridge -- rehearse --help` for usage.

A passing rehearsal proves the specific device/connection path you actually used and this synthetic handoff. Desktop mobile emulation does not prove physical-phone use. This check does not certify third-party login providers, password clearing, passkeys, physical push or a different network. Test push separately on a physical device. Each pilot participant must use their own isolated bridge and pairing, as described in the [validation plan](validation.md).

## Check phone notifications

1. Pair the physical phone and keep the computer and its HTTPS route running. On iPhone, install Keep Safe to the Home Screen and launch it there first.
2. Open Settings and choose **Enable notifications** from that button's user gesture. Allow the browser permission. If another computer's notification key is in use, read the switch confirmation before accepting; it replaces that browser subscription and stops its earlier alerts.
3. Choose **Check notification status**. An on status confirms this browser subscription is enrolled for the current pairing on the current computer. It does not prove that a notification reached the phone. A failed check can be retried; an older bridge needs an update to supply this status.
4. Lock the phone, then run the synthetic rehearsal from another terminal on the computer. Observe whether a real notification arrives and opens the correct request. Remember the phone explicitly before expecting a fresh app window to reconnect without the owner link. Decline or complete the request within its five-minute deadline.
5. In Settings, choose **Turn off notifications**, check status again, and repeat a synthetic request. This pairing should remain connected and receive no further alerts from this computer. A notification already accepted by the push provider may still arrive; disabling cannot retract it. Browser permission and other computers' enrollments are unchanged.

Record the phone/browser family, network type and actual observed delivery or failure without collecting tokens, endpoints, input content or identifying screenshots. Physical-device delivery remains unverified until this is performed on a real device. This guide does not claim the test has happened.
