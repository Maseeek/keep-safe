# Working on Keep Safe

Read `docs/alignment.md`, `docs/backlog.md`, and `docs/progress.md` before choosing work. The owner wants a useful mobile interface for completing an agent's actual browser login while away from their computer.

## Current authorization

- Keep this repository private. Do not publish a licence or source without the owner's later decision.
- Additional spending is capped at £0. Use existing connected AI allowances; no paid APIs, domains, services, or plan upgrades.
- Parallel implementation and independent review are authorized. Use the live T3 provider catalog; a listed but quota-limited model is not a successful review. Continue with an available provider.
- Autonomous work ends on Saturday 24 October 2026 at 09:00 Europe/London, which is `2026-10-24T08:00:00Z`. Check the clock before substantial work and deployments. At the deadline, stop new work and disable the recurring task in `docs/delivery.md`.

## Boundaries to preserve

- No password storage, browser input logs, cookie exports to the hosted app, recordings, or traces containing login data.
- The phone controls a live browser. Label demo interactions clearly and never request real credentials in the demo.
- Owner and agent credentials have separate roles. Persistent phone pairing uses separate expiring, revocable keys; never persist the master owner token in localStorage.
- Agent browser endpoints are available only after explicit handback. Drain in-flight owner input and clear remaining password fields before releasing managed browser access.
- Keep Chromium debugging endpoints on loopback. Preserve the managed browser's DNS/IP network boundary and do not expose private files through static hosting.
- Do not claim native IDE browser compatibility or physical-device push delivery without direct evidence.

## Verification and delivery

- `npm run typecheck` checks all TypeScript.
- `npm test` builds the frontend, then runs the full suite, including real Chromium and built mobile UI flows. Install Chromium with `npx playwright install chromium` if absent.
- Run the checks appropriate to changes. Fix actual product defects instead of forcing browser clicks or weakening assertions to pass tests.
- Use the T3 collaborative preview first. Follow its documented fallback rules when unavailable or repeatedly failing.
- Deploy through Vercel MCP to the existing `keep-safe` project. Confirm project, team, source commit, and production target before deployment. Production URL is `https://keep-safe-eight.vercel.app`.
- Keep the README, change history, backlog, and progress accurate. Register any created or worked-on pull request with T3's linking tool.
- Leave unrelated `output/` files alone. Credentials and local contact operational state belong in ignored `.keep-safe/`.

## Contact

The owner authorized Gmail contact to their own connected account for daily progress and decisions. Follow `docs/contact.md`, deduplicate sends, and verify sending before claiming delivery. Do not contact unrelated recipients or email every minor change.
