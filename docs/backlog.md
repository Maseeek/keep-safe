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
- [x] Security tests, mobile/desktop browser QA, CI (55 tests and GitHub CI pass; live production demo checked on phone and desktop layouts).
- [x] Verified Vercel deployment linked from GitHub.
- [x] Verified owner contact and bounded recurring continuation.

## After first release

- [x] Independent cross-provider architecture review and fixes for confirmed findings. Further release reviews remain part of iteration.
- [x] Opt-in seven-day phone pairing, device listing, and immediate device revocation (token rotation CLI still open).
- [x] Compatibility examples and config generator for T3 Code, Codex, Claude and Antigravity.
- [x] Multi-hop popup recovery, touched-page password clearing, and documented unsupported authentication methods.
- [x] Full live origin display, mobile stream release on leaving a request, and scroll/rate-limit reconnect regression coverage.
- [ ] Owner/agent token rotation CLI and tunnel setup helper.
- [ ] Further accessibility and mobile keyboard improvements, including larger mobile text and touch targets.
- [ ] Privacy-preserving local session retention and cleanup controls.
- [ ] Product validation plan and future hosted/team pricing proposal, without enabling billing or spending.

Prioritize the complete live login workflow and safety over cosmetic expansion. Keep this list current from evidence.
