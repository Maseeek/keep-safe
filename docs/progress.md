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

### Mobile release verified at 20:16 UTC

- Pushed the mobile update in `8579bdb`, followed by the bounded-notice fix in `8ccf3bd3f8ebce670e88bc6174bf5815c3f833a0`.
- Vercel MCP production deployment `dpl_4dSEeE78HaHCCJGkavhNU1aGGFBa` is READY for the final application commit and owns [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app).
- GitHub CI `38960718271` passed for the final commit. All 59 tests pass locally and in CI.
- Verified the exact production bundle at 320px, 390px, and 1440px. Full-origin inspection, modal focus restoration, readable/dismissible inline notices, demo approval/sign-in/handback, and layout checks passed without JavaScript errors. Inspected the narrow-phone screenshot.
- The retained loopback bridge is still healthy. Repository visibility remains PRIVATE. No credentials or user browser data were added to GitHub or Vercel.
- Next priorities remain owner/agent key rotation and easier tunnel setup. Structured remote webpage access for screen readers and physical-phone push verification are still unfinished.

## Continuation at 21:00 UTC: offline key replacement

- Checked actual UTC time, current repository state, and the retained bridge's health. All key replacement tests use temporary directories and separate processes; the owner's real keys have not been rotated.
- Added explicit offline owner/agent/all replacement commands. The updated bridge CLI holds a private exclusive configuration lock before loading configuration and releases it after shutdown persistence finishes.
- Owner/all replacement syncs empty remembered-device and subscription stores before atomically replacing owner authority. Agent-only replacement preserves both files byte-for-byte. VAPID keys and extra configuration metadata are retained.
- Invalid/missing configuration and conflicting scopes fail without creating replacement keys. CLI errors and rotation output use safe messages without file contents or credentials.
- Added seven scope/failure tests and four real CLI process tests. They verify old/new authentication roles after restart, live/duplicate bridge rejection, crash-lock recovery, startup failure cleanup, partial revocation failure, and output privacy.
- Independent read-only review found no release blocker. It confirmed write ordering, lock ownership checks, scope preservation, and sanitized output. Interrupting startup can leave a safe stale lock; the documented recovery applies rather than automatically stealing it.
- Typecheck, production build, and all 70 tests across 16 files pass on Linux, including the existing real Chromium login/resume and mobile flows. Other operating systems/filesystems are explicitly unverified. Deployment results follow below.
- No additional spending or owner email; today's live-link milestone was already sent.

### Key replacement release verified at 21:17 UTC

- Pushed application commit `028844df4df218a8c49a0fa1968f98c70a8a1c2f`. Vercel MCP production deployment `dpl_8TPkFSdrr5P1gjr9oqZnTs1uk3ng` is READY for that commit at the existing production alias.
- GitHub CI `38967937635` passed. Typecheck, production build, and all 70 tests pass. Live 320px and desktop demo flows returned HTTP 200 and passed approval/sign-in/handback, overflow, and JavaScript checks.
- Verified no active or unexpired handoff existed, then gracefully restarted the local bridge with the locking implementation. Compared its private configuration before/after and confirmed it was unchanged. The new bridge is healthy and holds its private runtime lock. Current operational handle is in ignored `.keep-safe/runtime.json`.
- Real owner/agent keys were not rotated. Tests performed replacement only in temporary directories. Key replacement runs on the local computer; Vercel serves the dashboard.
- Collaborative preview initialization still returned `The calling provider no longer owns an active thread run.`; the repository browser workflow supplied the live verification. Repository visibility remains PRIVATE.
- Next useful work is easier tunnel setup and connection diagnostics. Physical push and structured screen-reader navigation remain unverified/unfinished.

## Continuation at 22:00 UTC: phone connection setup and diagnostics

