# Architecture and security

## Components

The Vercel deployment serves the mobile web application. It contains no browser cookies, passwords, or agent API credentials. The same frontend can be served by the local bridge.

The bridge runs on the developer's computer, listens on loopback, manages login request state, and connects to Chromium. The owner pairs using a private link with the owner token in the URL fragment. The app removes the fragment immediately. HTTP requests use bearer authentication; WebSocket authentication is the first message, not a URL query.

MCP and HTTP clients use a different agent token. An agent can create a login request and poll its status, but cannot approve the request, control the owner's interface, or subscribe for owner notifications.

## Why the browser stays local

The additional spending cap is £0. A local browser avoids paid always-on browser compute and keeps website sessions on the user's computer. Vercel serves the frontend while the bridge owns the persistent interactive connection. See [Vercel function limits](https://vercel.com/docs/functions/limitations).

Remote access requires the computer to remain awake and a secure route to the bridge. A user-controlled HTTPS tunnel or private network can provide this. Cloudflare's [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are an evaluation option with availability and concurrency limits. They are not a production service-level guarantee. Keep Safe does not install or start a public tunnel silently.

## Data and lifetime

- Owner and agent bootstrap tokens plus Web Push keys are local files with owner-only permissions in ignored `.keep-safe/`.
- Offline key replacement requires an exclusive configuration-directory lock shared with the bridge CLI. It never prints new keys. Owner/all replacement durably revokes remembered phones and subscriptions before committing new bootstrap authority; agent-only replacement preserves them. VAPID keys remain unchanged. A crash lock is retained for explicit recovery rather than stolen automatically.
- Connection diagnostics use a pure existing-config reader and do not acquire or alter locks. Only a fixed loopback `/api/info` check receives the owner key. Public HTTP/preflight/WebSocket probes are unauthenticated, reject redirects, bound responses, and report transport rather than ownership or physical-phone success. The setup helper prints commands without reading keys or starting a tunnel.
- The default MCP client uses a private direct HTTP agent for loopback URLs, keeping the agent key off global proxy dispatchers. Explicit custom-fetch injection remains an integration responsibility; remote HTTPS uses the normal fetch transport. Redirects are refused.
- Remembered phones receive separate seven-day device keys. The bridge stores SHA256 digests and device metadata in a local, atomically written file. It does not retain raw device keys.
- A remembered key is saved in the phone's localStorage only after explicit opt-in. The master owner token remains tab-only. Authenticated APIs and every live-control message recheck expiry/revocation. The device key never confers agent rights or permission to pair another phone.
- Request metadata is in memory and resets on restart. Eligible finished records are removed automatically 24 hours after original expiry, or earlier by confirmed owner cleanup/capacity pressure. All unexpired outcomes and pending browser opening/finalization/input/closure remain protected. A tracked failed close retains its browser reference for retry. The 100-record cap refuses new requests when no safe record can be removed.
- Web Push subscriptions may be stored locally. They are not uploaded to Vercel.
- Browser input is relayed transiently. Passwords and input messages are not logged or written to disk. Screenshots are streamed without recordings or trace files.
- Managed browser cookies remain in an isolated in-memory context. Existing agent browser cookies remain owned by that browser.
- Handoffs expire after ten minutes by default, with an agent-requested maximum of thirty minutes. Owner control ends on completion, denial, or expiry. A completed managed browser remains available only until the original deadline.

## Controls and limits

The bridge validates request URLs, accepts loopback-only CDP endpoints, rejects unsupported message types, bounds message sizes and queue length, checks permitted frontend origins, and limits request/input rates. Only one owner connection can control a given request at a time. Managed browser traffic passes through a local proxy that resolves and validates DNS, rejects private and reserved addresses, and connects to the validated IP. Subresources and redirects use the same boundary. External CDP browsers remain outside that managed network boundary.

Owner pairing links are sensitive credentials. Share them only with yourself. The app supplies revocable phone keys but does not provide a multi-user account service. Closing a tab is not equivalent to revocation. Use Connections to revoke a phone; possession of the original private owner link remains bootstrap authority.

An agent must cooperate by pausing while the human has control. Keep Safe cannot stop a separate process from issuing its own CDP commands. An agent holding the debugging endpoint has privileged access to that browser; do not use a general personal browser profile for untrusted agents.

## Authentication method limits

The phone interacts with the remote Chromium page. This does not move a phone's passkeys, native password manager, biometrics, or hardware security key into that remote browser. Some sites also block automated browsers. These methods need explicit testing and may require a supported cross-device authentication flow.

Use a separate browser profile, and inspect the current website origin before entering credentials. The app shows the live scheme, hostname, and port without the URL's path, query, fragment, or credentials. A change of origin triggers a warning, including HTTPS to HTTP or a different port. Opaque pages such as `about:blank` are not labeled as HTTPS. Keep Safe does not bypass website authentication or anti-abuse protections.

On mobile, leaving request details releases live control and stops frame streaming. Pending wheel input is discarded when leaving, changing requests, disconnecting, or ending control. Reopening the request can resume its existing browser before expiry.

The owner may request a bounded main-page control list over the authenticated live-control socket. Only the active controller receives labels/roles/state; field values, cookie data and link addresses are not inspected. The browser retains at most 50 transient target handles, bound to a snapshot, page and URL. Navigation, refresh, handback and closure invalidate them. Focus rechecks the current descriptor and active element, and the frontend requires the matching acknowledgement before reporting success. Website-provided labels can still contain sensitive text; this is transient owner-visible content, never activity history or a server log. Pending inspection/focus participates in the handback barrier. This is an approximate control navigator rather than full accessibility-tree or physical assistive-technology support.

## Notifications

The bridge can use Web Push with locally generated VAPID keys. Permission is requested only when the owner enables notifications. Some mobile browsers require installation to the home screen. Actual lock-screen delivery requires a subscribed physical device and is separate from testing the service worker and subscription API. On iOS, install to the Home Screen before requesting push from a user gesture; see [WebKit's Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
