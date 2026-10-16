# Development progress

## 16 October 2026

- Owner alignment completed. The application is a live mobile browser login handoff for agents.
- Budget fixed at £0 additional spend. GitHub remains private.
- Stop time fixed at 24 October 2026, 09:00 London (08:00 UTC).
- Vercel project created through MCP: `keep-safe` in the owner's existing team. Deployment is not live yet.
- Implementation split between mobile interface and local browser bridge, with an independent Antigravity architecture review.
- Gmail first send failed provider quota; Sent was checked and the retry succeeded. Owner contact is verified as sent.
- Application implementation and verification are in progress.

## First implementation verification

- Built the mobile/desktop PWA, labeled interactive demo, owner pairing, request queue, approve/deny/handback controls, local activity and export, notification setup, and live browser controls.
- Built the loopback browser bridge with separate owner/agent tokens, expiry, managed Chromium, existing-browser attachment, Web Push, and static hosting.
- Built the MCP adapter and verified it against the official MCP client transport.
- Real Chromium tests prove a login submitted through owner controls remains authenticated when the agent resumes. Owner input is rejected after completion.
- Independent Antigravity review identified endpoint timing, private-network access, password-field clearing, external-tab selection, push deep links, icon formats, and connection heartbeat issues. Implemented fixes and regression coverage for the critical browser boundaries.
- Typecheck, production build, and 24 automated tests pass. Dependency audit reports no vulnerabilities.
- Built-app mobile tests cover the complete demo and real login flow at 390 × 844. No application JavaScript errors or external requests were observed in the demo test.
- T3 preview initially rendered mobile and desktop layouts, but later snapshots timed out. Alternative CUA browsers were unavailable. Built-app Playwright tests and screenshots provided the final UI verification.
- Physical iPhone/Android push delivery, every third-party login site, and native browser attachment inside each named IDE remain unverified.

## First deployment

- Vercel MCP deployment `dpl_74GaDDU8fGcmTvquvzg8RWtRaC8h` is READY for commit `d1cd8bea7c511477ec821a860471939175837f27`.
- Verified production alias [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app) returns HTTP 200 with the app and its security headers. Manifest and PNG icons are available.
- GitHub CI run `38914352494` completed successfully for that commit.
- Added the production URL to the GitHub repository website field and README.
- Next iteration targets opt-in persistent phone pairing with expiring, revocable device tokens.

- The next Claude-based independent review could not run because its provider reported an allowance limit. No review result was inferred from that response; a fresh Gemini review was started instead.

## Iteration: remembered phones, agent setup, and security review fixes

- Added explicit opt-in seven-day phone pairing with separately issued keys. Only key digests are retained by the bridge. The master owner key remains tab-only.
- Added device listing, expiry, revocation, local forgetting, and device-owned Web Push cleanup. Tests cover reconnect after bridge/browser restart and stopping live control after revocation/expiry.
- Fixed a mobile button-overlap defect found by the UI test. Moved phone access above setup instructions for connected users.
- Improved mobile request focus, background scroll locking, Escape/back behavior, and completion position.
- Added a configuration generator for Codex, Claude, Antigravity, and generic MCP clients. It prints paths without reading credentials or modifying personal config.
- Verified the generated configuration launches a real stdio MCP process from another working directory.
- Completed the independent Gemini release security review (`d1cd8bea`) and implemented all findings:
  - Hardened outbound proxy socket error handling on `CONNECT` and HTTP requests, plus IPv6 transition range blocks (`2002::/16`, `2001::/32`, `100::/64`, `::ffff:0:0:0/96`).
  - Drained in-flight owner input before `prepareHandoff()`, required an open browser session before completion, and kept unexpired sessions usable if handoff cleanup fails.
  - Separated pre-auth rate limiting from authenticated owner/agent buckets so unauthenticated tunnel traffic cannot starve legitimate requests.
  - Replaced single-previous popup tracking with a full session page stack and cleared password inputs across all touched pages on external CDP sessions.
  - Distinguished WebSocket authentication failure close codes (`4001`) from rate limits (`4029`), throttled rapid wheel scrolling, and clamped tap coordinates.
- Linked the project in T3 Code with launch scripts (`Start local bridge`, `Open live app`, `Run tests`), opened the inline preview tab, and registered the local `keep-safe` MCP server in Antigravity, Codex, and Claude configs.
- Typecheck, production frontend build, and all 49 tests pass across 11 test files.
