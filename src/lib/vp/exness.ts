const EMPTY_BODY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

export type Creds = {
  gateway: string;
  accountId: string;
  apiKey: string;
  privateKey: string;
  instrument: string;
};

export type ExnessError = {
  status: number;
  message: string;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPrivateKey(raw: string): Promise<CryptoKey> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Private key is empty.");
  let der: Uint8Array;
  if (trimmed.includes("BEGIN")) {
    der = pemToDer(trimmed);
  } else {
    const hex = trimmed.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]+$/.test(hex) || (hex.length !== 64 && hex.length !== 128)) {
      throw new Error("Use the 128-character hex key, a 64-character seed, or a PKCS8 PEM.");
    }
    const seed = hexToBytes(hex.slice(0, 64));
    const prefix = hexToBytes("302e020100300506032b657004220420");
    der = new Uint8Array(prefix.length + seed.length);
    der.set(prefix, 0);
    der.set(seed, prefix.length);
  }
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(der), { name: "Ed25519" }, false, ["sign"]);
}

async function sha256b64url(body: string): Promise<string> {
  if (body.length === 0) return EMPTY_BODY_HASH;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return b64url(new Uint8Array(digest));
}

export function idempotencyKey(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `vp-${Date.now().toString(36)}-${hex}`;
}

export async function signedHeaders(opts: {
  apiKey: string;
  privateKey: string;
  method: string;
  pathWithQuery: string;
  body?: string;
  idempotency?: string;
}): Promise<Record<string, string>> {
  const method = opts.method.toUpperCase();
  const body = opts.body ?? "";
  const idempotency = opts.idempotency ?? (method === "GET" ? "" : idempotencyKey());
  const timestamp = Date.now();
  const payload = {
    api_key: opts.apiKey.trim(),
    idempotency_key: idempotency,
    timestamp,
    sign_version: 1,
    method,
    path: opts.pathWithQuery,
    body_hash: await sha256b64url(body),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importPrivateKey(opts.privateKey);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, payloadBytes);
  return {
    "EXN-API-KEY": opts.apiKey.trim(),
    "EXN-IDEMPOTENCY-KEY": idempotency,
    "EXN-TIMESTAMP": String(timestamp),
    "EXN-SIGN-VERSION": "1",
    "EXN-DATA": b64url(payloadBytes),
    "EXN-SIGN": b64url(new Uint8Array(signature)),
  };
}

function originOf(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Gateway host is missing.");
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProto);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Host must be http or https.");
  return url.origin;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `Request failed (${response.status}).`;
  try {
    const json = JSON.parse(text) as { error_message?: string; message?: string };
    return json.error_message || json.message || text.slice(0, 180);
  } catch {
    return text.slice(0, 180);
  }
}

export async function exnessFetch<T>(opts: {
  base: string;
  apiKey: string;
  privateKey: string;
  method: string;
  pathWithQuery: string;
  body?: unknown;
}): Promise<T> {
  const body = opts.body == null ? "" : JSON.stringify(opts.body);
  const headers = await signedHeaders({
    apiKey: opts.apiKey,
    privateKey: opts.privateKey,
    method: opts.method,
    pathWithQuery: opts.pathWithQuery,
    body,
  });
  if (body) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${originOf(opts.base)}${opts.pathWithQuery}`, {
      method: opts.method,
      headers,
      body: body || undefined,
      redirect: "error",
    });
  } catch {
    throw new Error("Browser could not reach that host. Paper desk is still running.");
  }
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

export type AccessPoint = { access_point: string; account_id: string };

export async function discoverAccessPoint(creds: Creds): Promise<AccessPoint> {
  const path = `/v1/trading/access-point?account_id=${encodeURIComponent(creds.accountId.trim())}`;
  return exnessFetch<AccessPoint>({
    base: creds.gateway,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: path,
  });
}

export type AccountDetails = {
  account_id?: string;
  account_name?: string;
  settings?: {
    currency?: string;
    leverage?: string;
    trade_mode?: string;
    account_status?: string;
    execution_mode?: string;
  };
};

export type Conditions = {
  instrument?: string;
  point_digits?: number;
  exec_mode?: string;
  contract_size?: string | null;
  volume_min?: string | null;
  volume_max?: string | null;
  volume_step?: string | null;
  trade_mode?: string;
};

export type Snapshot = {
  positions?: Array<{
    position_id?: string;
    direction?: string;
    instrument?: string;
    volume?: string;
    open_price?: string;
    state?: string;
  }>;
  account_state?: {
    balance?: string;
    equity?: string;
    used_margin?: string;
  };
};

export async function pullAccount(creds: Creds): Promise<{
  access: string;
  account: AccountDetails;
  conditions: Conditions;
  snapshot: Snapshot;
}> {
  const found = await discoverAccessPoint(creds);
  const access = found.access_point;
  const id = creds.accountId.trim();
  const account = await exnessFetch<AccountDetails>({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/configuration/accounts/${id}/account`,
  });
  const instrument = encodeURIComponent(creds.instrument.trim());
  const conditions = await exnessFetch<Conditions>({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/configuration/accounts/${id}/instruments/${instrument}/conditions`,
  });
  const snapshot = await exnessFetch<Snapshot>({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/trading/accounts/${id}/snapshot`,
  });
  return { access, account, conditions, snapshot };
}

type RawCandle = {
  time?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
};

export async function pullCandles(creds: Creds, access: string, count = 500): Promise<RawCandle[]> {
  const from = new Date(Date.now() - count * 5 * 60 * 1000).toISOString();
  const query = [
    `instrument=${encodeURIComponent(creds.instrument.trim())}`,
    "price_type=bid",
    "timeframe=M5",
    `from=${encodeURIComponent(from)}`,
    `count=${count}`,
  ].join("&");
  const payload = await exnessFetch<{ candles?: RawCandle[] }>({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/market-data/accounts/${creds.accountId.trim()}/candles?${query}`,
  });
  return payload.candles ?? [];
}

export async function placeMarket(
  creds: Creds,
  access: string,
  body: Record<string, string>,
): Promise<{ operation_id?: string; status?: string; client_request_id?: string }> {
  return exnessFetch({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "POST",
    pathWithQuery: `/v1/trading/accounts/${creds.accountId.trim()}/positions`,
    body,
  });
}

export async function readOperation(
  creds: Creds,
  access: string,
  operationId: string,
): Promise<{ status?: string; error_message?: string }> {
  return exnessFetch({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/trading/accounts/${creds.accountId.trim()}/operations/${operationId}`,
  });
}
