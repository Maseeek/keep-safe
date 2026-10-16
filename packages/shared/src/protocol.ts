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
  vapidPublicKey?: string;
  historyRetentionHours?: number;
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
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string };

export type ServerMessage =
  | { type: 'ready'; info: BridgeInfo; requests: LoginRequest[] }
  | { type: 'requests'; requests: LoginRequest[] }
  | { type: 'frame'; requestId: string; data: string; width: number; height: number; url: string }
  | { type: 'error'; message: string };

/** REST: Authorization: Bearer <ownerToken> or <agentToken>. Tokens are separate. */
export const API = {
  health: '/api/health',
  info: '/api/info',
  requests: '/api/requests',
  subscribe: '/api/push/subscribe',
  socket: '/ws',
} as const;
