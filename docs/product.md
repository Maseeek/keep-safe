# Product direction

Keep Safe helps someone away from their desk finish a website login in the browser their agent will resume. The product should make that interruption short, understandable and safe across different agent clients.

This is an early product hypothesis. Automated login tests establish technical behavior; they do not establish customer demand, willingness to pay or profitability. No independent user study or paying customer is recorded yet. Use the [validation plan](validation.md) before expanding the service.

## The first customer

Start with a solo developer who already runs agents on an awake computer, uses more than one MCP-capable client, and encounters website logins while away from that computer. Their immediate job is to return the same authenticated browser to the waiting agent. Someone whose workflow is already covered by an existing mobile agent app may have little reason to add another tool.

Source stays private. The public dashboard has a labeled demo; installing the current bridge requires repository access. Do not describe it as generally available open source or promise that an unaffiliated visitor can install it today.

## Alternatives checked on 17 October 2026

These observations come from the vendors' own documentation, not hands-on comparative tests. Capabilities and prices can change.

| Alternative | Published capability | Implication to test for Keep Safe |
| --- | --- | --- |
| [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) | Continues a local Claude Code session from a phone or browser; the computer and process remain running. | Does a separate browser login interruption remain after users adopt their existing remote controls? |
| [Happy mobile app](https://happy.engineering/mobile-app/) | Describes a free phone interface for agent messages, permission requests and session changes. | Broad mobile agent access alone is a weak reason to pay for Keep Safe. |
| [Browserbase Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view) | Supports watching and controlling a browser, including human input and mobile embedding. | Interactive browser handoff already exists. Test the value of keeping the browser on the user's computer and integrating with their chosen agent. |

Browserbase offers free and paid infrastructure plans on its [pricing page](https://www.browserbase.com/pricing). This is a different hosting model; its browser-hour prices are not evidence that Keep Safe customers will pay a similar amount.

Our inference is that the strongest candidate value is a focused login handoff across agents, with easy setup and clear local-browser ownership. There is no evidence yet that this is a defensible market advantage. Measure it against users' actual alternatives.

## Free initial release

Keep the local bridge and mobile dashboard free during validation. The app requires no paid AI API. The user supplies an awake computer and a trusted HTTPS route to the bridge. Cookies stay on that computer; browser inputs are not logged or stored by Keep Safe. Physical-phone push and assistive-technology use still need direct testing.

Keep expiry, separate agent authority, device revocation and the no-password-storage boundary in the free workflow. A paid service should earn its price through easier connectivity and shared operations.

## Future offers to test

These prices are interview hypotheses in GBP, not live plans, market-tested prices or permission to charge anyone. Nothing in this proposal creates a hosted account, relay, team service or billing integration.

| Offer hypothesis | Price to test | Proposed value beyond the free release |
| --- | --- | --- |
| Local | £0 | Current self-managed bridge, phone interface and MCP/HTTP integration. Private-source access remains at the owner's discretion. |
| Solo managed connection | £12/month | Easier pairing and a managed connection to the user's own running computer. Usage limits would follow measured relay cost. |
| Small team | £49/month for up to five people | Individual identities, scoped approval routing, machine ownership, central revocation and minimal action-status audit records. |

Ask what users would replace, what setup/support they expect, and whether they would choose this at the stated price when a free alternative is visible. Record a request for a real follow-up trial separately from a polite positive response. Do not accept deposits, collect payment details or advertise these as purchasable plans.

## Economics and release gates

Measure active handoff duration, transmitted bytes and support time using synthetic pages or consented coarse counts. Do not estimate cost from request count alone: the current image stream sends JPEG frames as base64, so page complexity and viewing time affect bandwidth.

For a future relay, model `encoded frame bytes × delivered frames + protocol overhead` per session. Add measured hosting, connection coordination, notification, payment and support costs before estimating contribution per customer. Allocate free-user traffic and idle connection capacity too. Define revenue consistently after applicable taxes, refunds and payment fees, without counting a fee twice. Free-tier availability is not a sustainable cost forecast. No measured cost model or margin claim exists yet.

Proceed with a hosted design only after the validation gates pass. Before a paid launch, require positive contribution after realistic support cost, an infrastructure budget approved by the owner, and reviewed usage limits. The current additional-spending cap is £0; this document authorizes no purchase, upgrade or domain.

A relay needs a separate threat model and independent review of endpoint authentication, session encryption, replay resistance, expiry and revocation. Browser inputs and cookies must remain off the Vercel dashboard service and out of relay persistence/logs. Do not claim end-to-end encryption or team isolation before implementing and verifying them.

Team access requires separate people and machine permissions, not shared owner links. Current remembered phones are devices of one owner, not hosted multi-user accounts. Publishing source, granting repository access to a cohort, collecting payments and changing the spending cap remain explicit owner decisions.
