# Change history

## 25 November 2026

### Form-first sign-in and 2FA escalation (0.9.0)

- When a requested page shows a login form, Keep Safe now opens **Sign-in form** first instead of dropping straight into remote-desktop controls, with a one-tap **Live browser** tab whenever you want the full page.
- Native `method="post"` form semantics with both `autocomplete="username"` and `autocomplete="current-password"` fields visible on screen (plus a **Copy site** button) so phone password managers—including Android / Pixel 7 Gboard autofill—surface reliably when inputting details.
- Supports one-tap **Unlock with passkey & sign in** for logins saved in Keep Safe's encrypted phone vault, plus opt-in saving while signing in.
- The local bridge types submitted values directly into the real browser with trusted, human-paced keystrokes (CDP keyboard events or XTEST in desktop sign-in), verifies the page origin before typing, refuses to type a password into a non-password field, and handles two-step Email → Password logins automatically.
- Escalates automatically to a native `autocomplete="one-time-code"` card for OTP verification, or straight to the live browser with a challenge banner for push-2FA prompts and CAPTCHAs, and shows a confirmation card once signed in.

## 24 November 2026

### Smoother live view and the keyboard on tap (0.8.1)

The owner found the Google sign-in unresponsive and choppy on their phone, and the keyboard did not open on Google's email field.

- The phone now acknowledges each frame it shows, and the bridge keeps at most two frames on their way. A Cloudflare tunnel accepts everything the bridge writes, so a slow phone link used to fill it with old frames and the view fell behind your finger. Frames are now paced by what the phone has shown, still at up to 30 a second. Phones and bridges from before this change keep the old pacing.
- The phone decodes each frame before it replaces the one on screen, one at a time and never cancelled, with only the newest frame waiting. On a phone slower than the stream, the view used to freeze while each new frame cancelled the decode of the one before it.
- The bridge sends one frame at a time, and a newer frame replaces one still waiting, so the phone always gets the latest picture. After a scroll or other motion, it sends one sharper image once the page stops moving, and no longer repeats identical frames.
- Desktop sign-in capture runs at 30 frames a second instead of 20, and ffmpeg writes each image out as soon as it is encoded.
- On Chrome for Android, a tap on the live picture focuses the phone's typing box during the tap itself, with the keyboard held down, and opens it with `navigator.virtualKeyboard.show()` when the bridge says the tap landed in a text field. A keyboard opened only after the bridge's answer could be refused by the phone. Phones without that API keep the **Tap to type** button.
- A swipe in the Google sign-in starts scrolling after a quarter of a wheel step instead of half, and the total still matches the finger.
- After a tap with no focus event, the bridge asks Chrome which field has focus, for at most 250 ms, instead of waiting 350 ms. Focus events are looked up one at a time, newest first, so a page cannot flood the bridge.
- A killed bridge's accessibility registry is now ended by the next bridge, like the bus and Chrome.

## 23 November 2026

### Easier phone password manager access

- **Passwords** sits right beside **Keyboard** in the tool row, so it is visible on narrow phones without swiping. It is highlighted and scrolled into view when you tap an email or password field on the page.
- Opening **Passwords** focuses the matching username or password box during the tap, so the phone's keyboard and password manager suggestions come up at once. The form stays above the soft keyboard.
- With **Passwords** open, tapping the next field on the page no longer pulls focus back to live typing, so a two-step sign-in keeps the password box ready.
- The boxes use a standard `method="post"` form with a submit button, send on Enter or Go, show when a box is ready to send, have a close button, and name the website to search for in the password manager.

Not verified: password manager prompts on a physical phone.

### Opening a request from its notification

- Tapping a notification on a phone with the app already open now opens that request. The app took the first request in the queue as already on screen, but a phone shows only the queue until one is chosen. A new request is usually first, so nothing opened and no notice appeared.
- Opening the app from a notification after the computer's address changed now opens the request. The app checked the request at the old address before moving to the one the notification gave, and showed "could not be checked". It now waits until the bridge answers, and keeps the notification when the same paired computer moves.

