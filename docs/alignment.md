# Project alignment

Agreed with Maciek on 16 October 2026.

## Product

Keep Safe lets developers and people who vibe code complete an agent's website login while away from their computer. A polished mobile interface displays the agent's actual browser and accepts taps, typing, and scrolling. The owner approves a request, performs the login, then explicitly returns control to the agent.

A link alone is insufficient. The first version must include a request queue, approve and deny controls, session history, phone notifications, and expiring handoffs. Support agents through a common integration rather than locking the product to one model or IDE. Target T3 Code, Antigravity, Claude, Codex, and other MCP/HTTP-capable agents. Document compatibility limits honestly.

## Decisions delegated to the implementation

- Choose architecture and visual design.
- Choose sensible security and expiry defaults.
- Never store passwords or log browser input. Cookies may remain in the agent's browser session.
- Build a free initial product with a path to a profitable service.

## Budget and constraints

- Additional spending cap: **£0**. No paid APIs, hosted browser infrastructure, databases, domains, or plan upgrades.

## Communication

The owner requested a way to contact them during development and named Gmail, WhatsApp, and Discord. Prefer an existing connected service within the £0 cap. Send progress and genuine decision requests only to the owner's account. See [contact.md](contact.md) for verified contact state.

## First architecture

A static mobile web app deployed on Vercel communicates with an authenticated local bridge on the developer's running computer. The bridge controls or attaches to a Chromium browser and exposes agent integrations over MCP and HTTP. Browser cookies stay on that computer. Remote access requires an HTTPS connection to the bridge, through a private network or a user-controlled tunnel. The computer must remain awake while the agent works.

This choice avoids paid always-on browser infrastructure. A hosted managed relay and team subscriptions are future product options, not part of the zero-cost deployment.
