# Command reference

Run commands with `npx -y github:Maseeek/keep-safe <command>`, or install once with `npm install -g github:Maseeek/keep-safe` and use `keep-safe <command>`. From a checkout, use `npm run keep-safe -- <command>`.

Keys and state live in `~/.keep-safe`. Change that with `--config-dir PATH` or `KEEP_SAFE_CONFIG_DIR`. Every command and the MCP server must use the same directory.

## setup

```bash
keep-safe setup [--route auto|tailscale|cloudflare|local] [--port NUMBER] [--no-agents] [--agents claude,codex] [--no-open] [--json]
```

Installs Chromium if needed, starts Keep Safe in the background, registers the MCP server with agent CLIs, and shows a pairing QR code. It is safe to run again: an existing bridge and existing registrations are kept.

- `--no-agents` skips registration. `--agents claude` limits it to the named CLIs.
- Registration runs `claude mcp add --scope user keep-safe -- <command>` and `codex mcp add keep-safe -- <command>` when those CLIs are installed and no `keep-safe` server is registered yet. Nothing else in your agent configuration is touched.
- `--json` prints one JSON object with the route, the pairing invitation, registration results and the MCP configuration. Installer progress goes to standard error.

## pair

```bash
keep-safe pair [--no-open] [--no-wait] [--json]
```

Starts Keep Safe if it is not running, creates a one-time code, and prints a QR code, link and code. In a terminal it waits until a phone uses the code. `keep-safe` with no command does the same.

## up, down, status

```bash
keep-safe up [--route ...] [--port NUMBER] [--restart]
keep-safe down
keep-safe status [--json]
```

`up` starts the bridge as a background process and records it in `daemon.json`. It reuses a running bridge unless `--restart` is given or the route or port differs. A restart keeps the same kind of route unless you pass `--route`.

`down` stops the bridge, the Cloudflare tunnel if one was started, and the Tailscale Serve entry Keep Safe created. Stopping closes managed browsers and clears the in-memory request queue, so finish any active handoff first.

`up` clears a lock left by a crashed bridge when the process named in the lock is gone, the lock was written on this computer, and nothing answers on the port. Any other lock is left alone.

The bridge does not start at login by itself. The MCP server starts it on demand, which covers normal use. To run it at login, add `keep-safe up` to your startup items.

## mcp

```bash
keep-safe mcp
```

Runs the MCP server over standard input and output. It starts the background bridge when a tool call finds none. See [integrations](integrations.md).

## doctor and rehearse

```bash
keep-safe doctor [--json]
keep-safe rehearse
```

`doctor` checks the configuration, the local bridge, Chromium, and the phone address when it is HTTPS. `rehearse` runs a synthetic handoff. Both are described in the [connection guide](connection.md).

## Replace keys

Stop Keep Safe first.

```bash
keep-safe down
keep-safe rotate-keys --agent     # or --owner, or --all
keep-safe up
```

- `--agent` replaces the agent key. Restart MCP clients afterwards. Paired phones are unaffected.
- `--owner` replaces the owner key and revokes every paired phone and notification enrollment.
- `--all` does both.

The command prints no keys. Replacements are written atomically with owner-only file permissions.

## Foreground bridge

A checkout can run the bridge in the foreground, which is useful for development and for custom addresses:

```bash
npm run bridge -- [--port NUMBER] [--config-dir PATH] [--public-url URL] [--app-url URL] [--listen IP,IP] [--allow-origin URL,URL] [--tailnet-http] [--name TEXT] [--allow-local-urls] [--no-static]
```

It uses `./.keep-safe` by default and prints an owner link containing the owner key. Treat that link like a password. `npm run bridge -- --help` lists every option, including `setup` (prints tunnel commands without running anything), `doctor`, `rehearse` and `rotate-keys`.

- `--listen` adds private IP addresses to listen on. Loopback is always included.
- `--tailnet-http` accepts plain `http` origins on Tailscale addresses for `--public-url`, `--app-url` and `--allow-origin`.
- `--daemon` prints no owner link. `keep-safe up` uses it.

### Recover a lock by hand

A running bridge holds `bridge.lock` in its configuration directory. If a bridge crashed and `keep-safe up` did not clear the lock, open the file, confirm the process it names has exited on that computer, then delete the file. Never delete the lock of a running bridge.

## Files

| File | Contents |
| --- | --- |
| `config.json` | Owner key, agent key and notification keys. Owner-only permissions. |
| `devices.json` | Paired phones: names, dates and key digests. No raw keys. |
| `subscriptions.json` | Notification enrollments. |
| `daemon.json` | The background bridge's process id, port and route. |
| `bridge.log`, `tunnel.log` | Startup and tunnel output. No keys, typed input or page content. |
| `bridge.lock` | Held while a bridge or key operation uses this directory. |

## Environment

| Variable | Meaning |
| --- | --- |
| `KEEP_SAFE_CONFIG_DIR` | Configuration directory |
| `KEEP_SAFE_PORT` | Local port, default 4318 |
| `KEEP_SAFE_BRIDGE_URL`, `KEEP_SAFE_AGENT_TOKEN` | Point an MCP client at a specific bridge |
| `KEEP_SAFE_CHROMIUM_PATH` | Use a specific Chromium binary |