### Saved logins on the phone (0.8.0)

The owner asked for a way to keep login secrets, the way the Instinct assistant uses 1Password: the secret stays with the person, every use is approved, and the agent never sees it.

- Save a login from **Passwords** during a sign-in. It is encrypted on the phone with a key that only a passkey made for Keep Safe can unlock, using the WebAuthn PRF extension. Storage holds the site and ciphertext only.
- Fill a saved login into the next sign-in: unlock with your face, fingerprint or screen lock, tap a field on the page, choose **Fill**. A password goes only into a password field, and only on the exact site it was saved for. Each opening of **Passwords** needs a new approval.
- **Settings → Saved logins** lists the sites and deletes one or all.
- Agents can pass `fields` to `request_login`, such as `["Email", "Password"]`, and the phone shows them as "Have ready". The bridge refuses anything that looks like a value.
- The rule "never store passwords" now covers the computer, the bridge and the website; the phone's encrypted saved logins are the agreed exception.

## 19 November 2026

### Keyboard and scrolling in the Google sign-in (0.7.1)

The owner found scrolling far too sensitive in the Google sign-in, and tapping Google's email field did not raise the phone keyboard.

- Scroll about as far as the finger moved. Each 50 ms batch of a swipe used to send at least one mouse-wheel notch, and Chrome scrolls 120 pixels per notch, not the 53 assumed, so a slow swipe moved the page many times the finger's distance. The bridge now keeps the remainder between batches.
- Raise the phone keyboard when a tap or Tab lands in a text field, set for email, password or text. The sign-in Chrome reports focus over a private accessibility bus that only this computer user can reach and that cannot start programs. Only the focused field's role and type are read, never its text. It still has no remote debugging.
- A fast fling no longer keeps scrolling after the finger stops. Scrolling past the 40-notch limit of one batch is dropped instead of carried into the next.
- A phone remembered with the owner key stores the computer's notification key straight away. It used to be added after the first connection, so the saved pairing changed under the app, and the GitHub check on `main` failed on that timing.

## 18 November 2026

### Sign in to Google and YouTube (0.7.0)

The owner could not sign in to YouTube. Google answered "This browser or app may not be secure" because Chrome's remote debugging was on, which Google treats as automation.

- On Linux with `ffmpeg` and `Xvfb` or `Xephyr`, sign in to a Chrome that has no remote debugging, on a private display. The phone sees it through screen capture and controls it with real keyboard and mouse input. Google now asks for the password instead of refusing.
- At handback, close that Chrome normally so it writes its cookies, then reopen the same profile with remote debugging for the agent, on the same pages, with password fields cleared. Session cookies are kept.
- Show Chrome's own address bar in the picture during that sign-in, and point the owner to it instead of showing an origin Keep Safe cannot read.
- Block local files and other programs in that Chrome, whose address bar the phone can reach: no `file://` or `chrome://` pages, file picker, downloads, printing, extensions, `xdg-open` or desktop message bus.
- Back, Forward and Reload work during that sign-in. They press Chrome's own shortcuts (Alt+Left, Alt+Right, F5) on the private display. The owner asked for them after a tap on Google's passkey option left no way back.
- Allow Chrome's own interface pages (`chrome://…top-chrome`, such as the address bar's suggestion popup) and never give the agent one of them as its page. Blocking them left error pages that the agent was sometimes handed instead of the website.
- Report the sign-in mode in `keep-safe status`. `KEEP_SAFE_SIGN_IN=debugging` keeps the previous behaviour.
- Stop Chrome without losing recent cookies: SIGTERM made Chrome skip writing them, and signalling its process group killed the services that write them.

Nothing is hidden or spoofed: the sign-in Chrome has no debugging, and the agent's Chrome reports automation.

Verified on 19 November 2026: the owner signed in to Google from their phone, handed back, and the agent's Chrome was signed in to YouTube, including after a reload. Not yet verified: drags or puzzle captchas, which this mode cannot do. Xvfb was tested from an unpacked copy of Ubuntu's package, not an installed one.

## 16 November 2026

