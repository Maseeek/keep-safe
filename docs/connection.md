# Connect your phone

The browser your agents use runs on your computer. Your phone shows it and controls it, so the phone needs a route to the computer. This guide covers the routes, pairing, and what to check when something does not connect.

The short version:

```bash
npx -y github:Maseeek/keep-safe setup
```

Scan the QR code it shows. The rest of this page explains what happens and what to do when it does not.

## Routes

`keep-safe setup` and `keep-safe up` open a secure public link by default, so any phone can pair with one scan. Choose another route with `--route tailscale` or `--route local`. Keep Safe remembers the choice across restarts. `keep-safe status` shows the current route and address.

### Secure public link (default)

Keep Safe opens a free [Cloudflare quick tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) from your computer. It needs no account, no open ports and nothing installed on the phone. The phone can be on any Wi-Fi or on mobile data.

- The first run fetches Cloudflare's `cloudflared` program (20 to 55 MB depending on the system) into `~/.keep-safe/bin`. The release is pinned and checked against its published SHA-256 before it runs. A `cloudflared` already on your PATH is used instead.
- The address is a random name such as `https://four-random-words.trycloudflare.com`. It is public, but it only answers a paired phone's key or a valid one-time code.
- Traffic is HTTPS between the phone and Cloudflare, and travels on through Cloudflare's tunnel to your computer. Cloudflare carries it and could technically read it. Use Tailscale if that is not acceptable to you.
- The phone uses the hosted app at `keep-safe-eight.vercel.app`, so it can be installed to the Home Screen and can receive notifications.

**When the address changes.** The tunnel keeps running when Keep Safe restarts or updates, so the address stays the same. It changes when the computer restarts or the tunnel ends. Keep Safe then opens a new tunnel by itself. A paired phone follows in one of two ways:

1. With notifications on, the next request's notification carries the new address and the app moves to it. Nothing to do.
2. Otherwise run `keep-safe pair` and scan the new code. The phone keeps its existing key and entry, so this takes one scan and does not create a second phone.

Quick tunnels have no uptime guarantee. For an address that never changes, use Tailscale.

### Tailscale

```bash
keep-safe up --route tailscale
```

[Tailscale](https://tailscale.com/download) joins your own devices into a private network. It is free for personal use. Install it on the computer and the phone and sign in to both with the same account. The phone must have Tailscale connected whenever it uses Keep Safe. Nothing passes through a public address.

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

Either way the address stays the same across restarts.

### This computer only

With `--route local`, or when the tunnel program cannot be fetched and Tailscale is not running, Keep Safe runs at `http://127.0.0.1:4318`. That is enough to try the app in a browser on the same computer. `keep-safe status` explains how to add a phone route.

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

This opens a page with a QR code in a browser on the computer, and prints the same QR code in the terminal. Scan it with the phone camera. That one scan opens Keep Safe and pairs the phone. Nothing else needs typing.

The command also prints two links:

- **QR code page**, such as `http://127.0.0.1:4318/#qr=ABCD2345`. Open it on the computer if the window did not appear. An agent running the command for you should give you this link.
- **Pairing link**, for opening on the phone itself when scanning is not possible.

Add `--no-open` to skip the window and `--no-wait` to return at once.

- The code works once and expires after ten minutes. Ten wrong guesses cancel every unused code.
- The phone exchanges the code for its own key. The computer stores only a digest of that key in `~/.keep-safe/devices.json`.
- The owner key in `~/.keep-safe/config.json` never leaves the computer. Only it can create pairing codes. A paired phone and the agent key cannot.
- A phone stays paired while it is used and for 30 days after its last use. Up to ten phones can be paired.
- A phone that is already paired can scan a new code at any time. It proves it holds its key, keeps that key, and only updates the computer's address.

On the phone there are three ways in:

1. Scan the QR code with the camera app. It opens Keep Safe already pairing.
2. In Keep Safe, choose **Scan QR code**. Use this inside the installed app on an iPhone.
3. Paste the pairing link into the app. Typing the eight-character code also works, together with the computer address shown under **Cannot scan?** on the QR code page.

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

- Notifications need an HTTPS route: the default secure public link, Tailscale with HTTPS certificates, or your own address.
- On the default route a notification also tells the phone the computer's current address, so the app follows it after the computer restarts. Web Push encrypts that for the phone alone.
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
| No QR code appeared | Open the **QR code page** link the command printed, on the computer. Or run `keep-safe pair` again. |
| The phone says it could not reach your computer | Check the computer is awake and `keep-safe status` says running and shows a phone address. On Tailscale, open the Tailscale app on the phone and make sure it is connected. |
| `keep-safe status` says the phone address is still opening | The tunnel could not reach Cloudflare. Check the internet connection. Keep Safe keeps retrying. `~/.keep-safe/tunnel.log` has the detail. |
| "That code did not work" | Codes last ten minutes and work once. Run `keep-safe pair` again. |
| The phone was paired and now shows the welcome screen | The pairing was revoked or expired. Pair again. |
| The app shows "Looking for your computer" | Run `keep-safe status` on the computer and start it with `keep-safe up` if needed. If the computer restarted, its address changed: choose **Scan new code** in the app and scan the code from `keep-safe pair`. With notifications on, the next request fixes this by itself. |
| No notifications | Check the route supports them (see above), that the app runs from the Home Screen on iPhone, and **Check notification status** in Settings. |
| `keep-safe up` says another bridge uses the port | A foreground `npm run bridge` is running. Stop it, or choose another port with `--port`. |
| `doctor` fails "Local Chromium binary" | Run `keep-safe setup` again, or `npx playwright install chromium`. On Linux, missing system libraries need `npx playwright install --with-deps chromium`. |
| `doctor` fails an app-origin or WebSocket check | The bridge was started for a different address. Run `keep-safe up --restart`. |
| Tailscale Serve could not start | On Linux run `sudo tailscale set --operator=$USER`, then `keep-safe up --restart`. |

`doctor` exits `1` when a check fails. Its public checks run from the computer, so they do not prove another network can reach the address or that it belongs to you.

Logs are in `~/.keep-safe/bridge.log` and `~/.keep-safe/tunnel.log`. They contain no keys, typed input or page content.