- Checked actual UTC time, repository state, known work, and the retained bridge before starting. No public tunnel was created, no software service was purchased, and real owner/agent keys were not changed.
- Added `bridge setup` with shell-quoted commands and an optional user-run temporary-tunnel guide. The helper reads no configuration, installs nothing and starts no services. The phone Connections surface links to the new guide.
- Added `bridge doctor` with structured or human-readable reports for existing configuration, local authority, Chromium presence, app-origin preflight and HTTP/WebSocket transport. Its config reader does not create files, change permissions or acquire/remove locks. Only fixed loopback `/api/info` receives the owner key; public probes send no keys, cookies or authentication frames.
- Diagnostic HTTP bodies are size/time bounded, redirects are refused and remote bodies/locations are omitted from output. Root public/app origins are validated before startup can create configuration. Reports explicitly distinguish transport checks from ownership, phone reachability and physical push verification.
- Independent review identified newer Node environment-proxy behavior as a credential-routing risk. Replaced local diagnostic transports and the default HTTP loopback MCP transport with private direct agents. Regression tests poison global transports and enable proxy environment settings; local authority stays local. Explicit custom MCP fetch injection and remote HTTPS integration remain supported.
- Typecheck, production frontend build and all 93 tests across 17 files pass locally on Linux/Node 20. Tests cover file/lock preservation, wrong keys/origins, redirects, body limits/timeouts, output privacy, generated shell commands, real CLI processes and the existing real Chromium login/resume flow.
- Ran the new doctor against the actual retained bridge: all local checks pass using its current local origin. Deliberately supplying the hosted app origin correctly reports blocked CORS/WebSocket origin checks for that local-only configuration. No remote phone/tunnel success is inferred.
- Verified the setup surface at 320px, 390px and 1440px without horizontal overflow or JavaScript errors, and inspected its phone screenshot. T3 preview initialization twice returned `The calling provider no longer owns an active thread run.`; used the repository's built-app Playwright workflow.
- No additional owner email: today's live-link milestone was already confirmed sent. Physical push and structured remote webpage access remain unfinished. Deployment verification follows below.

### Connection release verified at 22:22 UTC

- Pushed application commit `eb3d872d86d89b4d8e0875d9c45f230f3021dd11` to the private repository. Vercel MCP production deployment `dpl_5bznBHGSd5G642ppNYnfRPzBNmc5` is READY for that exact commit, project and production alias [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app).
- GitHub CI `38975172637` passed on Node 22. Typecheck, production build and all 93 tests pass. Verified the expected production bundle, HTTP 200, demo approval/sign-in/handback, connection guide and layout at 320px, 390px and 1440px without JavaScript errors. Inspected the production phone screenshot.
- The retained loopback bridge is healthy and its lock matches the recorded live process. No restart was needed for the diagnostic helper or static frontend update. Existing keys, sessions and local configuration were preserved. Newly launched MCP clients load the proxy-isolated transport; already running clients retain their loaded code until restarted.
- Hourly continuation remains enabled; the next returned run is 16 October at 23:00:37 UTC, subject to host availability and the 24 October 08:00 UTC stop. No public tunnel or physical-phone push verification is claimed.
- Next useful work: privacy-preserving local retention/cleanup controls, then structured remote-page accessibility and product validation. Keep physical-phone testing explicitly outstanding until a device is available.

## Continuation at 23:00 UTC: safe history cleanup and retention

- Checked actual UTC time, the current private checkout, live provider catalog and known task states. The retained bridge is healthy. The older continuation handoff does not override the completed releases above.
- Added confirmed owner cleanup of finished request metadata, live updates to all connected owners and automatic removal of eligible records 24 hours after original expiry. No new persistence was introduced. Manual cleanup and safe capacity eviction can remove eligible records sooner; all unexpired outcomes remain retrievable by agents.
- Protected browser startup, finalization, pending input/drain and closure from metadata deletion. Slow/failed closes keep a tracked browser reference for retry. At the 100-record limit, new requests are refused if no safe record can be reclaimed.
- Added Activity cleanup controls, explicit confirmation, demo behavior, older-bridge guidance, clear failure/retry states, safe initial focus and focus recovery. The dialog test caught and fixed initial focus landing on its close icon.
- Independent mobile review found an existing stale-authentication race: a late failure from a previous bridge could erase a newer pairing. Added a source-connection guard and a browser test that switches between two real bridges before releasing an old rejected response.
- That test also exposed decorative artwork expanding the mobile viewport, which made pairing controls unreachable by normal taps. Clipped the artwork and strengthened layout assertions to compare document content with the actual client viewport rather than an inflated `innerWidth`.
- Typecheck, production frontend build and all 109 tests across 19 files pass. New coverage includes owner/agent/device roles, revoked pairing, confirmation/CORS, manual/automatic retention boundaries, original-deadline CDP protection, slow/failed closure, orphaned input, finalization, capacity, multi-owner broadcasts and phone UI recovery.
- The repository browser workflow verified 320px/390px cleanup, unexpired outcome protection, errors/retry and focus. T3 preview initialization twice returned `The calling provider no longer owns an active thread run.`; no collaborative-preview or physical-device verification is claimed.
- The actual local queue has no pending or unexpired handoff. Delivery will recheck immediately before a graceful runtime upgrade. Real keys remain unchanged. No public tunnel, cookie persistence, password storage or additional spending was introduced. No additional email: the current UTC date is still 16 October and today's milestone was already sent.

### History release verified at 23:20 UTC

