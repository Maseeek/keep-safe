/** Public messages contain request metadata, never browser cookies or credentials. */
export type RequestStatus = 'pending' | 'approved' | 'active' | 'completed' | 'denied' | 'expired';

export interface LoginRequest {
  id: string;
  agent: string;
  title: string;
  url: string;
  origin: string;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface CreateRequestInput {
  agent: string;
  title: string;
  url: string;
  reason?: string;
  cdpUrl?: string;
  ttlSeconds?: number;
}

export interface BridgeInfo {
  name: string;
  version: string;
  browserAvailable: boolean;
  pushEnabled: boolean;
  pushManagementAvailable?: boolean;
  vapidPublicKey?: string;
  historyRetentionHours?: number;
  pageControlsAvailable?: boolean;
  navigationAvailable?: boolean;
  /** One-time pairing codes replace owner-token links for phone setup. */
  pairingCodesAvailable?: boolean;
  /** The browser view can match the phone and report typing targets. */
  liveViewAvailable?: boolean;
  /** Frames can arrive as binary messages, pushed as the page changes. */
  streamAvailable?: boolean;
  /** The owner can see and switch between the windows a sign-in opened. */
  tabsAvailable?: boolean;
  /** The owner can copy text they selected on the page to their own device. */
  selectionAvailable?: boolean;
  /** Shown to the owner so several computers are easy to tell apart. */
  computerName?: string;
  deviceLifetimeDays?: number;
}

/** The phone's usable screen area in CSS pixels. The bridge clamps every value. */
export interface ViewportRequest {
  width: number;
  height: number;
  scale?: number;
  touch?: boolean;
}

/** What the last tap or key left focused. Never includes a field value. */
export type EditableKind = 'text' | 'password' | 'email' | 'numeric' | 'tel' | 'url' | 'search';

export interface PairingCode {
  /** Eight characters, shown grouped as XXXX-XXXX. Single use. */
  code: string;
  expiresAt: string;
  /** What the phone opens or scans. Carries the code and this computer's address, never a key. */
  link?: string;
}

export type PairingState = 'waiting' | 'claimed' | 'expired';

export type NavigationDirection = 'back' | 'forward' | 'reload';

export interface PageControl {
  id: string;
  role: 'textbox' | 'button' | 'checkbox' | 'radio' | 'combobox' | 'link';
  name: string;
  protected: boolean;
  disabled: boolean;
  checked?: boolean;
  /** Present for a control inside an embedded HTTP(S) page; no path or query. */
  frameOrigin?: string;
  embedded?: boolean;
}

export interface PageControlsSnapshot {
  snapshotId: string;
  origin: string;
  controls: PageControl[];
  truncated: boolean;
}

export interface HistoryCleanupResult {
  removed: number;
  protected: number;
  requests: LoginRequest[];
}

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  current?: boolean;
}

export interface DevicePairResult {
  device: PairedDevice;
  /** Returned once; only the digest is retained by the bridge. */
  token: string;
}

/** One finger on the page. The website decides what a drag means, as it would
 * in a phone browser. `tap` marks a release the phone saw as a plain tap. */
export type TouchMessage = {
  type: 'touch'; phase: 'start' | 'move' | 'end' | 'cancel'; x: number; y: number; tap?: boolean;
  /** When the finger was there, in milliseconds on the phone's own clock. The
   * browser reads the finger's speed from these, so a flick keeps its
   * momentum even when the moves arrive bunched over a slow link. */
  t?: number;
};
/** A mouse or pen: hover, press, drag and release with the main button. */
export type MouseMessage = { type: 'mouse'; phase: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; tap?: boolean };

/** One window of the browser session. No path, query or page content. */
export interface BrowserTab {
  id: string;
  /** The page's own title, shortened. */
  title: string;
  /** Scheme and host only. Empty for a page that has no web address yet. */
  origin: string;
  active: boolean;
}

/** What every frame says about itself. Binary frames carry it as a header. */
export interface FrameHeader {
  type: 'frame';
  requestId: string;
  width: number;
  height: number;
  url: string;
  frameEpoch?: string;
  navigationAvailable?: boolean;
  /** This browser accepts `touch` and `mouse` messages. */
  gestures?: boolean;
}

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'watch'; requestId: string; viewport?: ViewportRequest; stream?: boolean }
  | TouchMessage
  | MouseMessage
  | { type: 'tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'copy-selection'; copyId: string }
  | { type: 'resize'; width: number; height: number }
  | { type: 'unwatch' }
  | { type: 'inspect-controls'; inspectionId: string; includeFrames?: boolean }
  | { type: 'focus'; snapshotId: string; controlId: string }
  | { type: 'navigate'; direction: NavigationDirection; navigationId: string }
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; deltaX: number; deltaY: number; x?: number; y?: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string };

export type ServerMessage =
  | { type: 'ready'; info: BridgeInfo; requests: LoginRequest[] }
  | { type: 'requests'; requests: LoginRequest[] }
  | (FrameHeader & { data: string })
  | { type: 'navigated'; requestId: string; navigationId: string; frameEpoch: string; ok: boolean; message?: string }
  | { type: 'controls'; requestId: string; inspectionId: string; snapshot: PageControlsSnapshot }
  | { type: 'focused'; requestId: string; snapshotId: string; controlId: string }
  | { type: 'editable'; requestId: string; editable: boolean; kind?: EditableKind }
  | { type: 'tabs'; requestId: string; tabs: BrowserTab[] }
  /** Text the owner selected on the page and asked for. Never a field's value. */
  | { type: 'selection'; requestId: string; copyId: string; text: string }
  | { type: 'error'; message: string };

/** A binary frame is a four-byte big-endian header length, the JSON
 * `FrameHeader`, then the JPEG. Sent only to clients that asked with
 * `watch.stream`. */
export const FRAME_HEADER_LIMIT = 4096;

/** REST: Authorization: Bearer <ownerToken> or <agentToken>. Tokens are separate. */
export const API = {
  health: '/api/health',
  info: '/api/info',
  requests: '/api/requests',
  subscribe: '/api/push/subscribe',
  pushStatus: '/api/push/status',
  unsubscribe: '/api/push/unsubscribe',
  socket: '/ws',
  pairing: '/api/pairing',
  pair: '/api/pair',
  pairStatus: '/api/pair/status',
} as const;
