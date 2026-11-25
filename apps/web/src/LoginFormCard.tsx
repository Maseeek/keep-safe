import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  Globe,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import type { FormState, FormSubmitValue } from "../../../packages/shared/src/protocol";
import {
  browserAuthenticator,
  createVault,
  hasVault,
  loginOrigin,
  loginsFor,
  readLogin,
  saveLogin,
  unlockVault,
  vaultSupport,
  VaultError,
  type UnlockedVault,
  type VaultEntrySummary,
} from "./vault";

const authenticator = browserAuthenticator();
const unlockedForMs = 120_000;
const hostOf = (origin: string) => {
  try { return new URL(origin).host; } catch { return origin; }
};

interface Props {
  formState: FormState;
  requestUrl: string;
  addressInView: boolean;
  busy: boolean;
  disabled: boolean;
  onSubmit: (values: FormSubmitValue[], expectedOrigin?: string) => Promise<{ ok: boolean; message?: string; state?: FormState }>;
  onOpenBrowser: () => void;
  onHandBack: () => void;
  onFocusForm?: () => void;
  onBlurForm?: (event: React.FocusEvent<HTMLFormElement>) => void;
}

/**
 * Form-first sign-in card. Renders standard visible HTML login/OTP forms so
 * mobile password managers (including Android / Pixel 7 Gboard autofill and
 * iOS AutoFill) surface reliably, and pairs them with 1-tap passkey vault fill.
 * Secret values stay strictly in uncontrolled DOM inputs and are wiped on
 * submit, navigation, hide, or unmount.
 */
