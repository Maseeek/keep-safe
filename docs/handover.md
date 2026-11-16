# Handover: interaction overhaul, stage 3 in progress

Written 16 November 2026 for the agent continuing this work. Read `docs/progress.md` (last three sections) first.

## Agreed with the owner

Three stages, each merged and released once types, tests and real-browser checks pass ("staged, auto-release"). No address bar.

1. Raw gestures and live stream. **Released** as 0.4.0 (pull request 6).
2. Installed Google Chrome as a visible window. **Released** as 0.5.0 (pull request 7).
3. Tab switcher, paste from phone, text selection with copy back, phone password managers. **In progress** on branch `feat/tabs-paste-select`, not merged, not released.

## State of stage 3 (branch `feat/tabs-paste-select`)

Written and type-checked (`npm run typecheck` passes, `npm run build:web` builds):

- Protocol (`packages/shared/src/protocol.ts`): `BrowserTab`, client messages `tab`, `close-tab`, `copy-selection`, server messages `tabs`, `selection`, `BridgeInfo.tabsAvailable` and `selectionAvailable`.
- Bridge session (`packages/bridge/src/browser.ts`): `tabs()`, `selectTab()`, `closeTab()`, `onTabs()`, `selection()`. `selection()` reads document ranges only, so field contents are never returned.
- Bridge server (`packages/bridge/src/server.ts`): validates the three messages, `followTabs` pushes the tab list on watch and on change.
- App: `workspace.tabs`, `workspace.copySelection()`; `BrowserPanel.tsx` has the tab strip (shown when more than one window), **Paste**, **Passwords** (a username and a password box that a password manager can fill, each sent to the page and cleared), **Select** (finger drags as a mouse) and **Copy**. `GestureSurface.tsx` takes `selecting`.
- Fixture `tests/fixtures/gesture-site.ts` has a password field `#secret`, a window opener, and counters `user-arrived`, `secret-arrived`, `paste-arrived`.

Tests: `npx vitest run packages/bridge/test/gestures.test.ts` gives 10 of 11.

- **Failing:** "copies selected page text to the phone, and never what is in a field". After a mouse drag from (21,305) to (153,305), `copy-selection` returns `''` where `'alpha bravo'` is expected. The same drag does select `alpha bravo` (the older test "selects exactly the dragged text" reads it after handback). So look at `selection()` and `selectionSource` in `browser.ts` first: check what `frame.evaluate` returns, and whether the selection survives until the copy.
- The tabs test passes.

## Left to do for stage 3

1. Fix the failing selection test above. Keep the assertions that field and password contents are never returned.
2. Add app tests in `tests/gesture-stream-ui.test.ts`: tab strip appears, switches and closes; Select then drag then Copy puts `alpha bravo` on the clipboard (grant `clipboard-read` and `clipboard-write`); Paste sends the clipboard to the tapped field (`paste-arrived`); Passwords boxes filled with `gestureFixtureValues` reach `#field` and `#secret` (`user-arrived`, `secret-arrived`), are empty afterwards, and are cleared when the page is hidden; no page errors or overflow at 320 px and 390 px.
3. Look at the new tools at 320 px and 390 px in light and dark. The tool row scrolls sideways; check the new buttons and the tab strip keep 44 px targets.
4. Run `npm test` (expect it clean; it was 430 passing before stage 3), then the real-Chrome set from `AGENTS.md` for the changed files.
5. Bump the version to 0.6.0 in `package.json`, `package-lock.json` (two places at the top), `packages/bridge/src/server.ts` (`info.version`), `packages/mcp/src/server.ts`, and `packages/bridge/test/pairing.test.ts`.
6. Update `README.md`, `docs/phone.md`, `docs/architecture.md`, `docs/integrations.md`, `CHANGELOG.md`, `docs/backlog.md` (the stage 3 line) and `docs/progress.md`. State plainly that password-manager fill and clipboard behaviour are not verified on a physical phone. Delete this file when stage 3 is released.
7. Open a pull request, link it with the T3 tool, merge, confirm production serves the new bundle (compare `apps/web/dist/assets` with the live files), run a production check like stage 1's, then restart the owner's bridge.

## Things that are easy to get wrong

- GitHub Actions is blocked by the account's billing lock. Local runs are the verification.
- The suite has intermittent failures under load in `notifications-ui` and `bridge-cli` that predate this work. Rerun before blaming a change.
- Restart the owner's bridge only when it is idle, and in its own scope: `systemd-run --user --scope --quiet --unit "keep-safe-$(date +%s)" node bin/keep-safe.mjs up`. Started from an agent session it dies with the session and the phone address changes. Never print keys.
- `KEEP_SAFE_BROWSER=chrome` test runs open Chrome windows on the owner's desktop.
- `navigator.webdriver` is deliberately left true in Chrome. Do not add switches that hide automation or change the user agent.

## Not verified anywhere yet

A physical phone, a locked screen or switched-off display with the Chrome window, macOS, Windows, and whether Stripe now skips its captcha. The owner's phone needs one new scan (`keep-safe pair`) because the address changed on 16 November.
