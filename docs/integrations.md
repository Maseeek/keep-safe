# Agent integrations

Keep Safe supplies a common MCP server and an HTTP API. It does not intercept an IDE's private browser or automatically gain access to every agent's existing session. The agent must call the integration and pause its browser input during the handoff.

## Local MCP server

Start the bridge first. Configure an MCP-capable client to launch the server with its absolute checkout path:

```json
{
  "mcpServers": {
    "keep-safe": {
      "command": "node",
      "args": [
        "--import",
        "/absolute/path/to/keep-safe/node_modules/tsx/dist/loader.mjs",
        "/absolute/path/to/keep-safe/packages/mcp/src/index.ts"
      ],
      "env": {
        "KEEP_SAFE_CONFIG_DIR": "/absolute/path/to/keep-safe/.keep-safe"
      }
    }
  }
}
```

This is the common JSON configuration shape, not a promise that every client uses that exact configuration file. Codex may use TOML; T3 Code and other clients may provide a settings interface. Use the client's current MCP configuration mechanism with the same command, arguments, and environment.

The server loads the separate agent token from the private local configuration. It never receives the owner pairing token. For a remote bridge, set `KEEP_SAFE_BRIDGE_URL` to its HTTPS origin and provide `KEEP_SAFE_AGENT_TOKEN` through the client's private environment configuration. Do not paste a real token into tracked examples or a prompt.

### Tools

- `request_login`: create a time-limited request with `agent`, `title`, `url`, optional `reason`, `cdp_url`, and `ttl_seconds`.
- `get_login_request`: inspect status using `request_id`.
- `wait_for_login`: wait up to 120 seconds for a terminal status; wait again if it is still pending or active.

After a `completed` result, resume in the same browser context. A `denied` or `expired` result means stop. Keep Safe does not prove that a third-party login succeeded merely because the owner returned control; the agent must verify the destination site's authenticated state.

## Existing agent browser

For a Chromium browser with an explicitly enabled loopback CDP endpoint, pass `cdp_url`, such as `http://127.0.0.1:9222`, with the already open login page's URL. Keep Safe attaches to the matching page. Chromium debugging must remain on loopback and must not be exposed through the phone tunnel. Chrome 136 and later require a non-default `--user-data-dir` when using remote debugging switches; do not attach your everyday personal profile. See the [Chrome security change](https://developer.chrome.com/blog/remote-debugging-port).

If an agent's built-in browser does not expose a supported endpoint, it cannot be attached by guessing its port or stealing another tool's session. Configure a shared external browser or use the managed browser flow.

## Managed browser

Without `cdp_url`, Keep Safe opens an isolated Chromium browser when the owner opens an approved request. Agent-authenticated request details include `browser.cdpUrl` once the owner completes the handoff. The agent can connect to that local endpoint after completion and use the authenticated context.

Cookies remain in memory on the developer's computer. The managed browser is closed at the request's original expiry time, including after completion. Agents must resume before that deadline. Existing externally owned browsers are disconnected rather than terminated by Keep Safe cleanup.

## HTTP API

All API requests except `/api/health` require `Authorization: Bearer <token>`. Tokens must not be put in URL queries.

- Agent token: `POST /api/requests` with JSON matching `CreateRequestInput`; `GET /api/requests/:id` to poll the result.
- Owner token: `GET /api/info`, `GET /api/requests`, `POST /api/requests/:id/approve`, `/deny`, or `/complete`.
- Owner push subscription: `POST /api/push/subscribe`.
- Owner live control: WebSocket `/ws`, first message `{"type":"auth","token":"<owner token>"}`, followed by `watch` and bounded input messages.

Public message types are in [protocol.ts](../packages/shared/src/protocol.ts). The executable MCP adapter is in [packages/mcp](../packages/mcp/src/index.ts).

## Compatibility scope

T3 Code, Codex, Claude, Antigravity, and other clients are targets through their configurable MCP and browser interfaces. Each product's private native browser integration requires separate verification. The initial tests cover Keep Safe's MCP protocol and browser bridge, not every version of every IDE.

The MCP adapter uses the official [TypeScript MCP SDK](https://ts.sdk.modelcontextprotocol.io/server), with stdio transport. Chromium supports external browser control through the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
