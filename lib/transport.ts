// lib/transport.ts

export interface Subscription {
  unsubscribe: () => void;
}

export interface TopicInfo {
  name: string;
  type: string;
}

export type TransportStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectOptions {
  /**
   * Gateway login credentials. When set, the transport sends
   * ``{"op": "login", "user", "token"}`` as the very first frame after the
   * WebSocket opens (the omni_ws_gateway login gate).
   */
  login?: { user: string; token: string };
}

export interface Transport {
  connect(url: string, options?: ConnectOptions): Promise<void>;
  disconnect(): void;
  subscribe(topic: string, messageType: string, callback: (msg: any) => void, throttleRate?: number): Subscription;
  publish(topic: string, messageType: string, msg: any): void;
  callService(service: string, serviceType: string, request: Record<string, unknown>): Promise<any>;
  getTopics(): Promise<TopicInfo[]>;
  onStatus(callback: (status: TransportStatus, error?: string) => void): () => void;
  getStatus(): TransportStatus;
}

export type TransportType = 'rosbridge' | 'foxglove' | 'demo';