export function LoginFormCard({
  formState,
  requestUrl,
  addressInView,
  busy,
  disabled,
  onSubmit,
  onOpenBrowser,
  onHandBack,
  onFocusForm,
  onBlurForm,
}: Props) {
  const origin = formState.origin || loginOrigin(requestUrl) || "";
  const siteHost = origin ? hostOf(origin) : requestUrl;
  const expectedOrigin = addressInView ? undefined : (formState.origin || undefined);

  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);

  const [showPassword, setShowPassword] = useState(false);
  const [saveToVault, setSaveToVault] = useState(false);
  const [copiedSite, setCopiedSite] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [support, setSupport] = useState<"yes" | "no" | "maybe" | null>(null);
  const [entries, setEntries] = useState<VaultEntrySummary[]>(() => loginsFor(origin || null));
  const [unlocked, setUnlocked] = useState<UnlockedVault | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [vaultBusy, setVaultBusy] = useState(false);
  const live = useRef(true);

  const clearInputs = useCallback(() => {
    if (usernameRef.current) usernameRef.current.value = "";
    if (passwordRef.current) passwordRef.current.value = "";
    if (otpRef.current) otpRef.current.value = "";
    setShowPassword(false);
  }, []);

  useEffect(() => {
    live.current = true;
    void vaultSupport().then(value => { if (live.current) setSupport(value); });
    return () => { live.current = false; clearInputs(); };
  }, [clearInputs]);

  useEffect(() => {
    setEntries(loginsFor(origin || null));
    setUnlocked(null);
    setNames({});
    setError("");
    setNotice("");
    clearInputs();
  }, [origin, formState.stage, clearInputs]);

  useEffect(() => {
    if (!unlocked) return;
    const timer = setTimeout(() => { setUnlocked(null); setNames({}); }, unlockedForMs);
    return () => clearTimeout(timer);
  }, [unlocked]);

  useEffect(() => {
    const clearOnHide = () => {
      clearInputs();
      setUnlocked(null);
      setNames({});
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") clearOnHide(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", clearOnHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", clearOnHide);
    };
  }, [clearInputs]);

  const copySiteHost = async () => {
    try {
      await navigator.clipboard.writeText(siteHost);
      setCopiedSite(true);
      setTimeout(() => { if (live.current) setCopiedSite(false); }, 2500);
    } catch {
      setNotice(`Search "${siteHost}" in your password manager.`);
    }
  };

  const pasteOtp = async () => {
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) { setNotice("Clipboard is empty."); return; }
      if (otpRef.current) {
        otpRef.current.value = value.slice(0, 32);
        otpRef.current.focus({ preventScroll: true });
      }
      setError("");
    } catch {
      setNotice("Tap the code box and paste from your keyboard.");
      otpRef.current?.focus({ preventScroll: true });
    }
  };

  const runVaultSignIn = async (entryId?: string) => {
    if (busy || vaultBusy || disabled) return;
    setVaultBusy(true);
    setError("");
    setNotice("");
    try {
      const vault = unlocked ?? await unlockVault(authenticator);
      const matching = loginsFor(origin || null);
      if (matching.length === 0) throw new VaultError("No saved login for this site.", "missing");
      if (!entryId && matching.length > 1) {
        const loaded: Record<string, string> = {};
        for (const item of matching) loaded[item.id] = (await readLogin(vault, item.id).catch(() => null))?.username ?? "";
        if (live.current) { setUnlocked(vault); setNames(loaded); }
        return;
      }
      const chosen = entryId ?? matching[0].id;
      const login = await readLogin(vault, chosen);
      if (login.origin !== origin) throw new VaultError("This login belongs to another website.", "damaged");
      const values: FormSubmitValue[] = [];
      if (login.username) values.push({ kind: "email", value: login.username });
      if (login.password) values.push({ kind: "password", value: login.password });
      if (values.length === 0) throw new VaultError("This saved login has no values.", "damaged");
      const result = await onSubmit(values, expectedOrigin);
      if (live.current && !result.ok && result.message) setError(result.message);
    } catch (reason) {
      if (live.current) setError(reason instanceof VaultError ? reason.message : "Could not unlock saved login.");
    } finally {
      if (live.current) setVaultBusy(false);
    }
  };

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || vaultBusy || disabled) return;
    const username = usernameRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    const values: FormSubmitValue[] = [];
    if (username) values.push({ kind: wantsEmail ? "email" : "username", value: username });
    if (password) values.push({ kind: "password", value: password });
    if (values.length === 0) {
      setError("Enter your sign-in details or use your password manager.");
      return;
    }
    setError("");
    setNotice("");
    clearInputs();
    if (saveToVault && origin && password && support !== "no") {
      try {
        const vault = unlocked ?? (hasVault() ? await unlockVault(authenticator) : await createVault(authenticator));
        await saveLogin(vault, origin, { username, password });
        if (live.current) setEntries(loginsFor(origin));
      } catch {
        // Saving to vault is optional; still proceed with sign-in.
      }
    }
    const result = await onSubmit(values, expectedOrigin);
    if (live.current && !result.ok && result.message) setError(result.message);
  };

  const submitOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || disabled) return;
    const code = otpRef.current?.value.trim() ?? "";
    if (!code) { setError("Enter the verification code."); return; }
    setError("");
    setNotice("");
    clearInputs();
    const result = await onSubmit([{ kind: "otp", value: code }], expectedOrigin);
    if (live.current && !result.ok && result.message) setError(result.message);
  };

  const wantsEmail = formState.fields.some(field => field.kind === "email") || !formState.fields.some(field => field.kind === "username");
  const passwordOnlyStep = formState.fields.length === 1 && formState.fields[0].kind === "password";
  const userLabel = formState.fields.find(field => field.kind === "email" || field.kind === "username")?.label || (wantsEmail ? "Email" : "Username or email");
  const passLabel = formState.fields.find(field => field.kind === "password")?.label || "Password";
  const otpLabel = formState.fields.find(field => field.kind === "otp")?.label || "Verification code";

  if (formState.stage === "signed-in") {
    return (
      <div className="guided-card guided-signed-in" aria-live="polite">
        <div className="state-emblem guided-success-emblem"><CheckCheck size={28} aria-hidden="true" /></div>
        <h3>Looks like you’re signed in</h3>
        <p>{formState.hint || "You can check the live browser first, or hand control back to your agent."}</p>
        <div className="guided-card-actions">
          <button type="button" className="button button-accent button-large" disabled={disabled || busy} onClick={onHandBack}>
            <CheckCheck size={18} aria-hidden="true" /> Done, hand back
          </button>
          <button type="button" className="button button-light" onClick={onOpenBrowser}>
            <Globe size={16} aria-hidden="true" /> Check live browser
          </button>
        </div>
      </div>
    );
  }

  if (formState.stage === "otp") {
    return (
      <div className="guided-card">
        <div className="guided-card-head">
          <span className="guided-site-pill"><ShieldCheck size={14} aria-hidden="true" /> {siteHost}</span>
          <h3>Two-factor verification</h3>
          <p>{formState.hint || "Enter the code from your SMS, email, or authenticator app."}</p>
        </div>
        <form className="guided-login-form" method="post" action="#verify" autoComplete="on" onFocus={onFocusForm} onBlur={onBlurForm} onSubmit={event => { void submitOtp(event); }}>
          <label htmlFor="guided-otp">{otpLabel}</label>
          <div className="input-with-button">
            <input
              ref={otpRef}
              id="guided-otp"
              name="one-time-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9A-Za-z -]*"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              placeholder="123456"
              disabled={busy || disabled}
            />
            <button type="button" className="button button-light button-small" disabled={busy || disabled} onClick={() => { void pasteOtp(); }}>
              <ClipboardPaste size={15} aria-hidden="true" /> Paste
            </button>
          </div>
          {error ? <p className="guided-error" role="alert">{error}</p> : null}
          {notice ? <p className="guided-note" role="status">{notice}</p> : null}
          <button type="submit" className="button button-dark button-large" disabled={busy || disabled}>
            {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>
        <button type="button" className="button button-quiet guided-switch-link" onClick={onOpenBrowser}>
          <Globe size={15} aria-hidden="true" /> Switch to live browser (push approval or resend)
        </button>
      </div>
    );
  }

  return (
    <div className="guided-card">
      <div className="guided-card-head">
        <span className="guided-site-pill">
          <LockKeyhole size={13} aria-hidden="true" />
          {addressInView ? `Sign in (${siteHost})` : siteHost}
        </span>
        <h3>Sign in to {siteHost}</h3>
        {addressInView ? (
          <p className="guided-warn">Check Chrome’s address bar in the live browser if you want to verify the exact URL first.</p>
        ) : (
          <p>Typed directly into the browser on your computer. Your agent never sees your password.</p>
        )}
      </div>

      {support !== "no" && entries.length > 0 ? (
        <div className="guided-vault-box">
          {!unlocked ? (
            <button type="button" className="button button-accent button-large" disabled={busy || vaultBusy || disabled} onClick={() => { void runVaultSignIn(); }}>
              {vaultBusy || busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <Fingerprint size={18} aria-hidden="true" />}
              {entries.length === 1 ? "Unlock with passkey & sign in" : `Unlock ${entries.length} saved logins`}
            </button>
          ) : (
            <ul className="saved-login-list">
              {entries.map(entry => (
                <li key={entry.id}>
                  <span>{names[entry.id] || siteHost}</span>
                  <button type="button" className="button button-accent button-small" disabled={busy || vaultBusy || disabled} onClick={() => { void runVaultSignIn(entry.id); }}>
                    <KeyRound size={14} aria-hidden="true" /> Sign in
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="guided-pm-bar">
        <span>Use your phone’s password manager above the keyboard — search <strong>{siteHost}</strong></span>
        <button type="button" className="button button-light button-small" onClick={() => { void copySiteHost(); }}>
          {copiedSite ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copiedSite ? "Copied" : "Copy site"}
        </button>
      </div>

      {/* Standard login form semantics (method="post", both username + current-password
          mounted and visible) so Android / Pixel 7 Gboard and iOS AutoFill always
          surface the password manager strip on focus. */}
      <form
        className="guided-login-form"
        method="post"
        action="#sign-in"
        autoComplete="on"
        onFocus={onFocusForm}
        onBlur={onBlurForm}
        onSubmit={event => { void submitCredentials(event); }}
      >
        <div className={passwordOnlyStep ? "guided-field is-secondary" : "guided-field"}>
          <label htmlFor="guided-username">{passwordOnlyStep ? `${userLabel} (optional)` : userLabel}</label>
          <input
            ref={usernameRef}
            id="guided-username"
            name="username"
            type={wantsEmail ? "email" : "text"}
            inputMode={wantsEmail ? "email" : "text"}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder={wantsEmail ? "you@example.com" : "Username or email"}
            disabled={busy || disabled}
            onKeyDown={event => {
              if (event.key === "Enter" && passwordRef.current && !passwordRef.current.value) {
                event.preventDefault();
                passwordRef.current.focus({ preventScroll: true });
              }
            }}
          />
        </div>

        <div className="guided-field">
          <label htmlFor="guided-password">{passLabel}</label>
          <div className="input-with-button">
            <input
              ref={passwordRef}
              id="guided-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="Password"
              disabled={busy || disabled}
            />
            <button
              type="button"
              className="icon-button guided-eye"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword(value => !value)}
            >
              {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {support !== "no" && entries.length === 0 && origin ? (
          <label className="checkbox-label guided-save-check">
            <input type="checkbox" checked={saveToVault} onChange={event => setSaveToVault(event.target.checked)} disabled={busy || disabled} />
            Save login on this phone (passkey-locked)
          </label>
        ) : null}

        {error ? <p className="guided-error" role="alert">{error}</p> : null}
        {notice ? <p className="guided-note" role="status">{notice}</p> : null}

        <button type="submit" className="button button-dark button-large" disabled={busy || vaultBusy || disabled}>
          {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <button type="button" className="button button-quiet guided-switch-link" onClick={onOpenBrowser}>
        <Globe size={15} aria-hidden="true" /> Switch to live browser (CAPTCHA, Google sign-in, or OAuth)
      </button>
    </div>
  );
}
