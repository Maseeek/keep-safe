# Change history

## 13 November 2026

### Agent key mismatch

- Explain a refused agent key correctly. The MCP tools used to say "Use the agent token, not the owner pairing token", which was wrong. The usual cause is an older checkout MCP entry, which reads `<checkout>/.keep-safe` while the `keep-safe` command's bridge on the same port uses `~/.keep-safe`. The error now says so, names the MCP entry to use instead and tells the agent never to ask for a key.
- Let a running `keep-safe mcp` server pick up an agent key replaced by `rotate-keys`. Before, it had to be restarted.
- Document the checkout launcher (`node bin/keep-safe.mjs mcp`), and warn against mixing the older checkout entry with the `keep-safe` command.

### One-scan pairing from any phone

- Open a secure public link by default, through a free Cloudflare quick tunnel. A phone pairs with one scan on any network, with nothing installed and nothing typed. `keep-safe up` fetches a pinned `cloudflared` release into `~/.keep-safe/bin` and checks its SHA-256 first. Tailscale is now chosen with `--route tailscale` and is no longer picked just because it is running.
- Keep the tunnel across Keep Safe restarts and updates, so the phone's address only changes when the computer restarts. The bridge replaces a tunnel that ended.
- Follow a changed address. Each request notification carries the computer's current address, and the app moves to it. Without notifications, scanning a new code re-links the same phone: it proves it holds its key and keeps it, so no second phone is created.
- Print a short **QR code page** link (`http://127.0.0.1:PORT/#qr=CODE`) and end `setup` and `pair` output with what an agent should hand to the person. The website prompt asks the agent for that link.
- Simplify the QR code page: the code, link and address sit behind **Cannot scan?**.
- Open a scanned or pasted pairing link for an app the computer serves itself (the Tailscale route without HTTPS) instead of rejecting it and asking for an address.
- Replace a background bridge started by an older release on the next command.
- Keep an existing pairing when a paired phone opens a new pairing link.

Fixes the first-run problems reported on 13 November: `setup` chose Tailscale because it was running on the computer, the phone was not on that tailnet, and the hosted app's scanner refused the resulting `http` link and asked for a code and an address.

Not yet verified: any of this on a physical phone, including the address update carried by a real notification.

## 12 November 2026

### Connect, onboarding and interface overhaul

- Pair phones with a one-time code instead of the owner key. `keep-safe pair` shows it as a QR code in the terminal and in a browser window. Codes are single use, last ten minutes, and ten wrong guesses cancel every unused code. The phone receives its own revocable key.
- Keep a paired phone paired while it is used. Pairing now ends after 30 days without use, replacing the fixed seven days.
- Add the `keep-safe` command: `setup`, `pair`, `up`, `down`, `status`, `mcp`, `doctor`, `rehearse`. It runs the bridge in the background, keeps keys in `~/.keep-safe`, and installs with `npx -y github:Maseeek/keep-safe` or `npm install -g github:Maseeek/keep-safe`.
- Choose the phone route automatically. Tailscale Serve with HTTPS when certificates are on, Tailscale direct otherwise, a Cloudflare quick tunnel when `cloudflared` is installed, and local-only as the last resort. The bridge can listen on a Tailscale address in addition to loopback.
- Let the MCP server start the bridge on demand, and tell the agent when no phone is paired. `setup` registers the server with the Claude Code and Codex CLIs when present.
- Replace the unpaired demo landing with a welcome flow. Phones get install, computer setup and pairing steps with a QR scanner and code entry. Computers get the setup prompt to paste into an agent. The demo is one tap away.
- Size the managed browser to the approving phone's screen at up to twice the pixel density, so websites show their mobile layout and text is sharp.
- Make the live view full screen on phones, with a full-screen toggle elsewhere. Open tools share one scrolling tray and the page scales to the space left.
- Type straight into the page with the phone's keyboard. A tap on a text field raises the keyboard, characters are forwarded as typed and never kept on the phone, and the view fits above the keyboard.
- Capture frames up to ten times a second while the page changes, skip unchanged frames, refresh immediately after input, and keep the text caret visible.
- Rebuild the interface with a single spacing scale, light and dark themes, fewer decorative elements, and shorter copy.
- Rewrite the README and connection guide. Add a phone app guide and a command reference.