- Pushed application commit `256e574c542f513e067702bf8fc780d764e6d6f6`. Vercel MCP production deployment `dpl_8dK8D7qfKpNo4QNrKitXxvKxkxMX` is READY for that exact commit and the intended project/production alias [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app).
- GitHub CI `38980548902` passed on Node 22 with all 109 tests. Verified the exact production bundle and HTTP 200 at 320px, 390px and 1440px. Demo approval/sign-in/handback, confirmation focus/Escape, cleanup, unexpired outcome retention and actual viewport bounds passed without JavaScript errors. Inspected the production phone confirmation screenshot.
- Rechecked that the retained bridge had no pending or unexpired handoff, gracefully stopped its verified process, and started the new release. Compared private configuration before/after and confirmed it was unchanged. The new bridge is healthy, advertises 24-hour history retention and holds its configuration lock. Current operational handle is in ignored `.keep-safe/runtime.json`.
- Created a synthetic 60-second request through this chat's actual Keep Safe MCP tool, declined it through the owner API, and verified its denied result through MCP after restart. Confirmed cleanup preserved the unexpired result, then removed only that synthetic record after its original deadline. MCP correctly returned not found afterward and the actual queue is empty. No browser was opened, no credentials entered, and there were no push subscriptions.
- Source remains PRIVATE; additional spend remains £0. Hourly continuation is still enabled; the next returned run is 17 October at 00:00:41 UTC, subject to host availability and the 24 October 08:00 UTC stop. Next independent work is structured remote webpage accessibility and product validation; physical-phone push remains outstanding.


## Continuation at 00:00 UTC on 17 October: remote page controls

- Checked the actual clock, current checkout, private repository, live provider catalog, existing child work and retained bridge. The older continuation handoff does not override the releases above.
- Added an on-demand mobile list of up to 50 supported main-page controls, with bounded site-provided labels, roles, disabled/checked states and password-field markers. Field values, editable content and link addresses are excluded. Metadata and target handles remain transient and owner-only.
- Focus uses opaque snapshot/target identifiers and verifies the current target before acknowledgement. Navigation, refresh, popup changes, handback and closure invalidate handles. The phone clears its draft before requesting focus and blocks text after an unconfirmed attempt; mismatched or late acknowledgements cannot report success.
- Inspection and focus use the existing handback barrier, including disconnected-owner work. A two-second deadline invalidates pending targets but does not pretend to cancel Chromium JavaScript. Busy-renderer tests verify the barrier remains held until work actually settles.
- Real-loader testing caught serialized TypeScript helper references that worked under the test runner but failed under the production tsx loader. The page inspection function now uses deliberately plain JavaScript evaluated through Playwright, with no page eval/global injection. CSP coverage verifies inspection and focus without unsafe-eval permission.
- Independent review strengthened hidden-label/value exclusion, bounded DOM traversal, stale-target checks, focus descriptions and authorization/lifecycle tests. The first full run also caught an asynchronous UI assertion and a handback/navigation race; verification and final results follow below.
- Fixed the redirect race with a three-second navigation-context retry window and frame rescanning. Underlying evaluations stay awaited; unrelated clearing failures still withhold handback. A deterministic Chromium regression checks both outcomes.
- Typecheck, production frontend build and all 133 tests across 23 files pass. Coverage includes real tsx loading, value exclusion, CSP, stale/hidden/disabled targets, busy-renderer deadlines, owner authorization, revocation/expiry, disconnected input barriers and real phone-sized login/agent resume flows.
- Main-document labels are approximations, not a complete accessibility tree. Iframes, shadow DOM, complex widgets and physical assistive-technology use remain limited or unverified. Physical-phone push remains unverified.
- T3 collaborative preview initialization twice returned `The calling provider no longer owns an active thread run.` Used the documented built-app Playwright workflow and inspected the narrow-phone controls screenshot.
- No real credentials were entered, no real keys rotated, no public tunnel created and no additional spending introduced. The hourly continuation remains enabled; its next returned run is 17 October at 01:00:45 UTC, subject to host availability and the 24 October 08:00 UTC stop.


### Page controls release verified at 00:27 UTC

