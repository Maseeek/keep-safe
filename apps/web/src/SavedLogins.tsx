import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Fingerprint, KeyRound, LoaderCircle, LockKeyhole, Trash2 } from "lucide-react";
import type { ClientMessage, EditableKind } from "../../../packages/shared/src/protocol";
import {
  browserAuthenticator, createVault, deleteLogin, forgetVault, hasVault, listLogins, loginsFor, readLogin, saveLogin, unlockVault,
  vaultSupport, VaultError, type UnlockedVault, type VaultEntrySummary,
} from "./vault";

const authenticator = browserAuthenticator();

/** An unlocked vault lasts while the Passwords panel is open, and at most this long. */
const unlockedFor = 120_000;
const host = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };
const message = (error: unknown) => error instanceof VaultError ? error.message : "Saved logins are unavailable in this browser.";

interface Props {
  /** The site the live page is on, or the request's site when the address is only in the picture. */
  origin: string | null;
  addressInView: boolean;
  /** What the owner last tapped on this page: null when nothing editable, or the tap is older than the page. */
  field: EditableKind | null;
  canSend: boolean;
  /** Sends to the live page. Returns false when nothing was sent. */
  send: (message: ClientMessage) => boolean;
  /** What a password manager put in the two boxes, for saving. */
  boxes: () => { username: string; password: string };
  onNotice: (text: string) => void;
  /** The password manager boxes, shown between filling and saving. */
  children: ReactNode;
}

/**
 * Logins saved on this phone, inside the Passwords panel. Each opening of the
 * panel needs one passkey approval; closing it, leaving the sign-in or hiding
 * the app forgets the key. A password is decrypted only to be typed, and only
 * into a field the page reports as a password field.
 */
