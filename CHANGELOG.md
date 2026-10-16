# Change history

## 16 October 2026

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
