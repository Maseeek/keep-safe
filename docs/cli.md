# Command reference

Run commands with `npx -y github:Maseeek/keep-safe <command>`, or install once with `npm install -g github:Maseeek/keep-safe` and use `keep-safe <command>`. From a checkout, use `npm run keep-safe -- <command>`.

Keys and state live in `~/.keep-safe`. Change that with `--config-dir PATH` or `KEEP_SAFE_CONFIG_DIR`. Every command and the MCP server must use the same directory.

## setup

```bash
keep-safe setup [--route auto|tailscale|local] [--port NUMBER] [--no-agents] [--agents claude,codex] [--no-open] [--json]
```

Installs Chromium if needed, starts Keep Safe in the background with a secure public link for the phone, registers the MCP server with agent CLIs, and shows a pairing QR code in the terminal and in a browser window. It is safe to run again: an existing bridge and existing registrations are kept.

When an agent runs `setup` for you, you cannot see its terminal. The output ends with the **QR code page** link for the agent to pass on, such as `http://127.0.0.1:4318/#qr=ABCD2345`.

- `--no-agents` skips registration. `--agents claude` limits it to the named CLIs.
- Registration runs `claude mcp add --scope user keep-safe -- <command>` and `codex mcp add keep-safe -- <command>` when those CLIs are installed and no `keep-safe` server is registered yet. Nothing else in your agent configuration is touched.
- `--json` prints one JSON object with the route, the pairing invitation, registration results and the MCP configuration. Installer progress goes to standard error.

## pair

```bash
keep-safe pair [--no-open] [--no-wait] [--html FILE] [--json]
```

Starts Keep Safe if it is not running, creates a one-time code, opens the QR code page in a browser, and prints the QR code, the QR code page link and the pairing link. In a terminal it waits until a phone uses the code. `keep-safe` with no command does the same.

`--html FILE` also writes the QR code as a self-contained HTML page (owner-only file mode), and `--json` reports its path as `html`. Agents in clients that show HTML inline, such as T3 Code's `html_preview` and `html_render` tools, can show that page in the conversation instead of handing over a link. The page has no background of its own and uses the host's theme variables, while the code itself stays black on white so it scans. It holds the one-time pairing link and nothing else. `setup` takes the same option.

## up, down, status

```bash
keep-safe up [--route ...] [--port NUMBER] [--restart]
keep-safe down
keep-safe status [--json]
```

`up` starts the bridge as a background process and records it in `daemon.json`. It reuses a running bridge unless `--restart` is given, the route or port differs, or the bridge was started by an older Keep Safe release. A restart keeps the route you chose unless you pass `--route`.

