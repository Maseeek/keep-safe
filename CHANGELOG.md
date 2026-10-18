# Change history

## 18 October 2026

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
