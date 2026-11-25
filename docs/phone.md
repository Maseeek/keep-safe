# The phone app

Keep Safe on the phone has four tabs: **Inbox**, **Activity**, **Connect** and **Settings**. This guide walks through a request and then covers each tool.

## A request from start to finish

1. An agent asks for a sign-in. The request appears in **Inbox**, with a notification if you turned those on.
2. Open it. You see which agent is asking, why, the website, and the time left. Choose **Approve & open** or **Decline**.
3. If the page has a standard login form, Keep Safe opens **Sign-in form** first: native username/email and password fields that work with your phone's password manager and passkey-locked saved logins, plus a **Copy site** button for quick lookup. Tap **Sign in** and the bridge types your details into the browser with real keystrokes (including two-step Email → Password flows).
4. If the site asks for a verification code, Keep Safe switches to a two-factor code card with one-time-code autofill. For push approvals, CAPTCHAs, or OAuth pickers, switch to **Live browser** (or Keep Safe switches automatically).
5. Choose **Done, hand back**. Keep Safe clears any password fields still on the page and gives the browser back to the agent.

**End session** declines the request instead. The agent is told it was denied.

## The live view

The top bar shows the website address, the time left, a details button and a full-screen button. Tap the address to see it in full with its scheme and port. Keep Safe warns you when the page moves to a different address, so check it before typing a password.

The full-screen button fills the screen and, where the browser allows it, hides the browser's own bars. In the installed app the view already fills the screen.

The page takes your finger the way a phone browser does. **Tap** clicks, and a ring shows where the tap landed. **Swipe** scrolls with momentum, including nested panels and embedded pages. **Drag** moves sliders, carousels and drag puzzles such as captchas. **Press and hold** is a long press on the page.

**Pinch with two fingers** to zoom the view, and move two fingers to pan it. The zoom is on your phone only: the website is not zoomed, and one finger still touches the page where it shows. **Reset zoom** appears in the corner while zoomed.

As in a phone browser, a tap while the page is still coasting from a flick only stops the coasting. Tap again to click.

On a computer, the mouse hovers, clicks, drags and selects text, and the wheel or trackpad scrolls. A double click selects a word.

A bridge older than 0.4.0 takes taps and swipe scrolling only, without momentum or dragging. Update it with `keep-safe up`.

Managed browsers also have **Back**, **Forward** and **Reload** above the page. Reload never resends a form. Navigation clears unsent text and waits for a fresh image.

If the app goes to the background, viewing and input pause and unsent text is cleared. The website keeps running on your computer and the request keeps its deadline. When you return, choose **Resume browser**.

## Typing

Tap a text field on the page. Keep Safe sees that a field took focus and raises your phone's keyboard. Each character you type goes straight to the page. Nothing you type is kept on the phone, and the phone's keyboard does not learn or suggest it.

Some phones only open the keyboard after a direct touch. There the **Keyboard** button turns green and reads **Tap to type**. Tap it once. The keyboard then stays open while you move between fields.

While the keyboard is open the live view shrinks to the space above it and slides the page so the field you tapped stays visible. The Enter key on your keyboard presses Enter on the page. Number fields bring up the number pad.

With a hardware keyboard, click a field and type. Tab, Shift+Tab, Enter, Escape, the arrow keys and paste all go to the page.

## The browser dock

In **Live browser**, a single compact bottom row keeps the website front and centre:

- **Back**, **Forward**, and **Reload** (in managed browsers).
- **Keyboard**: live typing, described above.
- **Passwords**: opens the password-manager boxes and passkey-locked **Saved logins** straight away, highlighting when you tap an email or password field. Because Keep Safe runs on its own address rather than the website's domain, search the website's hostname shown in the panel if your password manager does not suggest a match automatically. Tap a field on the page, then **Send** the matching box (or press Go/Enter). Each box is emptied as it is sent, and both are emptied when you close **Passwords** or leave the app.
- **More (`⋯`)**: opens rare power-user tools when you need them — **Sign-in form**, **Paste**, **Type text**, **Select** and **Copy**, **More keys**, **Page controls**, plus **Tab**, **Enter**, **Backspace**, and scroll arrows.

## Windows

When the website opens another window, such as a Google or single sign-on popup, a strip of windows appears above the page with each window's title and site. Tap one to show it, or **×** to close it. The newest window shows by itself when it opens. The last window cannot be closed. The strip borrows space from the view without resizing the website.

If focus could not be confirmed, typing is held back until you tap the page, press Tab, or pick a control again. This stops text landing in the wrong field.

## Activity

Finished requests are listed with their outcome. **Export** saves the list as a file. **Clear finished history** removes entries past their deadline. History holds request details only. Passwords, cookies and browser images are never part of it. Entries also clear by themselves 24 hours after their deadline, and when Keep Safe restarts.

## Connect

Shows the computer you are paired with, its address, and the phones paired with it. **Pair again** opens the scanner and code entry. **Forget this phone** removes this phone's key. **Revoke** removes another phone. The card at the bottom has the setup prompt for another computer.

If the app shows **Looking for your computer**, the computer is asleep, Keep Safe is not running there, or its address changed after a restart. With notifications on, the next request brings the new address and the app reconnects. Otherwise choose **Scan new code** and scan the code from `keep-safe pair`. Your phone keeps its place in the list.

**Update pairing** connects with an owner token. It is for advanced setups and for older bridges that have no pairing codes.

## Saved logins

Open **Passwords** during a sign-in. Fill the two boxes, by hand or with your password manager, and choose **Save to this phone**. The first time, your phone asks you to make a passkey called "Keep Safe saved logins".

The next time you sign in to that site, open **Passwords** and choose **Unlock with passkey**. Tap the email field on the page, choose **Fill**, then tap the password field and choose **Fill** again. Each opening of **Passwords** asks for your face, fingerprint or screen lock once. Closing the panel, leaving the request, switching apps or two minutes passing locks it again.

- A login fills only on the exact site it was saved for: scheme, host and port. A password goes only into a field the page reports as a password field. Anything else gets the username.
- The values are encrypted on the phone with a key that only your passkey can unlock (WebAuthn PRF). Keep Safe's computer and website never store them. The computer sees a value only as typing into the page, the same as when you type it, and your agent never receives it. Password fields are cleared before the handback as usual.
- In the Google sign-in, Keep Safe cannot read the address, so a login matches the site the agent asked for. Check Chrome's address bar in the picture before filling.
- Saved logins belong to this phone and the address the app was opened at. Clearing the browser's site data removes them, and Safari may clear the data of a site you have not opened for seven days unless the app is on your Home Screen. **Settings → Saved logins** lists the sites and can delete one or forget them all.
- The phone's browser needs passkeys with the PRF extension: recent Chrome on Android, Safari on iOS 18 or later. Elsewhere **Passwords** works as before, without saving. Not yet checked on a physical phone.

## Settings

Turn notifications on or off, check that this phone is enrolled with the current computer, install the app where the browser offers it, and manage saved logins.

## Demo

**Try the demo** on the welcome screen opens sample requests. Nothing in the demo is real and no browser is connected. Never enter real credentials there.

## What does not transfer

Your phone's passkeys, biometrics and hardware security keys do not move into the remote browser. Saved passwords come across through **Passwords**, **Saved logins** or **Paste**. Whether your password manager offers to fill the **Passwords** boxes depends on the manager and the phone, and has not been checked on a physical phone. Websites that require a passkey on the signing-in device need their own cross-device flow.
