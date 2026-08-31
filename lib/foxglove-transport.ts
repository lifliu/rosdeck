import type { Transport, ConnectOptions, Subscription, TopicInfo, TransportStatus } from './transport';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import { DEFAULTS, FOXGLOVE_WEBSOCKET_PROTOCOLS } from '../constants/defaults';
import { canonicalizeConnectionUrl } from './connection-url';

type ServiceSchema = {
  encoding?: string;
  schemaName?: string;
  schemaEncoding?: string;
  schema?: string;
};

type AdvertisedService = {
  id: number;
  name: string;
  type: string;
  request?: ServiceSchema;
  response?: ServiceSchema;
  requestSchema?: string;
  responseSchema?: string;
};

// Close codes the omni_ws_gateway login gate sends. Mapping them to readable
// messages keeps "wrong token" distinguishable from a plain network drop;
// they are also treated as terminal (no auto-reconnect).
const AUTH_CLOSE_REASONS: Record<number, string> = {
  1008: 'Authentication failed — check the user and token in the device pairing',
  4403: 'Too many failed logins — temporarily locked out, try again later',
};

// Some Humble foxglove_bridge releases advertise only the legacy service
// metadata. Keep the VBot service definition locally so those releases can
// still receive and return proper ROS 2 CDR rather than JSON bytes.
const SET_RUN_MODE_TYPE = 'function_msgs/srv/SetRunMode';
const SET_RUN_MODE_REQUEST_SCHEMA = `uint8 target_state
uint8 mode
string req_id
bool pre_check
bool has_is_traction_user_param
bool is_traction_user_param`;
const SET_RUN_MODE_RESPONSE_SCHEMA = `bool success
string message
int32 error_code`;

export class FoxgloveTransport implements Transport {
  private ws: WebSocket | null = null;
  private status: TransportStatus = 'disconnected';
  private statusListeners: Array<(status: TransportStatus, error?: string) => void> = [];
  private subscriptions: Map<number, { topic: string; messageType: string; callback: (msg: any) => void }> = new Map();
  private nextSubId = 1;
  private serverChannels: Map<number, { topic: string; schemaName: string; encoding?: string }> = new Map();
  private topicToChannelId: Map<string, number> = new Map();
  private clientChannels: Map<string, { id: number; messageType: string }> = new Map();
  private nextClientChannelId = 1;
  private messageReaders: Map<string, MessageReader> = new Map();
  private schemaDefinitions: Map<string, string> = new Map();
  private pendingSubscriptions: Array<{ subId: number; topic: string }> = [];
  private cancelPendingConnect: (() => void) | null = null;
  // Multiplexing: one bridge-level sub per topic, fan-out to all internal callbacks.
  // foxglove_bridge may only deliver messages to the first subscription ID per channel,
  // so we deduplicate at the bridge level and route internally.
  private topicBridgeSub: Map<string, number> = new Map();   // topic → bridge subId
  private bridgeSubToTopic: Map<number, string> = new Map(); // bridge subId → topic
  private services: Map<string, AdvertisedService> = new Map();
  private serverSupportedEncodings: string[] = [];
  private nextCallId = 1;
  private pendingServiceCalls: Map<number, {
    serviceId: number;
    resolve: (response: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    responseSchema?: string;
  }> = new Map();

  getStatus(): TransportStatus {
    return this.status;
  }

  private setStatus(status: TransportStatus, error?: string) {
    this.status = status;
    this.statusListeners.forEach((cb) => cb(status, error));
  }

  async connect(url: string, options?: ConnectOptions): Promise<void> {
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      const canonicalUrl = canonicalizeConnectionUrl(url, DEFAULTS.foxglovePort);
      if (!canonicalUrl) {
        const message = 'Invalid WebSocket URL';
        this.setStatus('error', message);
        reject(new Error(message));
        return;
      }

      let opened = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let ws: WebSocket | null = null;
      let cancelPending: () => void;
      const clearPending = () => {
        if (this.cancelPendingConnect === cancelPending) this.cancelPendingConnect = null;
      };
      const rejectOnce = (message: string) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        clearPending();
        this.setStatus('error', message);
        reject(new Error(message));
      };
      cancelPending = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        clearPending();
        reject(new Error('Connection cancelled'));
      };
      this.cancelPendingConnect = cancelPending;

