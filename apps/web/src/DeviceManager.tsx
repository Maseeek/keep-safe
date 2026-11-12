import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import type { PairedDevice } from "../../../packages/shared/src/protocol";
import type { Workspace } from "./workspace";

function expiryLabel(expiresAt: string) {
  return new Date(expiresAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DeviceConfirm({
  device,
  current,
  busy,
  onCancel,
  onConfirm,
}: {
  device: PairedDevice;
  current: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="connect-dialog device-confirm-dialog"
      aria-labelledby="device-confirm-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onCancel();
      }}
    >
      <button
        className="icon-button dialog-close"
        aria-label="Close confirmation"
        onClick={onCancel}
        disabled={busy}
      >
        <X size={19} />
      </button>
      <div className="dialog-icon">
        <Smartphone size={27} />
      </div>
      <h2 id="device-confirm-title">
        {current ? "Forget this phone?" : `Revoke ${device.name}?`}
      </h2>
      <p>
        {current
          ? "This phone’s saved key will be removed immediately. We’ll also revoke its access on your computer. You’ll need a fresh pairing link to connect again."
          : "This device will lose access to your bridge, open sessions, and notifications. It will need a fresh pairing link to connect again."}
      </p>
      <div className="device-confirm-actions">
        <button
          autoFocus
          className="button button-light"
          disabled={busy}
          onClick={onCancel}
        >
          Keep access
        </button>
        <button
          className="button button-danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Trash2 size={14} />
          )}
          {current ? "Forget this phone" : "Revoke access"}
        </button>
      </div>
    </dialog>
  );
}

export function DeviceManager({
  workspace,
  notify,
  notificationForRemember,
}: {
  workspace: Workspace;
  notify: (message: string) => void;
  notificationForRemember?: (connection: NonNullable<Workspace["connection"]>) => Promise<PushSubscriptionJSON | undefined>;
}) {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("My phone");
  const [rememberOpen, setRememberOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PairedDevice | null>(null);
  const connection = workspace.connection;
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const pendingRemember = useRef<AbortController | null>(null);
  useEffect(() => () => pendingRemember.current?.abort(), []);
  const api = workspace.api;
  const load = useCallback(async () => {
    if (!connection) {
      setDevices([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api<{ devices: PairedDevice[] }>("/api/devices");
      setDevices(result.devices);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load remembered devices.",
      );
    } finally {
      setLoading(false);
    }
  }, [connection, api]);
  useEffect(() => {
    setDevices([]);
    setError("");
    setRememberOpen(false);
  }, [connection?.url, connection?.token]);
  useEffect(() => {
    if (workspace.status === "connected") void load();
  }, [workspace.status, load]);
  if (!connection) return null;
  const currentDevice = connection.device;

  const remember = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const pending = new AbortController();
    pendingRemember.current?.abort();
    pendingRemember.current = pending;
    try {
      const notificationSubscription = await notificationForRemember?.(connection);
      if (pending.signal.aborted || currentConnection.current !== connection) throw new Error("The pairing changed. Check this phone’s connection before remembering it.");
      await workspace.connect(connection, { remember: true, name, notificationSubscription, signal: pending.signal });
      setRememberOpen(false);
      notify(
        "Phone remembered for 7 days. Your owner token was replaced by a revocable device key.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not remember this phone.",
      );
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.id === currentDevice?.id) {
        const revoked = await workspace.forgetDevice();
        notify(
          revoked
            ? "This phone was forgotten and its access was revoked."
            : "Saved key removed from this phone. Revocation could not be confirmed. Revoke this phone from another connected device.",
        );
      } else {
        await api(`/api/devices/${encodeURIComponent(pending.id)}/revoke`, {
          method: "POST",
          body: "{}",
        });
        notify(`${pending.name} no longer has access.`);
        await load();
      }
      setPending(null);
    } catch (reason) {
      notify(
        reason instanceof Error
          ? reason.message
          : "Could not revoke this device. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="content-card paired-devices-card"
      aria-labelledby="paired-devices-title"
    >
      <div className="section-title">
        <h2 id="paired-devices-title">Phone access</h2>
        <button
          className="icon-button"
          aria-label="Refresh paired devices"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
      </div>
      <div
        className={`local-pairing-state ${currentDevice ? "is-remembered" : ""}`}
      >
        <span className="device-state-icon">
          <Smartphone size={23} strokeWidth={1.4} />
        </span>
        <div>
          <strong>
            {currentDevice
              ? `${currentDevice.name} is remembered`
              : "This connection lasts for this tab"}
          </strong>
          <p>
            {currentDevice
              ? `Reconnect automatically until ${expiryLabel(currentDevice.expiresAt)}. Only this device key is saved on your phone.`
              : "Close this tab and you’ll need to pair again. Remember this phone to open notifications in a fresh app window."}
          </p>
        </div>
        {currentDevice ? (
          <button
            className="button button-light button-small"
            onClick={() => setPending(currentDevice)}
          >
            <Trash2 size={13} />
            Forget this phone
          </button>
        ) : (
          <button
            className="button button-dark button-small"
            onClick={() => setRememberOpen(!rememberOpen)}
            disabled={busy}
            aria-expanded={rememberOpen}
          >
            Remember this phone <ArrowRight size={13} />
          </button>
        )}
      </div>
      {rememberOpen && !currentDevice ? (
        <form className="remember-device-form" onSubmit={remember}>
          <label htmlFor="remember-device-name">Name this phone</label>
          <div>
            <input
              autoFocus
              id="remember-device-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              required
              placeholder="My phone"
            />
            <button
              className="button button-dark button-small"
              type="submit"
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              Keep this phone paired
            </button>
          </div>
          <p>
            <ShieldCheck size={12} />
            Save a separate device key on this trusted phone. Your master owner
            token is removed from this tab after pairing.
          </p>
        </form>
      ) : null}
      {error ? (
        <p className="device-list-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="device-list-heading">
        <span>PAIRED PHONES</span>
        <span>{devices.length}</span>
      </div>
      {loading && !devices.length ? (
        <p className="device-list-message">
          <LoaderCircle className="spin" size={14} />
          Checking device access…
        </p>
      ) : devices.length ? (
        <div className="paired-device-list">
          {devices.map((device) => {
            const current = device.id === currentDevice?.id || device.current;
            return (
              <div className="paired-device-row" key={device.id}>
                <span className="paired-device-icon">
                  <Smartphone size={19} strokeWidth={1.5} />
                </span>
                <div>
                  <strong>
                    {device.name}
                    {current ? <span>This phone</span> : null}
                  </strong>
                  <p>
                    <Clock3 size={11} />
                    Expires {expiryLabel(device.expiresAt)}
                  </p>
                </div>
                <button
                  className="text-link device-revoke"
                  aria-label={`${current ? "Forget" : "Revoke"} ${device.name}`}
                  onClick={() => setPending(device)}
                >
                  {current ? "Forget" : "Revoke"}
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : !error ? (
        <p className="device-list-message">
          No phones remembered yet. Tab-only connections are never added here.
        </p>
      ) : null}
      <p className="device-access-note">
        <ShieldCheck size={13} />
        A phone stays paired while you use it and for 30 days after. Revoking
        one also ends its live browser control and phone notifications.
      </p>
      {pending ? (
        <DeviceConfirm
          device={pending}
          current={pending.id === currentDevice?.id}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void revoke()}
        />
      ) : null}
    </section>
  );
}