### Windows, paste, copy and password managers (0.6.0)

Last of three stages of the interaction overhaul.

- Show a strip of the windows a sign-in opens, with each title and site, to switch between them or close one. Before, Keep Safe followed the newest window and the owner could not go back.
- Add **Paste**, which sends the phone's clipboard to the field the owner tapped.
- Add **Passwords**: a username and a password box that a phone's password manager can fill. Each is sent to the page and emptied, and both are emptied when the owner leaves the app.
- Add **Select** and **Copy** to bring selected page text, such as a recovery code, to the phone's clipboard. Text inside form fields is never copied.
- Stop a notice or the window strip from resizing the website. Either one used to re-lay out the page a quarter of a second later and cancel a drag in progress.
- Release the remote mouse when a press is dropped, and let a mouse cancel go in place instead of at the corner of the page.
- Fit both bottom actions on 320 and 360 pixel phones. **Done, hand back** ran off the edge.
- Send each touch's time from the phone, so a flick keeps its momentum when a slow link delivers the moves in a burst. Without it, the page stopped where the finger did.

Not yet verified: a password manager filling the boxes, and clipboard permission prompts, on a physical phone.

### Sign in through your installed Google Chrome (0.5.0)

Second of three stages of the interaction overhaul.

- Open the owner's installed Google Chrome as an ordinary window for managed sign-ins, with a fresh temporary profile. Websites see a normal browser instead of `HeadlessChrome` with no plugins, which is what made Stripe ask for a captcha. `keep-safe up` chooses it on Linux with a display and Chrome installed, and falls back to the hidden browser otherwise or if Chrome does not start. `KEEP_SAFE_BROWSER` chooses explicitly and `keep-safe status` shows which is in use.
- Keep the Chrome window painting while it is hidden. A minimised window was held to one frame a second by the display server.
- Delete the temporary Chrome profile, cookies included, when the session's browser closes, and clean up after a bridge that was killed.
- Leave `navigator.webdriver` true. Chrome is being remote-controlled and Keep Safe does not hide it.
- Take timed captures straight from Chromium, and retry one that stalls while a page is replaced instead of ending the view.

Not yet verified: a locked screen or a display that is off, macOS, Windows, and whether Stripe now skips its captcha.

### Raw gestures and a live stream (0.4.0)

First of three stages of the interaction overhaul the owner asked for after a Stripe sign-in showed a drag captcha that Keep Safe could not operate.

- Forward the finger to the website as a real touch. The page now handles taps, swipes with momentum, drags on sliders and drag puzzles, and long presses itself, as it would in a phone browser. Before, the phone guessed between a tap and a wheel scroll, so nothing could be dragged.
- Forward a mouse or pen as hover, press, drag and release. Dragging selects text and a double click selects a word.
- Zoom and pan the view with two fingers, on the phone, up to 4×. A **Reset zoom** button shows while zoomed.
- Stream the picture. Chromium pushes a frame each time the page repaints, up to about thirty a second, and none while it is still. Frames are binary instead of base64 JSON. Before, the bridge took a screenshot ten times a second.
- Lift a held finger or mouse button when the phone stops watching, disconnects or hands back, before the agent can use the browser.
- Start the managed browser at the phone's pixel density, which the stream needs to stay sharp.
- Raise the socket limit from 60 to 240 messages a second for pointer moves. The bridge drops moves that a newer one has replaced.
- Keep older pairs working. An updated app falls back to taps and swipe scrolling with an older bridge, and an updated bridge still serves JSON frames, `click` and `scroll` to an older app.

Pinch zoom of the website itself was tried and rejected: through Chromium's debugging interface it overshoots or oscillates.

Not yet verified: any of this on a physical phone.

## 13 November 2026

### Inline QR code for agent clients

- Add `--html FILE` to `pair` and `setup`. It writes the pairing QR code as a self-contained HTML page that clients with inline HTML rendering, such as T3 Code's `html_render`, can show in the conversation. The page holds only the one-time pairing link, and the file is owner-only. Agent hand-off text and the MCP no-phone message mention the option.

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
