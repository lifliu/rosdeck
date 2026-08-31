export type WebSocketScheme = 'ws' | 'wss';

type UnreadyConnectionInput = {
  kind: 'empty' | 'incomplete' | 'invalid';
  scheme: WebSocketScheme;
  explicitScheme: boolean;
  host: string;
  port: null;
  path: '';
};

export type ParsedConnectionInput =
  | {
      kind: 'valid';
      scheme: WebSocketScheme;
      explicitScheme: boolean;
      host: string;
      port: number | null;
      path: string;
    }
  | UnreadyConnectionInput;

const ENDPOINT_PATTERN = /^(\[[^\]]+\]|[^:/?#\s]+)(?::([^/?#\s]*))?((?:\/[^#\s]*|\?[^#\s]*)?)$/i;

function unready(
  kind: UnreadyConnectionInput['kind'],
  scheme: WebSocketScheme,
  explicitScheme: boolean,
  host = '',
): UnreadyConnectionInput {
  return { kind, scheme, explicitScheme, host, port: null, path: '' };
}

function isSupportedIpv6Host(host: string): boolean {
  const body = host.slice(1, -1);
  if (!body || !/^[0-9a-f:]+$/i.test(body) || body.includes(':::')) return false;
  if ((body.startsWith(':') && !body.startsWith('::'))
    || (body.endsWith(':') && !body.endsWith('::'))) return false;

  const halves = body.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(':') : []));
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function isSafePath(path: string): boolean {
  if (!path) return true;
  if (!path.startsWith('/') || /%(?![0-9a-f]{2})/i.test(path)) return false;
  return /^[a-z0-9\-._~!$&'()*+,;=:@%/?]*$/i.test(path);
}

/**
 * Parses the connection field without ever constructing a native WebSocket.
 * A trailing colon is an in-progress value, not a host with a missing port.
 */
export function parseConnectionInput(input: string): ParsedConnectionInput {
  const value = input.trim();
  const schemeMatch = value.match(/^(ws|wss):\/\//i);
  const scheme = (schemeMatch?.[1]?.toLowerCase() ?? 'ws') as WebSocketScheme;
  const explicitScheme = Boolean(schemeMatch);

  if (!value) return unready('empty', scheme, explicitScheme);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !schemeMatch) {
    return unready('invalid', scheme, explicitScheme);
  }

  const withoutScheme = schemeMatch ? value.slice(schemeMatch[0].length) : value;
  if (!withoutScheme) return unready('incomplete', scheme, explicitScheme);

  // Match only the endpoint portion. Keeping the scheme out of this regex
  // prevents the optional-scheme branch from backtracking and treating "wss"
  // as a hostname when the URL has a query but no slash.
  const match = withoutScheme.match(ENDPOINT_PATTERN);
  if (!match) return unready('invalid', scheme, explicitScheme);

  const host = match[1];
  const portText = match[2];
  const suffix = match[3] ?? '';
  const path = suffix.startsWith('?') ? `/${suffix}` : suffix;

  if (!explicitScheme && path && path !== '/') {
    return unready('invalid', scheme, explicitScheme, host);
  }
  if (!isSafePath(path)) return unready('invalid', scheme, explicitScheme, host);

  if (host.startsWith('[')) {
    if (!isSupportedIpv6Host(host)) return unready('invalid', scheme, explicitScheme, host);
  } else {
    const labels = host.split('.');
    const invalidHostname = !/^[a-z0-9._-]+$/i.test(host)
      || host.length > 253
      || labels.some((label) => (
        !label
        || label.length > 63
        || label.startsWith('-')
        || label.endsWith('-')
      ));
    const invalidIpv4 = /^\d+(?:\.\d+){3}$/.test(host)
      && host.split('.').some((part) => Number(part) > 255);
    if (invalidHostname || invalidIpv4) {
      return unready('invalid', scheme, explicitScheme, host);
    }
  }

  if (portText === '') return unready('incomplete', scheme, explicitScheme, host);

  let port: number | null = null;
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) return unready('invalid', scheme, explicitScheme, host);
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return unready('invalid', scheme, explicitScheme, host);
    }
  }

  return { kind: 'valid', scheme, explicitScheme, host, port, path };
}

export function formatConnectionUrl(
  parsed: Extract<ParsedConnectionInput, { kind: 'valid' }>,
  defaultPort: number,
): string {
  const port = parsed.port ?? (parsed.explicitScheme ? null : defaultPort);
  return `${parsed.scheme}://${parsed.host}${port === null ? '' : `:${port}`}${parsed.path}`;
}

/**
 * Converts flexible field input into the only form allowed to reach a native
 * WebSocket implementation: a complete, validated ws:// or wss:// URL.
 */
export function canonicalizeConnectionUrl(input: string, defaultPort: number): string | null {
  const parsed = parseConnectionInput(input);
  return parsed.kind === 'valid' ? formatConnectionUrl(parsed, defaultPort) : null;
}