export function SavedLogins({ origin, addressInView, field, canSend, send, boxes, onNotice, children }: Props) {
  const [support, setSupport] = useState<"yes" | "no" | "maybe" | null>(null);
  const [entries, setEntries] = useState<VaultEntrySummary[]>(() => loginsFor(origin));
  const [unlocked, setUnlocked] = useState<UnlockedVault | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; void vaultSupport().then(value => { if (live.current) setSupport(value); }); return () => { live.current = false; }; }, []);
  const refresh = useCallback(() => setEntries(loginsFor(origin)), [origin]);
  // A different site, or a different page on it, is a new decision.
  useEffect(() => { refresh(); setUnlocked(null); setNames({}); }, [origin, refresh]);
  useEffect(() => {
    if (!unlocked) return;
    const timer = setTimeout(() => { setUnlocked(null); setNames({}); }, unlockedFor);
    return () => clearTimeout(timer);
  }, [unlocked]);

  const unlock = async (): Promise<UnlockedVault> => {
    if (unlocked) return unlocked;
    const vault = hasVault() ? await unlockVault(authenticator) : await createVault(authenticator);
    const shown: Record<string, string> = {};
    for (const entry of loginsFor(origin)) shown[entry.id] = (await readLogin(vault, entry.id).catch(() => null))?.username ?? "";
    if (live.current) { setUnlocked(vault); setNames(shown); }
    return vault;
  };
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await task(); } catch (reason) { if (live.current) setError(message(reason)); }
    finally { if (live.current) setBusy(false); }
  };

  const fill = (entry: VaultEntrySummary) => run(async () => {
    const vault = await unlock();
    if (!field || !canSend) { onNotice("Tap the field on the page first."); return; }
    const login = await readLogin(vault, entry.id);
    // The origin is part of what decrypts the entry; check it is still this page's.
    if (login.origin !== origin) throw new VaultError("This login is for another website.", "damaged");
    const wantsPassword = field === "password";
    const value = wantsPassword ? login.password : login.username;
    if (!value) { onNotice(wantsPassword ? "This saved login has no password." : "This saved login has no username. Tap the password field."); return; }
    // Replace what the field holds, as a password manager does.
    if (send({ type: "key", key: "ControlOrMeta+A" }) && send({ type: "text", text: value.slice(0, 4096) })) onNotice(wantsPassword ? `Password for ${host(entry.origin)} filled.` : "Username filled. Tap the password field next.");
  });
  const saveBoxes = () => run(async () => {
    const { username, password } = boxes();
    if (!origin) throw new VaultError("This page has no website address to save a login for.", "damaged");
    if (!password) { onNotice("Put the password in the Password box first."); return; }
    const vault = await unlock();
    await saveLogin(vault, origin, { username, password });
    refresh();
    if (live.current) setNames(previous => ({ ...previous, ...Object.fromEntries(loginsFor(origin).map(entry => [entry.id, previous[entry.id] ?? username])) }));
    onNotice(`Saved on this phone for ${host(origin)}.`);
  });

  const site = origin ? host(origin) : "this page";
  const fieldHint = !field ? "Tap a field on the page, then fill it." : field === "password" ? "Fills the password field you tapped." : "Fills the field you tapped with the username.";
  const unavailable = support === "no";
  return (
    <>
      {unavailable ? null : (
        <div className="saved-logins" aria-busy={busy}>
          <div className="saved-logins-head">
            <LockKeyhole size={15} aria-hidden="true" />
            <strong>Saved on this phone for {site}</strong>
          </div>
          {addressInView && entries.length ? <p className="saved-logins-note">Check that Chrome’s address bar in the picture shows {site} before filling.</p> : null}
          {entries.length === 0 ? <p className="saved-logins-note">Nothing saved yet. Fill the boxes below, then save them.</p> : !unlocked ? (
            <button className="button button-dark button-small" type="button" disabled={busy} onClick={() => { void run(async () => { await unlock(); }); }}>
              {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Fingerprint size={16} aria-hidden="true" />}
              Unlock with passkey
            </button>
          ) : (
            <>
              <p className="saved-logins-note">{fieldHint}</p>
              <ul className="saved-login-list">
                {entries.map(entry => (
                  <li key={entry.id}>
                    <span>{names[entry.id] || "No username"}</span>
                    <button className="button button-dark button-small" type="button" disabled={busy || !canSend || !field}
                      aria-label={`Fill ${field === "password" ? "password" : "username"} for ${names[entry.id] || site}`} onClick={() => { void fill(entry); }}>
                      <KeyRound size={14} aria-hidden="true" /> Fill
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error ? <p className="saved-logins-error" role="alert">{error}</p> : null}
        </div>
      )}
      {children}
      {unavailable ? <small>Saving logins needs a phone passkey, which this browser does not offer.</small> : (
        <>
          <button className="button button-light button-small" type="button" disabled={busy || !origin} onClick={() => { void saveBoxes(); }}>
            Save to this phone
          </button>
          <small>Saved logins are encrypted on this phone and open with your passkey. Keep Safe’s computer and website never store them, and your agent never receives them.</small>
        </>
      )}
    </>
  );
}

/** The Settings card: which sites have saved logins, and how to remove them. */
export function SavedLoginsSettings() {
  const [entries, setEntries] = useState<VaultEntrySummary[]>(() => { try { return listLogins(); } catch { return []; } });
  const [present, setPresent] = useState(() => hasVault());
  const [confirming, setConfirming] = useState(false);
  const reload = () => { try { setEntries(listLogins()); } catch { setEntries([]); } setPresent(hasVault()); };
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (!event.key || event.key.startsWith("keep-safe.vault")) reload(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return (
    <section className="content-card settings-card">
      <div className="settings-card-head"><span className="settings-section-icon"><LockKeyhole size={20} aria-hidden="true" /></span><h2>Saved logins</h2></div>
      <p>Logins you save during a sign-in are encrypted on this phone and open only with your passkey. You approve every use, and only a password field on the same website can receive one.</p>
      {entries.length ? (
        <ul className="saved-login-list">
          {entries.map(entry => (
            <li key={entry.id}>
              <span>{host(entry.origin)}</span>
              <button className="icon-button" type="button" aria-label={`Delete saved login for ${host(entry.origin)}`} onClick={() => { deleteLogin(entry.id); reload(); }}><Trash2 size={16} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      ) : <p className="settings-note">{present ? "No logins saved yet." : "Nothing saved. Open Passwords during a sign-in to save one."}</p>}
      {present ? (
        <div className="notification-actions">
          {confirming ? <>
            <button className="button button-dark" onClick={() => { forgetVault(); setConfirming(false); reload(); }}>Forget all saved logins</button>
            <button className="button button-light" onClick={() => setConfirming(false)}>Keep them</button>
          </> : <button className="button button-light" onClick={() => setConfirming(true)}>Forget saved logins…</button>}
        </div>
      ) : null}
      <p className="settings-note">Saved logins stay on this phone in this app. Clearing the browser’s site data removes them. The passkey stays in your phone’s passkey list as “Keep Safe saved logins”; you can delete it there after forgetting.</p>
    </section>
  );
}
