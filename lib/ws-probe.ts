import { formatConnectionUrl, parseConnectionInput, type WebSocketScheme } from './connection-url';

export interface WebSocketProbeOptions {
  timeoutMs?: number;
  protocols?: readonly string[];
  scheme?: WebSocketScheme;
  path?: string;
  /** @deprecated Use path instead. */
  trailingSlash?: boolean;
}

export function probeWebSocket(
  host: string,
  port: number,
  options: WebSocketProbeOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const {
      timeoutMs = 2000,
      protocols,
      scheme = 'ws',
      path,
      trailingSlash = false,
    } = options;
    const urlPath = path ?? (trailingSlash ? '/' : '');
    const parsed = parseConnectionInput(
      `${scheme}://${host}:${port}${urlPath}`,
    );
    if (parsed.kind !== 'valid') {
      resolve(false);
      return;
    }

    const url = formatConnectionUrl(parsed, port);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, protocols ? [...protocols] : undefined);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish(false);
      try { ws.close(); } catch {}
    }, timeoutMs);
    ws.onopen = () => {
      const protocolAccepted = !protocols?.length || protocols.includes(ws.protocol);
      finish(protocolAccepted);
      try { ws.close(); } catch {}
    };
    ws.onerror = () => {
      finish(false);
    };
    ws.onclose = () => finish(false);
  });
}
