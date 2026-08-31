// lib/auto-detect.ts
import { probeWebSocket } from './ws-probe';
import { useRosStore } from '../stores/useRosStore';
import { FOXGLOVE_WEBSOCKET_PROTOCOLS } from '../constants/defaults';
import {
  formatConnectionUrl,
  parseConnectionInput,
  type ParsedConnectionInput,
} from './connection-url';

export type DetectionResult = {
  transport: 'rosbridge' | 'foxglove';
  url: string;
  host: string;
  port: number;
};

export const parseInput = parseConnectionInput;

type ValidInput = Extract<ParsedConnectionInput, { kind: 'valid' }>;

function resultFor(
  parsed: ValidInput,
  transport: DetectionResult['transport'],
  port: number,
): DetectionResult {
  return {
    transport,
    url: formatConnectionUrl({ ...parsed, port }, port),
    host: parsed.host,
    port,
  };
}

function preferredTransport(): DetectionResult['transport'] {
  return useRosStore.getState().transportType === 'foxglove' ? 'foxglove' : 'rosbridge';
}

export async function autoDetect(
  input: string,
  signal?: AbortSignal,
): Promise<DetectionResult | null> {
  if (signal?.aborted) return null;

  const parsed = parseInput(input);
  if (parsed.kind !== 'valid') return null;
  const { host, port, scheme, explicitScheme, path } = parsed;

  // An explicit ws(s) URL without a port means the standard WebSocket port.
  // Probe that exact endpoint (including a reverse-proxy path) with both
  // handshakes instead of silently rewriting it to 9090/8765.
  if (port === null && explicitScheme) {
    const standardPort = scheme === 'wss' ? 443 : 80;
    const [rosbridge, foxglove] = await Promise.all([
      probeWebSocket(host, standardPort, { scheme, path }),
      probeWebSocket(host, standardPort, {
        protocols: FOXGLOVE_WEBSOCKET_PROTOCOLS,
        scheme,
        path,
      }),
    ]);
    if (signal?.aborted) return null;
    // A negotiated Foxglove subprotocol is positive identification; a generic
    // open only proves that the endpoint accepts WebSockets.
    if (foxglove) return resultFor(parsed, 'foxglove', standardPort);
    if (rosbridge) return resultFor(parsed, 'rosbridge', standardPort);
    return null;
  }

  // --- No port specified: probe :9090 and :8765 concurrently ---
  if (port === null) {
    const [ros9090, fox8765] = await Promise.all([
      probeWebSocket(host, 9090, { scheme, path }),
      probeWebSocket(host, 8765, {
        protocols: FOXGLOVE_WEBSOCKET_PROTOCOLS,
        scheme,
        path,
      }),
    ]);
    if (signal?.aborted) return null;

    if (ros9090 && fox8765) {
      const preferred = preferredTransport();
      const p = preferred === 'foxglove' ? 8765 : 9090;
      return resultFor(parsed, preferred, p);
    }
    if (ros9090) return resultFor(parsed, 'rosbridge', 9090);
    if (fox8765) return resultFor(parsed, 'foxglove', 8765);
    return null;
  }

  // Probe both handshakes for explicit ports. Foxglove rejects a probe which
  // omits its subprotocol, so a generic reachability probe is not sufficient.
  if (signal?.aborted) return null;
  const [rosbridge, foxglove] = await Promise.all([
    probeWebSocket(host, port, { scheme, path }),
    probeWebSocket(host, port, {
      protocols: FOXGLOVE_WEBSOCKET_PROTOCOLS,
      scheme,
      path,
    }),
  ]);
  if (signal?.aborted) return null;
  if (foxglove) return resultFor(parsed, 'foxglove', port);
  if (rosbridge) return resultFor(parsed, 'rosbridge', port);
  return null;
}