Not yet verified: the Tailscale HTTPS route, the camera scanner on a physical phone, keyboard behaviour on physical iOS and Android, and notification delivery on a physical phone.

## 11 November 2026

### Agent long polling

- `GET /api/requests/:id` accepts `wait` (1–30 seconds) and optional `since` (an earlier `updatedAt`). The bridge holds the response until the request changes, ends, or the wait expires. Expiry, owner actions, history removal and bridge shutdown release held responses; at most 32 are held at once.
- The MCP `wait_for_login` tool now long polls, so the agent learns of completion immediately instead of up to 1.5 seconds later and makes far fewer requests. It keeps the 1.5-second cadence against bridges that ignore `wait`, and cancellation aborts a held request.

## 18 October 2026

### Notification request routing

- Open only the exact request verified against the current pairing's public notification-source key. Remove the fallback from an unknown request ID to the first queued request.
- Keep wrong-source, missing, expired and legacy alerts neutral. Preserve active browser drafts and require an explicit Open request action before leaving another live view.
- Keep fresh notification windows neutral until source and request checks finish, including remembered-phone startup and delayed connection changes.
- Use a nested notification payload, new worker message names and fixed same-origin fragments. Carry no pairing token, private key or private bridge address in the intent. Older app/worker pairs require reload; physical delivery remains a separate check.

### Website navigation

- Add website Back, Forward and Reload to managed browser sessions, with named mobile buttons and capability checks for older bridges and attached browsers.
- Discard local drafts and invalidate old images, controls and focus before navigation. Require a matching result, a fresh image and renewed field confirmation before input resumes.
- Clear current password fields before departure, block document form resubmission and retain actual browser work through timeout recovery and explicit handback.
- Make concurrent browser-close calls wait for the same cleanup, including navigation failure overlapping expiry.
- Keep attached external browsers on their existing website controls; no complete browser-history sanitization or physical-device evidence is claimed.

### Remote input verification

- Wait for exact click and scroll effects in the remote browser before checking their result. Keep accepted-message counters separate from completion.
- Hold the pen action in a synthetic regression to reproduce the acceptance/application gap, and drain earlier socket actions before asserting stale-source click rejection. Preserve the original counts, scroll limits and timeouts.

### Background browser pause

- Pause live viewing and input when the app receives hidden/page-leaving signals; discard unsent text and its reveal setting.
- Require an explicit Resume browser action, a fresh image and renewed field confirmation. Keep the request's original expiry and explicit handback.
- Retire old control connections and ignore their late frames/focus replies. Reconnect for queue updates without silently reclaiming paused browser control.
- Discard queued commands from closed sockets so a delayed watch cannot block the next owner. Preserve accepted browser work through password clearing and handback.
- Reject reconnects before bridge shutdown waits for browser cleanup, preventing a new socket from keeping shutdown open.

### Direct touch scrolling

- Scroll the live website with one finger inside its image, with scaled, bounded and coalesced movement. Keep taps distinct from swipes, cancelled gestures and multi-finger input.
- Discard queued input on request, connection, source, geometry and control changes; keep normal screenshot refreshes within the same gesture.
- Add validated optional scroll positions so nested panels and embedded pages receive wheel input without a click. Bind positioning and scrolling to the same browser page and abort if it changes.
- Preserve mouse/pen taps, wheel controls, browser zoom and the keyboard/scroll-button alternatives. Add synthetic Chromium touch login, cancellation and authenticated-resume coverage; physical-device verification remains open.

### Remote keyboard controls

- Add a compact More keys panel for Space, Escape, Shift+Tab, arrows, navigation, Delete and Select all, using existing bridge commands.
- Distinguish keyboard arrows from page scrolling and provide wrapping, named touch targets.
- Keep pending or failed focus blocked across ordinary keys, refresh and reconnect. Permit recovery through confirmed focus, an explicit browser tap, Tab or Shift+Tab.
- Verify native checkbox/radio/select activation, remote Escape, password clearing and authenticated resume at phone sizes. Add direct transport checks for rapid input, abandoned acknowledgements and reconnect recovery.