- Pushed application commit `3fc4b0547b845d13e05a6f87fee26a633e01916a` to the private repository. Vercel MCP production deployment `dpl_AkGtz7heH4Pq2ezhrMDNHX6qbyPk` is READY for that exact commit, intended project and existing production alias [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app).
- Verified HTTP 200 and the exact production bundle at 320px, 390px and 1440px. Demo approval, simulated login and handback pass without JavaScript errors or horizontal overflow. Page controls are intentionally absent from the demo; the real controls flow is covered by built-app Chromium tests at 320px and 390px. Inspected the phone screenshots.
- Rechecked that the actual local bridge had no pending or unexpired handoff, gracefully stopped its verified process and started this release. Its private configuration is byte-for-byte unchanged. The new bridge is healthy, advertises page controls, holds its configuration lock and passes the local diagnostic checks. Current operational handle is in ignored `.keep-safe/runtime.json`.
- Source remains PRIVATE and additional spend remains £0. Main-page control navigation is partial accessibility support; physical assistive technology and physical-phone push remain unverified. No remote phone/tunnel success is inferred from local checks.

- GitHub CI `38986350699` passed on Node 22. Local and CI verification includes typecheck, the production build and all 133 tests.
- Sent the 17 October daily summary to the owner's connected Gmail account in the existing development thread. Gmail confirmed SENT/INBOX and returned the existing thread ID; ignored contact state records the message and summary date to prevent duplicates. No read receipt is claimed. No decision blocker was raised.
- Next useful independent work is the product validation plan and a future hosted/team offer within the £0 cap. Keep unsupported browser/assistive-technology cases and physical push verification explicit.

## Continuation at 01:00 UTC on 17 October: first-run integration and product validation

- Checked actual UTC time, current checkout, remote state, live provider catalog, existing child work and retained bridge. The repository is PRIVATE, the bridge is healthy and the previously verified production release is READY. The old continuation handoff does not override current files.
- Reviewed current primary vendor documentation for Claude Code Remote Control, Happy mobile and Browserbase Live View. Browser handoff and mobile agent access already exist, so the product proposal treats focused cross-agent local-browser login as a hypothesis rather than a unique or proven market advantage.
- Added a five-person validation plan with an owner rehearsal outside the cohort, two intended login attempts per participant, paired baseline comparisons, explicit failure denominators and later-day repeat-use measures. It includes synthetic-only observation, separate participant authority, minimal consented notes and explicit physical-device/evidence gaps.
- Expanded the future offer proposal with free local use, hypothetical managed-connection/team prices, measurable relay/support economics and release gates. No billing, analytics, recruitment, repository access grant, relay or paid service was enabled. Source visibility and the £0 cap are unchanged.
- Independent plan review clarified cohort denominators, baseline improvement thresholds, isolated participant bridges and allocation of free-user/idle costs. Unknown demand, costs and physical-phone behavior remain unknown.
- A first-run usability review found that generated MCP configurations silently used the default port and key directory even when the bridge used custom settings. The generator now supports matching `--port`/`--config-dir`, environment defaults and explicit-option precedence. Every client receives an absolute key directory and an explicit loopback bridge URL. Generation still reads no credentials and changes no client files.
- Reworked real stdio integration to launch the generated custom-port/custom-directory configuration from another working directory using only its emitted environment. Added invalid-option, safe-error, path-space, precedence, file-preservation and real TOML parsing checks. The documented Codex example was also run and parsed successfully.
- Typecheck, production build and all 151 tests across 23 files pass locally. Local documentation links resolve. T3 preview initialization twice returned `The calling provider no longer owns an active thread run.` Production verification will use the documented built-app browser fallback.
- The bridge implementation did not change, so its running process and keys do not need a restart. No additional email: the 17 October daily summary was already confirmed sent. Hourly continuation remains enabled; its next returned run is 17 October at 02:00:48 UTC, subject to host availability and the 24 October 08:00 UTC stop.

### Setup and validation release verified at 01:12 UTC

- Pushed application commit `0bcd4f2d7625727c5a22be38d0d701682e317282`. Vercel MCP production deployment `dpl_FxMim9Jveqr1xQneWuXDatgM5nBp` is READY for that exact commit, intended team/project and existing production alias [keep-safe-eight.vercel.app](https://keep-safe-eight.vercel.app).
- GitHub CI `38989668817` passed on Node 22. Typecheck, production build and all 151 tests pass locally and in CI, including the unmodified emitted-config stdio flow.
- Verified production HTTP 200 and the expected frontend bundle at 320px, 390px and 1440px. Demo approval/sign-in/handback, viewport bounds and JavaScript checks pass. The frontend bundle did not change in this release; the generator correction runs on the agent computer.
- The retained local bridge remains healthy and was not restarted. No keys, active sessions or local authority were changed. No additional email was sent, and additional spend remains £0. Repository visibility is PRIVATE.
- Product validation and future offer documents are prepared, not evidence of adoption. Physical-phone push, assistive technology, human trials, paid demand and relay/support economics remain unverified or unmeasured. Next useful work is a safe synthetic rehearsal flow before an owner-approved pilot, with the browser's private-network boundary preserved.
