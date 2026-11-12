# The phone app

Keep Safe on the phone has four tabs: **Inbox**, **Activity**, **Connect** and **Settings**. This guide walks through a request and then covers each tool.

## A request from start to finish

1. An agent asks for a sign-in. The request appears in **Inbox**, with a notification if you turned those on.
2. Open it. You see which agent is asking, why, the website, and the time left. Choose **Approve & open** or **Decline**.
3. The live view opens full screen. The browser on your computer is sized to your phone, so the website shows its mobile layout.
4. Sign in. Tap to click, swipe to scroll, tap a field and type.
5. Choose **Done, hand back**. Keep Safe clears any password fields still on the page and gives the browser back to the agent.

**End session** declines the request instead. The agent is told it was denied.

## The live view

The top bar shows the website address, the time left, a details button and a full-screen button. Tap the address to see it in full with its scheme and port. Keep Safe warns you when the page moves to a different address, so check it before typing a password.

The full-screen button fills the screen and, where the browser allows it, hides the browser's own bars. In the installed app the view already fills the screen.

**Tap** clicks. A ring shows where the tap landed. **Swipe** inside the page scrolls it, including nested panels and embedded pages. Pinch zoom belongs to your phone's browser and is not sent to the website.

Managed browsers also have **Back**, **Forward** and **Reload** above the page. Reload never resends a form. Navigation clears unsent text and waits for a fresh image.

If the app goes to the background, viewing and input pause and unsent text is cleared. The website keeps running on your computer and the request keeps its deadline. When you return, choose **Resume browser**.

## Typing

Tap a text field on the page. Keep Safe sees that a field took focus and raises your phone's keyboard. Each character you type goes straight to the page. Nothing you type is kept on the phone, and the phone's keyboard does not learn or suggest it.

Some phones only open the keyboard after a direct touch. There the **Keyboard** button turns green and reads **Tap to type**. Tap it once. The keyboard then stays open while you move between fields.

While the keyboard is open the live view shrinks to the space above it and slides the page so the field you tapped stays visible. The Enter key on your keyboard presses Enter on the page. Number fields bring up the number pad.

With a hardware keyboard, click a field and type. Tab, Shift+Tab, Enter, Escape, the arrow keys and paste all go to the page.

## The tool row

Swipe the row sideways to see everything.

- **Keyboard**: live typing, described above.
- **Type text**: a box for pasted or longer text, sent in one go with **Send**. Use it to paste from a password manager. **Show text** reveals what you entered before sending.
- **More keys**: Space, Escape, Shift+Tab, arrow keys, Home, End, Page Up, Page Down, Delete and Select all.
- **Page controls**: a list of the page's labelled fields and buttons. Choose one to focus it. This helps when a control is hard to tap. Field values and link addresses are never read. The list covers the main page, open web components and supported embedded pages, each with its origin.
- **Tab**, **Enter**, **Backspace**, and scroll up and down.

If focus could not be confirmed, typing is held back until you tap the page, press Tab, or pick a control again. This stops text landing in the wrong field.

## Activity

Finished requests are listed with their outcome. **Export** saves the list as a file. **Clear finished history** removes entries past their deadline. History holds request details only. Passwords, cookies and browser images are never part of it. Entries also clear by themselves 24 hours after their deadline, and when Keep Safe restarts.

## Connect

Shows the computer you are paired with, its address, and the phones paired with it. **Pair again** opens the scanner and code entry. **Forget this phone** removes this phone's key. **Revoke** removes another phone. The card at the bottom has the setup prompt for another computer.

**Update pairing** connects with an owner token. It is for advanced setups and for older bridges that have no pairing codes.

## Settings

Turn notifications on or off, check that this phone is enrolled with the current computer, and install the app where the browser offers it.

## Demo

**Try the demo** on the welcome screen opens sample requests. Nothing in the demo is real and no browser is connected. Never enter real credentials there.

## What does not transfer

Your phone's passkeys, biometrics, hardware security keys and saved passwords do not move into the remote browser by themselves. You can paste a saved password with **Type text**. Websites that require a passkey on the signing-in device need their own cross-device flow.