      timeout = setTimeout(() => {
        rejectOnce('Connection timeout');
        try { ws?.close(); } catch {}
      }, 5000);

      try {
        ws = new WebSocket(canonicalUrl, [...FOXGLOVE_WEBSOCKET_PROTOCOLS]);
      } catch (error: any) {
        rejectOnce(error?.message || 'Unable to create WebSocket');
        return;
      }
      const socket = ws;
      this.ws = ws;
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        if (!(FOXGLOVE_WEBSOCKET_PROTOCOLS as readonly string[]).includes(socket.protocol)) {
          rejectOnce('Foxglove subprotocol negotiation failed');
          try { socket.close(); } catch {}
          return;
        }
        if (settled) {
          try { socket.close(); } catch {}
          return;
        }
        if (options?.login) {
          // The omni_ws_gateway login gate requires {"op":"login","user",
          // "token"} as the very first data frame. Send it before reporting
          // the socket as connected so a failed send still rejects connect().
          try {
            socket.send(JSON.stringify({
              op: 'login',
              user: options.login.user,
              token: options.login.token,
            }));
          } catch (error: any) {
            rejectOnce(error?.message || 'Failed to send login');
            try { socket.close(); } catch {}
            return;
          }
        }
        opened = true;
        settled = true;
        if (timeout) clearTimeout(timeout);
        clearPending();
        this.setStatus('connected');
        resolve();
      };

      socket.onerror = (event) => {
        const message = (event as any)?.message || 'Connection error';
        console.warn('[FoxgloveTransport] WS error:', message);
      };

      socket.onclose = (event) => {
        if (timeout) clearTimeout(timeout);
        if (this.ws === socket) this.ws = null;
        const authReason = AUTH_CLOSE_REASONS[event.code];
        const reason = authReason || event.reason || `WebSocket closed (code: ${event.code})`;
        if (!opened) {
          rejectOnce(reason);
        } else if (authReason) {
          // Auth / rate-limit closes are terminal: retrying with the same
          // credentials cannot succeed, so surface an error instead of
          // feeding the reconnect loop.
          this.setStatus('error', reason);
        } else {
          this.setStatus('disconnected', reason);
        }
      };

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          if (event.data.startsWith('{') || event.data.startsWith('[')) {
            try { this.handleMessage(JSON.parse(event.data)); } catch {}
          } else {
            this.handleBase64Message(event.data);
          }
        } else {
          try { this.handleBinaryMessage(event.data); } catch {}
        }
      };
    });
  }

  private handleMessage(msg: any) {
    switch (msg.op) {
      case 'serverInfo':
        this.serverSupportedEncodings = Array.isArray(msg.supportedEncodings)
          ? msg.supportedEncodings.map(String)
          : [];
        break;
      case 'advertiseServices':
        for (const service of msg.services ?? []) {
          if (typeof service?.name === 'string' && typeof service?.id === 'number') {
            this.services.set(service.name, {
              ...service,
              id: service.id,
              name: service.name,
              type: String(service.type || ''),
            });
          }
        }
        break;
      case 'unadvertiseServices': {
        const removed = new Set<number>(msg.serviceIds ?? []);
        for (const [name, service] of this.services) {
          if (removed.has(service.id)) this.services.delete(name);
        }
        break;
      }
      case 'serviceCallFailure': {
        const pending = this.pendingServiceCalls.get(Number(msg.callId));
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingServiceCalls.delete(Number(msg.callId));
          pending.reject(new Error(msg.message || 'Service call failed'));
        }
        break;
      }
      case 'advertise':
        if (Array.isArray(msg.channels)) {
          for (const ch of msg.channels) {
            this.serverChannels.set(ch.id, { topic: ch.topic, schemaName: ch.schemaName, encoding: ch.encoding });
            this.topicToChannelId.set(ch.topic, ch.id);
            if (ch.schema && ch.schemaName) {
              this.schemaDefinitions.set(ch.schemaName, ch.schema);
            }
          }
          this.flushPendingSubscriptions();
        }
        break;
    }
  }

  private handleBinaryMessage(data: any) {
    let bytes: Uint8Array;

    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data?.buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      return;
    }

    if (bytes.length < 13) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const opcode = view.getUint8(0);

    // Foxglove opcode 3 = service call response.
    if (opcode === 0x03) {
      this.handleServiceCallResponse(bytes, view);
      return;
    }

    // foxglove.sdk.v1: opcode 1 = serverMessage
    if (opcode !== 0x01) return;

    const subscriptionId = view.getUint32(1, true);
    // Resolve topic via the bridge-subId → topic map (works even if the original
    // subscriber that created this bridge subscription has since unsubscribed).
    const topic = this.bridgeSubToTopic.get(subscriptionId);
    if (!topic) return;

    // SDK v1: opcode(1) + subId(4) + timestamp(8) = 13 byte header
    const payloadBytes = new Uint8Array(bytes.buffer.slice(bytes.byteOffset + 13));
    const channelInfo = this.getChannelForTopic(topic);

    // Skip expensive deserialization if no subscriber wants this channel's schema.
    // e.g. camera subscribes for CompressedImage but topic publishes raw Image.
    if (channelInfo?.schemaName) {
      const wantedByAnyone = [...this.subscriptions.values()].some(
        (s) => s.topic === topic && s.messageType === channelInfo.schemaName,
      );
      if (!wantedByAnyone) return;
    }

    let parsedMsg: any;
    if (channelInfo?.encoding === 'cdr' && channelInfo.schemaName) {
      // Fast path: extract CompressedImage data directly from CDR
      // without full deserialization (avoids copying large byte arrays)
      if (channelInfo.schemaName === 'sensor_msgs/msg/CompressedImage') {
        try {
          parsedMsg = this.parseCompressedImageFast(payloadBytes);
        } catch { return; }
      } else {
        const reader = this.getMessageReader(channelInfo.schemaName);
        if (!reader) return;
        try {
          parsedMsg = reader.readMessage(payloadBytes);
        } catch { return; }
      }
    } else {
      try {
        parsedMsg = JSON.parse(new TextDecoder().decode(payloadBytes));
      } catch { return; }
    }

    // Fan-out: deliver to ALL subscribers for this topic, not just the one
    // whose subId the bridge used. This is necessary because foxglove_bridge
    // may only ever send messages tagged with the first subscription ID for a
    // given channel, ignoring subsequent ones from the same client.
    for (const [, sub] of this.subscriptions) {
      if (sub.topic === topic && (!channelInfo?.schemaName || sub.messageType === channelInfo.schemaName)) {
        try { sub.callback(parsedMsg); } catch {}
      }
    }
  }

  private handleServiceCallResponse(bytes: Uint8Array, view: DataView): void {
    const serviceId = view.getUint32(1, true);
    const callId = view.getUint32(5, true);
    const encodingLength = view.getUint32(9, true);
    const payloadOffset = 13 + encodingLength;
    if (payloadOffset > bytes.byteLength) return;
    const encoding = new TextDecoder().decode(bytes.subarray(13, payloadOffset));
    const pending = this.pendingServiceCalls.get(callId);
    if (!pending || pending.serviceId !== serviceId) return;
    clearTimeout(pending.timeout);
    this.pendingServiceCalls.delete(callId);
    try {
      const responseBytes = bytes.subarray(payloadOffset);
      let response: any;
      if (encoding === 'json') {
        response = JSON.parse(new TextDecoder().decode(responseBytes));
      } else if (encoding === 'cdr') {
        if (!pending.responseSchema) throw new Error('Missing service response schema');
        const definitions = parseMessageDefinition(pending.responseSchema, { ros2: true });
        response = new MessageReader(definitions).readMessage(responseBytes);
      } else {
        throw new Error(`Unsupported service response encoding: ${encoding}`);
      }
      pending.resolve(response);
    } catch (error: any) {
      pending.reject(new Error(error?.message || 'Invalid service response'));
    }
  }

  private getServiceSchema(service: AdvertisedService, direction: 'request' | 'response'): string | undefined {
    const modern = service[direction]?.schema;
    if (modern) return modern;

    const legacy = direction === 'request' ? service.requestSchema : service.responseSchema;
    if (legacy) {
      // Be tolerant of bridges which put the complete .srv definition in both
      // legacy fields rather than advertising the two message definitions.
      const sections = legacy.split(/^---\s*$/m);
      return direction === 'request' ? sections[0]?.trim() : (sections[1] ?? sections[0])?.trim();
    }

    if (service.type === SET_RUN_MODE_TYPE) {
      return direction === 'request' ? SET_RUN_MODE_REQUEST_SCHEMA : SET_RUN_MODE_RESPONSE_SCHEMA;
    }
    return undefined;
  }

  private getServiceRequestEncoding(service: AdvertisedService): string {
    if (service.request?.encoding) return service.request.encoding;
    // ROS 2 service payloads exposed by foxglove_bridge use CDR. Older bridge
    // advertisements omit the per-request encoding, so prefer the encoding
    // listed by serverInfo and finally infer it from the ROS 2 /srv/ type.
    if (this.serverSupportedEncodings.includes('cdr') || service.type.includes('/srv/')) return 'cdr';
    return 'json';
  }

  private getChannelForTopic(topic: string): { encoding?: string; schemaName?: string } | undefined {
    const channelId = this.topicToChannelId.get(topic);
    if (channelId === undefined) return undefined;
    return this.serverChannels.get(channelId);
  }

  private getChannelForSubscription(subId: number): { encoding?: string; schemaName?: string } | undefined {
    const sub = this.subscriptions.get(subId);
    if (!sub) return undefined;
    return this.getChannelForTopic(sub.topic);
  }

  private getMessageReader(schemaName: string): MessageReader | undefined {
    let reader = this.messageReaders.get(schemaName);
    if (reader) return reader;

    const schema = this.schemaDefinitions.get(schemaName);
    if (!schema) return undefined;

    try {
      const msgDefs = parseMessageDefinition(schema, { ros2: true });
      reader = new MessageReader(msgDefs);
      this.messageReaders.set(schemaName, reader);
      return reader;
    } catch {
      return undefined;
    }
  }

  /**
   * Fast CDR parser for sensor_msgs/msg/CompressedImage.
   * Extracts the JPEG data bytes directly without full CDR deserialization.
   * CDR layout (little-endian):
   *   [4] encapsulation header
   *   [4] stamp.sec (u32)
   *   [4] stamp.nanosec (u32)
   *   [4+N+pad] frame_id string (u32 length + chars + null + padding to 4-byte boundary)
   *   [4+N+pad] format string (u32 length + chars + null + padding)
   *   [4+N] data byte array (u32 length + bytes)
   */
  private parseCompressedImageFast(cdr: Uint8Array): { data: Uint8Array; format: string } {
    const view = new DataView(cdr.buffer, cdr.byteOffset, cdr.byteLength);
    let offset = 4; // skip encapsulation header

    // Skip header.stamp (sec + nanosec = 8 bytes)
    offset += 8;

    // Skip header.frame_id (length-prefixed string, aligned to 4 bytes)
    const frameIdLen = view.getUint32(offset, true);
    offset += 4 + frameIdLen;
    // Align to 4-byte boundary
    offset = (offset + 3) & ~3;

    // Read format string
    const formatLen = view.getUint32(offset, true);
    offset += 4;
    const format = new TextDecoder().decode(cdr.subarray(offset, offset + formatLen - 1)); // -1 to skip null terminator
    offset += formatLen;
    offset = (offset + 3) & ~3;

    // Read data byte array — slice to get a zero-offset copy so that
    // Skia.Data.fromBytes sees byteOffset=0 (not a view into the CDR buffer).
    const dataLen = view.getUint32(offset, true);
    offset += 4;
    const data = cdr.slice(offset, offset + dataLen);

    return { data, format };
  }

  private handleBase64Message(b64: string) {
    try {
      const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      this.handleBinaryMessage(binary.buffer);
    } catch {}
  }

  private flushPendingSubscriptions() {
    const remaining: typeof this.pendingSubscriptions = [];
    for (const pending of this.pendingSubscriptions) {
      const channelId = this.topicToChannelId.get(pending.topic);
      if (channelId !== undefined && this.ws) {
        this.ws.send(JSON.stringify({
          op: 'subscribe',
          subscriptions: [{ id: pending.subId, channelId }],
        }));
      } else {
        remaining.push(pending);
      }
    }
    this.pendingSubscriptions = remaining;
  }

  disconnect(): void {
    const cancelPending = this.cancelPendingConnect;
    this.cancelPendingConnect = null;
    cancelPending?.();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.subscriptions.clear();
    this.serverChannels.clear();
    this.topicToChannelId.clear();
    this.clientChannels.clear();
    this.pendingSubscriptions = [];
    this.nextClientChannelId = 1;
    this.messageReaders.clear();
    this.schemaDefinitions.clear();
    this.topicBridgeSub.clear();
    this.bridgeSubToTopic.clear();
    this.services.clear();
    this.serverSupportedEncodings = [];
    for (const pending of this.pendingServiceCalls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingServiceCalls.clear();
    this.setStatus('disconnected');
  }

  async callService(serviceName: string, serviceType: string, request: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.status !== 'connected') throw new Error('Foxglove is not connected');

    const deadline = Date.now() + 3000;
    let service = this.services.get(serviceName);
    while (!service && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      service = this.services.get(serviceName);
    }
    if (!service) throw new Error(`Service not advertised: ${serviceName}`);
    if (service.type && serviceType && service.type !== serviceType) {
      throw new Error(`Service type mismatch: expected ${serviceType}, got ${service.type}`);
    }

    const socket = this.ws;
    if (!socket) throw new Error('Foxglove is not connected');
    const callId = this.nextCallId++;
    const encoding = this.getServiceRequestEncoding(service);
    const encodingBytes = new TextEncoder().encode(encoding);
    let requestBytes: Uint8Array;
    let responseSchema: string | undefined;
    if (encoding === 'cdr') {
      const requestSchema = this.getServiceSchema(service, 'request');
      responseSchema = this.getServiceSchema(service, 'response');
      if (!requestSchema) throw new Error(`Missing CDR request schema: ${serviceType}`);
      try {
        const definitions = parseMessageDefinition(requestSchema, { ros2: true });
        requestBytes = new MessageWriter(definitions).writeMessage(request);
      } catch (error: any) {
        throw new Error(`Unable to encode service request: ${error?.message || 'invalid schema'}`);
      }
    } else if (encoding === 'json') {
      requestBytes = new TextEncoder().encode(JSON.stringify(request));
    } else {
      throw new Error(`Unsupported service request encoding: ${encoding}`);
    }
    const payload = new Uint8Array(13 + encodingBytes.length + requestBytes.length);
    const view = new DataView(payload.buffer);
    view.setUint8(0, 0x02);
    view.setUint32(1, service.id, true);
    view.setUint32(5, callId, true);
    view.setUint32(9, encodingBytes.length, true);
    payload.set(encodingBytes, 13);
    payload.set(requestBytes, 13 + encodingBytes.length);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingServiceCalls.delete(callId);
        reject(new Error(`Service call timed out: ${serviceName}`));
      }, 5000);
      this.pendingServiceCalls.set(callId, {
        serviceId: service!.id,
        resolve,
        reject,
        timeout,
        responseSchema,
      });
      try {
        socket.send(payload);
      } catch (error: any) {
        clearTimeout(timeout);
        this.pendingServiceCalls.delete(callId);
        reject(new Error(error?.message || 'Unable to send service request'));
      }
    });
  }

  subscribe(topic: string, messageType: string, callback: (msg: any) => void, _throttleRate?: number): Subscription {
    const subId = this.nextSubId++;
    this.subscriptions.set(subId, { topic, messageType, callback });

    if (!this.topicBridgeSub.has(topic)) {
      // First subscriber for this topic — create the bridge-level subscription.
      this.topicBridgeSub.set(topic, subId);
      this.bridgeSubToTopic.set(subId, topic);
      const channelId = this.topicToChannelId.get(topic);
      if (channelId !== undefined && this.ws) {
        this.ws.send(JSON.stringify({
          op: 'subscribe',
          subscriptions: [{ id: subId, channelId }],
        }));
      } else {
        this.pendingSubscriptions.push({ subId, topic });
      }
    }
    // Subsequent subscribers for the same topic share the existing bridge subscription
    // and receive messages via the fan-out in handleBinaryMessage.

    return {
      unsubscribe: () => {
        this.subscriptions.delete(subId);
        this.pendingSubscriptions = this.pendingSubscriptions.filter((p) => p.subId !== subId);

        // Only send bridge unsubscribe when the last callback for this topic is removed.
        const remaining = [...this.subscriptions.values()].some(s => s.topic === topic);
        if (!remaining) {
          const bridgeSubId = this.topicBridgeSub.get(topic);
          this.topicBridgeSub.delete(topic);
          if (bridgeSubId !== undefined) {
            this.bridgeSubToTopic.delete(bridgeSubId);
            const ch = this.topicToChannelId.get(topic);
            if (ch !== undefined && this.ws) {
              this.ws.send(JSON.stringify({
                op: 'unsubscribe',
                subscriptionIds: [bridgeSubId],
              }));
            }
          }
        }
      },
    };
  }

  private advertiseClient(topic: string, messageType: string): number {
    const existing = this.clientChannels.get(topic);
    if (existing?.messageType === messageType) return existing.id;

    // A joystick can switch from TwistStamped to Twist while connected. The
    // Foxglove protocol binds a schema to each advertised channel, so the old
    // channel must be withdrawn before publishing the new message shape.
    if (existing && this.ws) {
      this.ws.send(JSON.stringify({
        op: 'unadvertise',
        channelIds: [existing.id],
      }));
    }

    const channelId = this.nextClientChannelId++;
    this.clientChannels.set(topic, { id: channelId, messageType });

    if (this.ws) {
      this.ws.send(JSON.stringify({
        op: 'advertise',
        channels: [{
          id: channelId,
          topic,
          encoding: 'json',
          schemaName: messageType,
        }],
      }));
    }
    return channelId;
  }

  publish(topic: string, messageType: string, msg: any): void {
    if (!this.ws) return;
    const channelId = this.advertiseClient(topic, messageType);

    // Binary frame: opcode(1) + channelId(4) + payload
    const jsonBytes = new TextEncoder().encode(JSON.stringify(msg));
    const buffer = new ArrayBuffer(5 + jsonBytes.length);
    const view = new DataView(buffer);
    view.setUint8(0, 0x01);
    view.setUint32(1, channelId, true);
    new Uint8Array(buffer, 5).set(jsonBytes);

    this.ws.send(buffer);
  }

  async getTopics(): Promise<TopicInfo[]> {
    const topics: TopicInfo[] = [];
    for (const [, channel] of this.serverChannels) {
      topics.push({ name: channel.topic, type: channel.schemaName });
    }
    return topics;
  }

  onStatus(callback: (status: TransportStatus, error?: string) => void): () => void {
    this.statusListeners.push(callback);
    return () => {
      this.statusListeners = this.statusListeners.filter((cb) => cb !== callback);
    };
  }
}
