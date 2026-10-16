# Change history

## 16 October 2026

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
