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

## Continuation at 19:05 UTC: live origin and mobile stream lifecycle

- Verified pairing release `133e8da673176e3aeab3a4ac94bb9c1d8a2537d1` is production READY through Vercel MCP (`dpl_5eFWm2AnXN98DdyTLpFEZSNzC434`), with HTTP 200 at the public alias. GitHub CI `38921910463` passed and repository visibility is PRIVATE.
- Completed the remaining live-address review detail: show scheme and port, warn about same-host scheme/port changes, and remove the HTTPS indicator for opaque pages. URL paths, query strings, fragments, and credentials are omitted from the address display.
- A new built-app test caught streaming continuing behind the mobile inbox after closing details. Mobile details now unmount on exit, release the stream, and discard pending wheel input. Reopening resumes the unexpired browser.
- Browser tests verify rapid wheel events are coalesced and bounded, and an input-rate disconnect reconnects with the same valid pairing and active request.
- Extended real Chromium popup coverage to clear all open session pages while leaving unrelated tabs untouched. Added CDP discovery port/path regression coverage.
- Screenshot review caught literal Unicode escapes in the browser controls; corrected them and added visible-text regression checks.
- Typecheck and all 55 tests pass across 13 files. Built-app tests include synthetic live frames for failure cases and the existing real Chromium login/resume flow.
- The T3 preview open call returned `The calling provider no longer owns an active thread run.` twice. Used the repository's built-app Playwright workflow and inspected its phone screenshot. Current inline-preview pairing is not claimed. The same ownership error prevented refreshing the recurring task's stale handoff; the hourly task remains enabled and current checkout documentation takes precedence.
- This continuation does not claim a new independent security review or physical-phone push delivery. No additional owner email was sent because today's live-link milestone was already confirmed sent.

### Deployment and chat integration verified at 19:09 UTC

- Pushed application commit `edb8cf76d4f5e26e76505236dd50717be782de1c`. Vercel MCP production deployment `dpl_8a3TV7ME38MKWnFCZ4tTtFuYoUpP` is READY for that exact commit and owns the existing production alias.
- GitHub CI `38952463605` passed. The live phone (390 × 844) and desktop (1440 × 900) demo flows passed approve, simulated sign-in, and handback checks with no JavaScript errors or horizontal overflow. Confirmed the expected new production JavaScript asset and inspected the phone screenshot.
- Restarted the local bridge on loopback port 4318 without printing its pairing credential. The native `keep_safe.request_login` and `keep_safe.get_login_request` tools are available in this T3 Codex session. Created a temporary no-credentials connection check through the actual tool, closed it through the owner API, and verified the denied result through the actual MCP tool. This proves this session's agent integration; it does not claim every named provider's native browser compatibility.
- The bridge runs in a retained command session. Its health must be checked on future continuations; host/session availability is not guaranteed. Current operational handle is in ignored `.keep-safe/runtime.json`.
- Next useful work: owner/agent key rotation, easier tunnel setup, and larger mobile text/touch targets. Physical-phone push remains unverified.

## Continuation at 20:00 UTC: mobile readability and keyboard access

- Checked the actual clock before starting, confirmed the working tree only contained the unrelated `output/`, and verified the retained local bridge was healthy.
- Increased mobile body copy and metadata sizes, set touch controls to at least 44 × 44 CSS pixels, wrapped the remote-key toolbar, and kept the phone header visible while scrolling.
- Darkened security copy and added a tap/keyboard full-origin toggle. Measured rendered live-address and redirect-warning text contrast above 4.5:1 in the narrow-screen test; this is not a full accessibility conformance claim.
- A read-only mobile review identified decline-dialog focus loss, long-origin inspection, glyph-only remote-key names, faint security text, and the remote image's lack of structured screen-reader access. Fixed the interface issues and documented the remaining remote-content limitation.
- Replaced the decline overlay with a native modal dialog, restored its opener on Cancel/Escape, named remote key controls explicitly, and exposed selected navigation/filter states.
- A new hit-target test caught an approval notice covering the live controls. Mobile request notices now appear in normal flow inside the request panel.
- Live screenshot inspection also caught an inherited `max-content` width on inline notices. Bounded them to the request width, kept dismissal visible, and added a narrow-screen content-fit regression check.
- Follow-up review caught a 320px device-confirmation overflow. Stacked its actions and added a real remember/forget flow that checks target size, content fit, and key removal.
- New browser tests cover 320px/390px layouts, unobstructed controls, modal focus recovery, complete long-origin inspection, contrast, and device confirmation. Typecheck, production build, and all 59 tests across 14 files pass, including the real Chromium login/resume flow. Deployment results follow below.
- T3 preview initialization again returned `The calling provider no longer owns an active thread run.` on both attempts. Used the repository's Playwright workflow and inspected phone screenshots. No claim of physical-phone or screen-reader testing is made.
- No additional spending or owner email. Today's live-link milestone was already sent.
