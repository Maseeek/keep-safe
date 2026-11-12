# Connect your phone

The browser your agents use runs on your computer. Your phone shows it and controls it, so the phone needs a route to the computer. This guide covers the routes, pairing, and what to check when something does not connect.

The short version:

```bash
npx -y github:Maseeek/keep-safe setup
```

Scan the QR code it shows. The rest of this page explains what happens and what to do when it does not.

## Routes

`keep-safe setup` and `keep-safe up` choose a route automatically. Force one with `--route tailscale`, `--route cloudflare` or `--route local`. `keep-safe status` shows the current route and address.

### Tailscale (recommended)

[Tailscale](https://tailscale.com/download) joins your own devices into a private network. It is free for personal use. Install it on the computer and the phone and sign in to both with the same account.

Keep Safe uses Tailscale in one of two ways.

**With HTTPS certificates.** When HTTPS certificates are turned on for your tailnet, Keep Safe asks Tailscale Serve to publish the bridge at `https://your-computer.your-tailnet.ts.net`. Only devices on your tailnet can open it. The phone uses the hosted app at `keep-safe-eight.vercel.app`, which can be installed to the Home Screen and can send notifications.

To turn certificates on, open the [Tailscale admin console](https://login.tailscale.com/admin/dns), go to the DNS page, and enable HTTPS certificates. Then run:

```bash
keep-safe up --restart
```

On Linux, Tailscale Serve needs permission once: `sudo tailscale set --operator=$USER`.

Keep Safe uses port 443 when nothing else is served there, then 8443, then 10000. It leaves other Serve entries alone and removes its own on `keep-safe down`.

**Without HTTPS certificates.** Keep Safe listens on the computer's Tailscale address and serves the app itself, at an address like `http://your-computer.your-tailnet.ts.net:4318`. Tailscale encrypts the traffic between your devices, so the plain `http` here does not expose it to the networks in between. Browsers still treat the page as insecure, which rules out notifications, Home Screen install on Android, and the in-app QR scanner. Scan the QR code with the phone's camera app instead, or open the pairing link.

This route was verified on Linux with Tailscale 1.104. The HTTPS route follows Tailscale's documented Serve commands and has not been verified end to end yet.

Either way the address stays the same across restarts, so a paired phone stays paired.

### Cloudflare quick tunnel

When Tailscale is not running and [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) is installed, Keep Safe starts a [quick tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). It needs no account. The phone uses the hosted app over HTTPS, so notifications work.

The tunnel address is public and changes every time Keep Safe restarts. Phones must pair again after a restart. Every request still needs a paired phone's key or a valid one-time code, but treat this as a way to try Keep Safe, not as the long-term setup. Quick tunnels have no uptime guarantee.

### This computer only

With neither Tailscale nor `cloudflared`, Keep Safe runs at `http://127.0.0.1:4318`. That is enough to try the app in a browser on the same computer. `keep-safe status` explains how to add a phone route.

### Your own HTTPS address

If you already run a reverse proxy or a named tunnel, start the bridge in the foreground with your address:

```bash
npm run bridge -- --public-url https://bridge.example.com --app-url https://keep-safe-eight.vercel.app
```

Then pair with `keep-safe pair --config-dir ./.keep-safe`, or open the owner link the bridge prints. See the [command reference](cli.md#foreground-bridge).

## Pairing

```bash
keep-safe pair
```

This prints a QR code, a pairing link and an eight-character code, and opens the same QR code in a browser window on the computer. Add `--no-open` to skip the window and `--no-wait` to return at once.

- The code works once and expires after ten minutes. Ten wrong guesses cancel every unused code.
- The phone exchanges the code for its own key. The computer stores only a digest of that key in `~/.keep-safe/devices.json`.
- The owner key in `~/.keep-safe/config.json` never leaves the computer. Only it can create pairing codes. A paired phone and the agent key cannot.
- A phone stays paired while it is used and for 30 days after its last use. Up to ten phones can be paired.

On the phone there are three ways in:

1. Scan the QR code with the camera app. It opens Keep Safe already pairing.
2. In Keep Safe, choose **Scan QR code**. Use this inside the installed app on an iPhone.
3. Paste the pairing link, or type the code. The hosted app also asks for the computer address shown next to the code.

### iPhone

iOS gives a Home Screen app its own storage, separate from Safari. If you pair in Safari and then add Keep Safe to the Home Screen, the installed app starts unpaired. So on an iPhone:

1. Open [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app) in Safari.
2. Tap Share, then **Add to Home Screen**.
3. Open Keep Safe from the Home Screen and choose **Scan QR code**.

If you scan the QR code with the camera first, Keep Safe offers the same steps and a **Continue in Safari instead** option. Pairing in Safari works but cannot receive notifications.

### Remove a phone

Open **Connect** in the app and choose **Forget this phone**, or **Revoke** next to another phone. Revoking ends that phone's live control and notifications at once. To drop every phone, replace the owner key: see [key rotation](cli.md#replace-keys).

## Notifications

After pairing, the app offers to turn notifications on. You can also use **Settings**, then **Enable notifications**.

- Notifications need an HTTPS route: Tailscale with HTTPS certificates, a Cloudflare tunnel, or your own address.
- On an iPhone, notifications work only in the app opened from the Home Screen, as [WebKit requires](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
- **Check notification status** confirms this phone is enrolled with the current computer. It does not prove a notification arrived.
- **Turn off notifications** removes this phone's enrollment on this computer. Pairing and browser permission stay as they are.
- A notification opens the exact request it was sent for, on the computer that sent it. Alerts from another computer, old alerts and expired requests show guidance and never open a different request.

To check delivery on a real phone, lock it and run `keep-safe rehearse` on the computer. Delivery on physical phones has not been verified by the maintainers yet.

After updating Keep Safe on the computer, close every Keep Safe tab and app window on the phone and reopen it, so the updated notification worker takes over.

## Practise a handoff

```bash
keep-safe rehearse
```

1. On the phone, open **Practice browser handoff** and approve it.
2. Tap the **Practice phrase** field and type `PRACTICE`. Never use a real username, password or code here.
3. Tap **Practice sign-in**, wait for **Practice sign-in complete**, then choose **Done, hand back**.
4. The command checks that the returned browser is still signed in after a reload, then closes the practice browser.

The practice page exists only inside a temporary, isolated browser and contacts no website. The request lasts five minutes. Exit status `0` means the check passed. A pass proves this phone, this route and this synthetic handoff. It does not certify any real website's login.

## When it does not connect

Start with:

```bash
keep-safe status
keep-safe doctor
```

`doctor` reads the configuration without changing anything. The owner key is sent only to the bridge on loopback. Checks against the phone address carry no keys or cookies.

| What you see | What to do |
| --- | --- |
| The phone says it could not reach your computer | Check the computer is awake and `keep-safe status` says running. On Tailscale, open the Tailscale app on the phone and make sure it is connected. |
| "That code did not work" | Codes last ten minutes and work once. Run `keep-safe pair` again. |
| The phone was paired and now shows the welcome screen | The pairing was revoked or expired, or on Cloudflare the address changed after a restart. Pair again. Move to Tailscale to stop this recurring. |
| The app shows "Looking for your computer" | The bridge or route is down. Run `keep-safe up`. The app reconnects by itself. |
| No notifications | Check the route supports them (see above), that the app runs from the Home Screen on iPhone, and **Check notification status** in Settings. |
| `keep-safe up` says another bridge uses the port | A foreground `npm run bridge` is running. Stop it, or choose another port with `--port`. |
| `doctor` fails "Local Chromium binary" | Run `keep-safe setup` again, or `npx playwright install chromium`. On Linux, missing system libraries need `npx playwright install --with-deps chromium`. |
| `doctor` fails an app-origin or WebSocket check | The bridge was started for a different address. Run `keep-safe up --restart`. |
| Tailscale Serve could not start | On Linux run `sudo tailscale set --operator=$USER`, then `keep-safe up --restart`. |

`doctor` exits `1` when a check fails. Its public checks run from the computer, so they do not prove another network can reach the address or that it belongs to you.

Logs are in `~/.keep-safe/bridge.log` and `~/.keep-safe/tunnel.log`. They contain no keys, typed input or page content.