Routes: `auto` (the default) opens a secure public link through a Cloudflare quick tunnel, fetching `cloudflared` into `~/.keep-safe/bin` the first time. `tailscale` keeps the connection inside your tailnet. `local` serves this computer only. `KEEP_SAFE_ROUTE` sets the default, and `KEEP_SAFE_CLOUDFLARED` points at a `cloudflared` program to use instead of fetching one. The [connection guide](connection.md#routes) compares them.

The tunnel runs as its own process and is left running across `up --restart`, so the phone's address survives restarts and updates. The bridge replaces it if it ends.

`down` stops the bridge, the tunnel, and the Tailscale Serve entry Keep Safe created. Stopping closes managed browsers and clears the in-memory request queue, so finish any active handoff first.

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

## The browser

A managed sign-in opens one of two browsers.

- **Google Chrome, as a window.** Your installed Chrome, started the way you would start it, with a fresh temporary profile. Websites see an ordinary browser with a normal name, plugins and graphics, so they ask for a captcha less often. The window appears on the computer's screen and shows the page while you sign in from the phone. Closing it ends the session.
- **Built-in, hidden.** The Chromium that Keep Safe installs. Nothing appears on the computer. It reports itself as `HeadlessChrome`, and some websites answer that with a captcha.

`keep-safe up` picks Chrome when the computer runs Linux, has a display (`DISPLAY` is set, as it is in a desktop session with X11 or XWayland) and has `google-chrome` or `google-chrome-stable` installed. Otherwise it uses the hidden browser. `keep-safe status` shows which one is in use.

Set `KEEP_SAFE_BROWSER` before `keep-safe up --restart` to choose: `bundled` always uses the hidden browser, `chrome` uses Chrome on any system where it is found, and `auto` is the default described above. If Chrome fails to start, that session falls back to the hidden browser.

What the Chrome window route changes:

- Cookies are written to a temporary profile folder that only your user can read. The folder is deleted when the session's browser closes, which is at the request's deadline at the latest. If Keep Safe is killed, the next start closes the leftover Chrome and deletes its folder. The hidden browser keeps cookies in memory only.
- Chrome is told not to offer to save passwords, cards or addresses in that profile.
- Chrome is started with rendering switches (`--ozone-platform=x11 --disable-gpu-vsync`) so the page keeps painting while the window is hidden. Without them a minimised window updated once a second.
- All traffic still leaves through Keep Safe's checked proxy, so private and local addresses stay blocked, and downloads are refused.
- No switch hides that Chrome is being controlled. `navigator.webdriver` stays true, because it is. A website can still decide to show a captcha, and you can now solve it from the phone.

Verified on Linux (COSMIC on Wayland with XWayland) with Chrome 157, with the window showing and minimised. Not verified: a locked screen or a display that is off, macOS, Windows, and a Wayland session without XWayland.

### Signing in without remote debugging

Google, and so YouTube and Gmail, refuses to sign in a browser that has remote debugging switched on. It answers "Couldn't sign you in. This browser or app may not be secure" as soon as the email is entered. Remote debugging is what makes `navigator.webdriver` true, and Keep Safe does not hide that.

So on Linux, when the tools below are installed, you sign in to a Chrome that has no remote debugging at all:

1. Keep Safe starts a private X display that only it can connect to, and opens Chrome on it with the session's fresh profile.
2. Your phone sees that display through screen capture (`ffmpeg`), and your taps, scrolling and typing reach Chrome as real keyboard and mouse input from that display.
3. When you choose **Done, hand back**, Keep Safe closes that Chrome the way a person would (Ctrl+Shift+W), which writes its cookies to the profile. It then opens the same profile again with remote debugging on, on the pages you had open, clears any password fields, and gives the agent that browser.

Measured with Chrome 157: Google rejected the sign-in with debugging on and asked for the password without it, with nothing else changed.

What you will notice:

- The picture includes Chrome's own tab strip and address bar. Keep Safe cannot read the address of a browser it does not control, so the phone points you to that address bar instead of showing an origin itself. Check it before you type a password.
- Chrome's window is at least 500 pixels wide, so the page is laid out a little wider than your phone and shown slightly smaller.
- The phone uses taps and swipe scrolling. **Back**, **Forward** and **Reload** press Chrome's own shortcuts, so Chrome behaves as it would at the computer. If a page came from a form, Chrome asks before sending it again, and you see that dialog. Dragging (sliders, puzzle captchas), long press, the window strip, page controls and **Copy** need remote debugging and are not available until the handback. Chrome's own tabs are in the picture.
- Chrome's address bar and menus are in reach of the phone, so the profile blocks everything in them that reaches the computer: `file://` and `chrome://` addresses (apart from Chrome's own interface, such as the address bar's suggestions), the file picker (upload buttons say access to local files is disabled), downloads, printing and extensions. Chrome cannot start other programs: its `xdg-open` does nothing and it has no desktop message bus. Before this, typing `file:///etc/os-release` into the address bar from the phone showed the file.
- Tapping a text field raises the phone keyboard, set for an email address, a password or plain text as the field asks. This needs the accessibility registry (`at-spi2-registryd`, from at-spi2-core, installed with most Linux desktops) and `dbus-daemon`. Without them, use the keyboard button, **Type text** or **Passwords**.
- A swipe scrolls about as far as your finger moved, in steps of 120 pixels, the distance of one mouse-wheel notch in Chrome.

What it needs: Google Chrome, `ffmpeg`, and either `Xvfb` (hidden, preferred) or `Xephyr`. Xephyr shows the private display as a "Keep Safe sign-in" window on the computer's screen, and needs a desktop session. On Ubuntu, `sudo apt install ffmpeg xvfb` provides both. Without them, or with `KEEP_SAFE_SIGN_IN=debugging`, you sign in to the Chrome window with remote debugging on, as above. `keep-safe status` shows which.

The display's cookie and Chrome's profile are in the same temporary folder, deleted when the session's browser closes. A killed bridge's display is ended by the next start.

## Environment

| Variable | Meaning |
| --- | --- |
| `KEEP_SAFE_CONFIG_DIR` | Configuration directory |
| `KEEP_SAFE_PORT` | Local port, default 4318 |
| `KEEP_SAFE_BRIDGE_URL`, `KEEP_SAFE_AGENT_TOKEN` | Point an MCP client at a specific bridge |
| `KEEP_SAFE_BROWSER` | `auto`, `chrome` or `bundled`. See [the browser](#the-browser) |
| `KEEP_SAFE_ATSPI_REGISTRY` | Path to `at-spi2-registryd`, when it is not in a usual place |
| `KEEP_SAFE_SIGN_IN` | `debugging` signs in to Chrome with remote debugging on. See [signing in without remote debugging](#signing-in-without-remote-debugging) |
| `KEEP_SAFE_CHROME_PATH` | Use a specific Google Chrome program |
| `KEEP_SAFE_CHROMIUM_PATH` | Use a specific Chromium binary for the hidden browser |