## 17 October 2026

### Embedded login controls

- Navigate native fields and buttons in supported embedded HTTP(S) pages, with each frame's origin shown visibly and in accessible descriptions.
- Confirm focus through exact frame and ancestor chains; reject stale frames and child navigation before acknowledging focus.
- Keep older dashboards main-only unless they explicitly request frame-aware metadata. Bound the complete scan and omit unsupported or opaque frame subtrees.
- Add synthetic same-/cross-origin mobile login and agent-resume checks, without exporting field values or full frame URLs.

### Open web-component login controls

- Include native fields and buttons in nested open roots, with root-scoped labels, composed visibility checks and confirmed deep focus.
- Reject moved targets and report actual counts when a bounded scan is incomplete.
- Clear and verify password fields inside open roots before handback without exporting their values. Withhold handback on errors, exhausted limits or immediate reinsertion.
- Monitor popup intents before owner input and block handback while a popup's first navigation is unresolved. Require a retry when clearing opens another window.
- Arm the managed browser before its first navigation and verify every tracked page/frame again after clearing, including restoration by later frames or popups.
- Add phone-sized component sign-in, hidden-password cleanup and authenticated agent-resume coverage; keep closed-root and physical accessibility limits explicit.

### Notification enrollment and control

- Check the current pairing's bridge enrollment before showing notifications as enabled; reject stale results from another connection.
- Add retryable enrollment/status/removal controls without forgetting the phone or removing other computers' subscriptions.
- Ask before replacing a different browser notification key, and document the distinction between enrollment and physical delivery.
- Persist dead endpoint removal and preserve newer enrollments when an older in-flight send fails.
- Transfer a verified tab-owner enrollment during explicit phone remembering, so the new device's revocation removes its alerts. Reject changed enrollment and roll back unpublished device creation on migration failure.
- Prevent delayed remember actions from replacing a newer connection, and revoke unused device keys returned after cancellation or supersession.

### Focus acknowledgement during navigation

- Invalidate page-control snapshots on early navigation intent, including synchronously cancelled navigation, before acknowledging remote focus.
- Include previous snapshot disposal in the inspection deadline and preserve pending browser work through handback.
- Add repeated real-browser navigation coverage and wait for background expiry persistence in its test without changing immediate revocation.

### Synthetic phone rehearsal

- Add `bridge rehearse` for an agent-only, five-minute practice handoff with a fixed public phrase and same-browser sign-in verification after reload.
- Isolate practice pages in a temporary browser with a deny proxy, bounded local routes and loopback debugging. Keep managed private-network restrictions unchanged.
- Close the practice browser on success, denial, expiry, failure and interruption; document any unfinished request's original expiry.
- Add real CLI and phone-sized success/failure, input-output privacy and network-isolation coverage. Physical-device and real-provider verification remain separate.

### Agent setup and validation plan

- Generate MCP configurations for the bridge's selected port and key directory, with explicit loopback URLs and matching environment/option precedence.
- Verify the emitted configuration through a real stdio MCP process from another working directory, without manual environment corrections.
- Add a consent-based product validation plan, measured go/no-go criteria and future hosted/team offer hypotheses. No billing, analytics, outreach or paid service is enabled.

### Remote page control navigation

- Add bounded on-demand main-page field/button labels, roles and protected-field markers without reading field values or link addresses.
- Focus stable snapshot targets and confirm the actual remote focus before enabling text sending. Reject stale targets and late acknowledgements.
- Keep inspection/focus inside owner control and handback barriers, including disconnected-controller work.
- Add value-exclusion, stale-target, authorization, lifecycle and mobile login/resume coverage. Document partial accessibility and physical-testing limits.

## 16 October 2026

### Safe history cleanup and retention

