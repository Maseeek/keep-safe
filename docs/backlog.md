# Product backlog

## First usable release

- [x] Mobile-first request queue, approval, denial, activity, connection setup.
- [x] Real interactive browser handoff, with clear origin and live status.
- [x] Authenticated local bridge, separate owner and agent credentials.
- [x] No password storage, bounded expiring control, revoked terminal sessions.
- [x] MCP and HTTP integrations with real agent resume flow.
- [ ] Phone web push delivered on a physical device (subscription API, worker and installation guidance implemented).
- [x] Meaningful explicit demo mode for visitors without a bridge.
- [x] End-to-end fixture proving login and reuse of authenticated browser state.
- [x] Security tests, mobile/desktop browser QA, CI, and live production verification. Latest results are in [progress.md](progress.md).
- [x] Verified Vercel deployment linked from GitHub.
- [x] Verified owner contact and bounded recurring continuation.

## After first release

- [x] Independent cross-provider architecture review and fixes for confirmed findings. Further release reviews remain part of iteration.
- [x] Phone pairing with separate keys, device listing, and immediate device revocation. Originally a fixed seven days, now 30 days after last use.
- [x] Compatibility examples and config generator for T3 Code, Codex, Claude and Antigravity.
- [x] Multi-hop popup recovery, touched-page password clearing, and documented unsupported authentication methods.
- [x] Full live origin display, mobile stream release on leaving a request, and scroll/rate-limit reconnect regression coverage.
- [x] Offline owner/agent key replacement, exclusive CLI configuration locking, and documented crash recovery.
- [x] Easier tunnel setup and read-only connection diagnostics, with private loopback transport and documented remote-verification limits.
- [x] Larger phone text and touch targets, full-origin inspection, named remote keys, and modal keyboard/focus recovery.
- [ ] Complete remote webpage navigation and physical assistive-technology testing. A bounded value-free navigator supports native controls in nested open roots and supported HTTP(S) frames; opaque/sandbox-attribute/srcdoc frames, closed roots and custom widgets remain limited.
- [x] Privacy-preserving memory-only history retention and owner cleanup, with pending browser work and unexpired handoffs protected. Persistent cookie/session retention remains outside this release.
- [x] Product validation plan and future hosted/team offer hypotheses, without enabling billing or spending. See [validation.md](validation.md) and [product.md](product.md); demand and prices remain unvalidated.
- [ ] Owner-approved private pilot with physical phones, real repeat-use evidence and measured relay/support economics before any hosted paid service.
- [x] Participant-safe synthetic login/resume rehearsal before a real-phone pilot, without weakening the managed browser's private-network boundary. Physical-device pilot evidence remains outstanding.
- [x] Per-computer notification enrollment checks, independent disable controls and explicit browser-key switching, with pairing preserved. Physical delivery remains a separate open requirement.
- [x] Open web-component control navigation and verified password clearing before handback, with bounded scans and value-free focus metadata. Closed roots and website-retained JavaScript data remain outside this support boundary.
- [x] Embedded native control navigation with explicit frame origins, legacy-client opt-in protection, bounded frame scans and confirmed top-to-child focus. Physical accessibility and broader widget support remain open.
- [x] Mobile keyboard panel for native checkbox/radio/select activation, Escape and navigation keys, with failed-focus protection across refresh/reconnect. Real Chromium phone-sized login and resume checks pass; physical keyboard/assistive-technology evidence remains open.
- [x] Direct mobile swipe scrolling with positioned nested-area input, tap/gesture separation and lifecycle cancellation. Chromium touch-emulated login/resume is verified; physical-device gesture and pinch behavior remain open.
- [x] Background browser pause with draft clearing, explicit resume, renewed focus and safe controller release. Controlled lifecycle signals with real sockets/Chromium pass; physical-phone suspension and app-switcher behavior remain unverified.
- [x] Managed-browser Back, Forward and Reload, with document form-resubmission blocking, draft clearing, fresh-image/focus requirements and explicit recovery after interrupted navigation. Attached browsers retain website controls; broader widgets and physical accessibility remain open.
- [x] Notification routing bound to current pairing metadata and the exact request, with neutral legacy/wrong-source startup and explicit protection for an active browser view. Physical notification display/delivery remains unverified.

- [x] One-time pairing codes with QR, link and typed entry, replacing owner-key links for normal setup. Phone keys renew on use and end after 30 idle days.
- [x] `keep-safe` command with background bridge, automatic route choice (Tailscale, Cloudflare quick tunnel, local), agent registration and on-demand start from the MCP server.
- [x] Welcome flow for phones and computers, with the agent setup prompt and a demo entry.
- [x] Phone-sized managed browser, full-screen live view, live typing with the phone keyboard, faster frame updates.
- [x] Interface rebuild with light and dark themes.
- [ ] Verify on physical phones: camera scanner, keyboard raise and fit on iOS and Android, Home Screen pairing on iOS, notification delivery.
- [ ] Verify the Tailscale HTTPS route end to end on a tailnet with certificates enabled.
- [ ] Start the bridge at login (systemd user unit, launchd agent) from `keep-safe setup`.
- [ ] Publish to npm so `npx keep-safe` works without the GitHub prefix.
- [ ] Momentum scrolling and pinch zoom forwarded to the remote page.

Prioritize the complete live login workflow and safety over cosmetic expansion. Keep this list current from evidence.
