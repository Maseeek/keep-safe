import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeInfo } from "../../../packages/shared/src/protocol";
import { BridgeError, callBridge, type Connection, type Workspace } from "./workspace";

type Phase = "unknown" | "checking" | "off" | "on" | "error";
interface Enrollment {
  connection: Connection | null;
  key?: string;
  phase: Phase;
  message: string;
  failed?: boolean;
  subscription?: PushSubscription;
}
class SetupError extends Error {}
const unavailable = "This browser does not support push. On iPhone, add Keep Safe to your Home Screen and open it there.";
const legacy = "This bridge cannot check notification enrollment. Enable again to register this browser.";
function supported() {
  return window.isSecureContext && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
}
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
}
function sameKey(subscription: PushSubscription, key: Uint8Array) {
  const existing = subscription.options.applicationServerKey;
  return !!existing && existing.byteLength === key.byteLength && new Uint8Array(existing).every((byte, index) => byte === key[index]);
}
async function registration() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SetupError("The notification service did not become ready. Reload this app and try again.")), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Browser subscription existence is distinct from this principal's bridge enrollment. */
export function useNotifications(workspace: Workspace, notify: (message: string) => void) {
  const { connection, api, status } = workspace;
  const key = workspace.info?.vapidPublicKey;
  const managed = workspace.info?.pushManagementAvailable === true;
  const push = workspace.info?.pushEnabled === true;
  const current = useRef({ connection, key, managed });
  current.current = { connection, key, managed };
  const attempt = useRef(0);
  const operation = useRef<Connection | null>(null);
  const [busyScope, setBusyScope] = useState<Connection | null>(null);
  const [state, setState] = useState<Enrollment>({ connection: null, phase: "unknown", message: "Pair your computer first to enable real notifications." });

  const refresh = useCallback(async () => {
    if (operation.current === connection && connection) return;
    const id = ++attempt.current;
    const valid = () => id === attempt.current && current.current.connection === connection && current.current.key === key;
    const update = (phase: Phase, message: string, subscription?: PushSubscription) => {
      if (valid()) setState({ connection, key, phase, message, subscription });
    };
    if (!connection) { update("unknown", "Pair your computer first to enable real notifications."); return; }
    if (status !== "connected") { update("unknown", "Connect to your computer to check notifications."); return; }
    if (!supported()) { update("off", unavailable); return; }
    if (!push || !key) { update("off", "Your bridge needs Web Push enabled before it can send notifications."); return; }
    if (!managed) { update("unknown", legacy); return; }
    update("checking", "Checking this computer’s notification enrollment…");
    try {
      const subscription = await (await registration()).pushManager.getSubscription();
      if (!valid()) return;
      if (Notification.permission !== "granted" || !subscription || !sameKey(subscription, keyBytes(key))) {
        update("off", "Notifications are off for this computer."); return;
      }
      const result = await api<{ enabled: boolean }>("/api/push/status", { method: "POST", body: JSON.stringify(subscription) });
      if (typeof result.enabled !== "boolean") throw new Error();
      update(result.enabled ? "on" : "off", result.enabled ? "Notifications are on for this computer." : "Notifications are off for this computer.", subscription);
    } catch { update("error", "Could not check this computer’s notification enrollment."); }
  }, [connection, key, managed, push, status, api]);

  useEffect(() => {
    operation.current = null;
    setBusyScope(null);
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      attempt.current++;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  async function change(enable: boolean) {
    if (!connection || status !== "connected") { notify("Connect your computer to manage real phone notifications."); return; }
    if (operation.current === connection) return;
    if (!supported()) { notify(unavailable); return; }
    if (!push || !key) { notify("Enable Web Push on your bridge first."); return; }
    if (!enable && !managed) { notify("Update your bridge to turn off notifications for this computer."); return; }
    const id = ++attempt.current;
    const valid = () => id === attempt.current && current.current.connection === connection && current.current.key === key;
    operation.current = connection;
    setBusyScope(connection);
    try {
      let subscription: PushSubscription | null | undefined;
      if (enable) {
        // Start the permission request directly in the button's user gesture.
        if (await Notification.requestPermission() !== "granted") throw new SetupError("Notifications were not enabled. You can change permission in your browser’s site settings.");
        if (!valid()) return;
        const ready = await registration();
        if (!valid()) return;
        subscription = await ready.pushManager.getSubscription();
        if (!valid()) return;
        const bytes = keyBytes(key);
        if (subscription && !sameKey(subscription, bytes)) {
          if (!window.confirm("Switch notifications to this computer? Alerts from other computers using this app in this browser will stop. Pairing and login access stay unchanged.")) {
            setState({ connection, key, phase: "off", message: "Notification key unchanged. Notifications are off for this computer." }); return;
          }
          if (!valid()) return;
          if (!await subscription.unsubscribe()) throw new SetupError("Could not replace the browser notification key. Check your browser’s site settings and try again.");
          if (!valid()) return;
          subscription = null;
        }
        subscription ??= await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      } else {
        subscription = state.connection === connection && state.key === key ? state.subscription : undefined;
        if (!subscription) throw new SetupError("Check notification status before turning notifications off.");
      }
      if (!valid()) return;
      await api(enable ? "/api/push/subscribe" : "/api/push/unsubscribe", { method: "POST", body: JSON.stringify(subscription) });
      if (!valid()) return;
      setState({ connection, key, phase: enable ? "on" : "off", message: enable ? "Notifications are on for this computer." : "Notifications are off for this computer.", subscription });
      notify(enable ? "Notification enrollment saved. Actual delivery depends on your phone and browser." : "Notifications from this computer are off. Browser permission is unchanged.");
      return true;
    } catch (error) {
      if (valid()) {
        const message = error instanceof SetupError || error instanceof BridgeError ? error.message : enable ? "Could not enable notifications. Check your connection and try again." : "Could not turn off notifications. Check your connection and try again.";
        // Preserve a confirmed enrollment after an unsuccessful disable so it can be retried.
        setState(previous => ({ ...(previous.connection === connection && previous.key === key ? previous : { connection, key, phase: "error" as const }), message, failed: true }));
        notify(message);
      }
    } finally {
      if (operation.current === connection && id === attempt.current) { operation.current = null; setBusyScope(null); }
    }
  }

  const view = state.connection === connection && state.key === key ? state : { phase: "unknown" as const, message: "Checking this computer’s notification enrollment…" };
  return {
    enabled: view.phase === "on", busy: !!connection && busyScope === connection,
    checking: view.phase === "checking", message: view.message, error: view.phase === "error" || ("failed" in view && view.failed === true),
    canCheck: !!connection && managed && push && status === "connected",
    canDisable: managed,
    forRemember: async (value: Connection): Promise<PushSubscriptionJSON | undefined> => {
      if (value.device || !supported() || Notification.permission !== "granted") return;
      // Read-only proof belongs to the explicit Remember action, including a
      // fresh tab. Never transfer enrollment merely because a connection changes.
      const subscription = await (await registration()).pushManager.getSubscription();
      if (!subscription) return;
      const info = await callBridge<BridgeInfo>(value, "/api/info");
      if (!info.pushManagementAvailable) return;
      const result = await callBridge<{ enabled: boolean }>(value, "/api/push/status", { method: "POST", body: JSON.stringify(subscription) });
      if (typeof result.enabled !== "boolean") throw new SetupError("Could not confirm notification enrollment. Check its status before remembering this phone.");
      if (result.enabled) return subscription.toJSON();
    },
    refresh, enable: () => change(true), disable: () => change(false),
  };
}