- Add confirmed owner history cleanup, shared live updates, and automatic cleanup of eligible memory-only metadata 24 hours after original expiry.
- Preserve unexpired agent outcomes, live work, pending input/handback and browser opening/closure. Track slow or failed closes until safe completion.
- Keep the 100-record cap without evicting protected outcomes; return a capacity error when necessary.
- Add mobile confirmation, focus recovery, retryable errors, demo behavior and older-bridge guidance. Prevent stale authentication failures from clearing a newer pairing.
- Clip decorative mobile artwork to prevent viewport expansion and restore reachable pairing controls. Strengthen phone overflow checks against the actual layout viewport.
- Test authorization/revocation, expiry boundaries, concurrent browser work, capacity and complete mobile cleanup flows.

### Phone connection setup and diagnostics

- Add `bridge setup` command guidance, optional temporary-tunnel instructions, safe shell quoting and structured output without reading keys or starting services.
- Add read-only `bridge doctor` checks for local authority, Chromium presence, app-origin preflight, and HTTP/WebSocket transport. Never send credentials to public probes, follow redirects, or print remote response data.
- Keep local diagnostic and default loopback MCP credentials off global/environment proxy transports. Preserve explicit custom-fetch injection and remote HTTPS integration.
- Reject non-root public/app URLs before creating local configuration, and link the connection guide from the mobile setup surface.
- Test diagnostic side effects, credential boundaries, redirects, stalled/oversized responses, rejected app origins, generated commands and real CLI output.

### Offline key replacement

- Add `rotate-keys --owner|--agent|--all` to the bridge CLI, with explicit scopes and credential-free output.
- Hold an exclusive configuration lock during bridge runtime and key replacement. Refuse stale/malformed locks until an operator verifies recovery is safe.
- Atomically replace private configuration and revoke remembered phones/notifications before committing owner-key changes. Preserve VAPID and extra configuration metadata.
- Add scope/authentication, failed persistence, configuration validation, real CLI restart, crash-lock, and output privacy tests.

### Mobile readability and keyboard access

- Increase phone text sizes and touch targets, wrap the remote-key toolbar, and keep the header visible while scrolling.
- Darken the live address and redirect warning. Add a tap/keyboard toggle that reveals the full origin without URL secrets.
- Use a native decline confirmation with focus restoration, name remote keys, and expose selected navigation/filter states.
- Move mobile session notices into the request panel so they do not cover live controls.
- Stack device confirmation actions on phones and test the complete remember/forget flow at 320px.
- Document that the remote webpage image still lacks structured screen-reader navigation.

### Live origin and mobile control

- Show the live website's scheme and port, warn on origin changes, and avoid HTTPS indicators on opaque pages.
- Stop the mobile browser stream when leaving a request and discard pending scroll input.
- Verify rapid scrolling, recovery after an input-rate limit, and keeping valid pairing credentials through reconnection.
- Extend popup password-cleanup coverage to all open session pages while preserving unrelated tabs. Reject CDP discovery that switches port or leaves the devtools path.
- Fix Unicode escape sequences that were displayed literally in browser controls.

### Remembered phones and agent setup (`133e8da`)

- Add opt-in seven-day device keys, local key-digest storage, device revocation, and notification cleanup.
- Generate credential-free MCP configuration for Codex, Claude, Antigravity, and generic clients.
- Fix proxy socket resets, IPv6 transition address filtering, popup recovery, input ordering before handback, and rate-limit recovery.
- Improve mobile request focus, background scroll locking, and keyboard navigation.

### First app implementation (`d1cd8be`)

- Added the mobile PWA, browser request queue, approval and denial, live browser controls, history, setup, and a clearly labeled demo.
- Added the local Chromium bridge, expiring owner control, separate agent credentials, Web Push support, and MCP/HTTP integrations.
- Added private-network filtering with a DNS-pinning proxy, password-field clearing before handback, completed-only agent browser endpoints, and security boundaries for local files and WebSockets.
- Added real browser login/resume tests, built-app mobile tests, and CI.
- Recorded the owner's confirmed brief, £0 budget, private-source requirement, contact channel, and 24 October 09:00 London stop time.
