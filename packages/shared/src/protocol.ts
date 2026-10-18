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
}

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

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'watch'; requestId: string }
  | { type: 'unwatch' }
  | { type: 'inspect-controls'; inspectionId: string; includeFrames?: boolean }
  | { type: 'focus'; snapshotId: string; controlId: string }
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; deltaX: number; deltaY: number; x?: number; y?: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string };

export type ServerMessage =
  | { type: 'ready'; info: BridgeInfo; requests: LoginRequest[] }
  | { type: 'requests'; requests: LoginRequest[] }
  | { type: 'frame'; requestId: string; data: string; width: number; height: number; url: string }
  | { type: 'controls'; requestId: string; inspectionId: string; snapshot: PageControlsSnapshot }
  | { type: 'focused'; requestId: string; snapshotId: string; controlId: string }
  | { type: 'error'; message: string };

/** REST: Authorization: Bearer <ownerToken> or <agentToken>. Tokens are separate. */
export const API = {
  health: '/api/health',
  info: '/api/info',
  requests: '/api/requests',
  subscribe: '/api/push/subscribe',
  pushStatus: '/api/push/status',
  unsubscribe: '/api/push/unsubscribe',
  socket: '/ws',
} as const;
