const EMPTY_BODY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

export type Creds = {
  gateway: string;
  accountId: string;
  apiKey: string;
  privateKey: string;
  instrument: string;
};

export class ExnessApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ExnessApiError";
    this.status = status;
    this.code = code;
  }
}

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

async function readError(response: Response): Promise<ExnessApiError> {
  const raw = await response.text();
  if (!raw) return new ExnessApiError(response.status, `Exness API request failed (HTTP ${response.status}).`);
  try {
    const json = JSON.parse(raw) as { code?: string | number; error_code?: string; error_message?: string; message?: string; details?: unknown };
    const code = json.error_code || (json.code == null ? undefined : String(json.code));
    const message = json.error_message || json.message || `Exness API request failed (HTTP ${response.status}).`;
    return new ExnessApiError(response.status, code ? `${code}: ${message}` : message, code);
  } catch {
    return new ExnessApiError(response.status, raw.slice(0, 240));
  }
}

export async function exnessFetch<T>(opts: {
  base: string;
  apiKey: string;
  privateKey: string;
  method: string;
  pathWithQuery: string;
  body?: unknown;
  idempotencyKey?: string;
}): Promise<T> {
  const body = opts.body == null ? "" : JSON.stringify(opts.body);
  const headers = await signedHeaders({
    apiKey: opts.apiKey,
    privateKey: opts.privateKey,
    method: opts.method,
    pathWithQuery: opts.pathWithQuery,
    body,
    idempotency: opts.idempotencyKey,
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
  if (!response.ok) throw await readError(response);
  const responseText = await response.text();
  if (!responseText.trim()) return undefined as T;
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Unexpected response shape.");
    }
    return parsed as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid JSON response.";
    throw new ExnessApiError(response.status, `Exness API returned an invalid JSON response: ${detail}`);
  }
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
  orders?: Array<{
    order_id?: string;
    position_id?: string;
    order_type?: string;
    state?: string;
    direction?: string;
    instrument?: string;
    price?: string;
    volume?: string;
    stop_loss_price?: string | null;
    take_profit_price?: string | null;
    create_time?: string;
  }>;
  positions?: Array<{
    position_id?: string;
    direction?: string;
    instrument?: string;
    volume?: string;
    open_price?: string;
    stop_loss_price?: string | null;
    take_profit_price?: string | null;
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
  if (!account || typeof account !== "object" || !conditions || typeof conditions !== "object" ||
      !snapshot || typeof snapshot !== "object" ||
      (snapshot.positions !== undefined && !Array.isArray(snapshot.positions)) ||
      (snapshot.orders !== undefined && !Array.isArray(snapshot.orders))) {
    throw new Error("Exness account response validation failed: unexpected account, conditions or snapshot shape.");
  }
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

export type CandleTimeframe = "S1" | "S5" | "S15" | "M1" | "M3" | "M5" | "M10" | "M15" | "M30" | "H1" | "H2" | "H4" | "D1" | "W1" | "MN";

export async function pullCandles(
  creds: Creds,
  access: string,
  count = 500,
  timeframe: CandleTimeframe = "M5",
  priceType: "bid" | "ask" | "both" = "bid",
): Promise<RawCandle[]> {
  if (!Number.isInteger(count) || count === 0) throw new Error("Candle count must be a non-zero integer.");
  const durationMs: Record<CandleTimeframe, number> = {
    S1: 1_000, S5: 5_000, S15: 15_000, M1: 60_000, M3: 180_000,
    M5: 300_000, M10: 600_000, M15: 900_000, M30: 1_800_000,
    H1: 3_600_000, H2: 7_200_000, H4: 14_400_000, D1: 86_400_000,
    W1: 604_800_000, MN: 2_592_000_000,
  };
  const from = new Date(Date.now() - Math.abs(count) * durationMs[timeframe]).toISOString();
  const query = [
    `instrument=${encodeURIComponent(creds.instrument.trim())}`,
    `price_type=${priceType}`,
    `timeframe=${timeframe}`,
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
  if (!Array.isArray(payload.candles)) throw new Error("Exness candles response is missing the candles array.");
  return payload.candles;
}

function expectRecord(value: unknown, endpoint: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Exness ${endpoint} response is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function expectStringField(record: Record<string, unknown>, field: string, endpoint: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Exness ${endpoint} response is missing required field "${field}".`);
  }
  return value;
}

function validateAck(value: unknown, endpoint: string): Ack {
  const record = expectRecord(value, endpoint);
  const status = expectStringField(record, "status", endpoint);
  if (status !== "accepted") throw new Error(`Exness ${endpoint} returned unexpected ACK status "${status}".`);
  if (record.operation_id !== undefined && typeof record.operation_id !== "string") {
    throw new Error(`Exness ${endpoint} returned an invalid operation_id.`);
  }
  return record as unknown as Ack;
}

function validateHistoryPage<T>(value: unknown, entity: "order" | "deal"): HistoryPage<T> {
  const record = expectRecord(value, `${entity} history`);
  if (!Array.isArray(record.items)) throw new Error(`Exness ${entity} history response is missing the items array.`);
  for (const [index, raw] of record.items.entries()) {
    const item = expectRecord(raw, `${entity} history item ${index + 1}`);
    expectStringField(item, "event_time", `${entity} history item ${index + 1}`);
    const nested = expectRecord(item[entity], `${entity} history item ${index + 1}`);
    expectStringField(nested, entity === "order" ? "order_id" : "deal_id", `${entity} history item ${index + 1}`);
  }
  if (record.next_cursor !== undefined && typeof record.next_cursor !== "string") {
    throw new Error(`Exness ${entity} history response has an invalid next_cursor.`);
  }
  if (record.has_more !== undefined && typeof record.has_more !== "boolean") {
    throw new Error(`Exness ${entity} history response has an invalid has_more flag.`);
  }
  return record as unknown as HistoryPage<T>;
}

export async function placeMarket(
  creds: Creds,
  access: string,
  body: Record<string, string>,
): Promise<Ack> {
  const response = await exnessFetch<unknown>({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "POST",
    pathWithQuery: `/v1/trading/accounts/${creds.accountId.trim()}/positions`,
    body,
  });
  return validateAck(response, "market position request");
}

export async function readOperation(
  creds: Creds,
  access: string,
  operationId: string,
): Promise<OperationStatus> {
  if (!/^\\d{1,20}$/.test(operationId)) throw new Error("Invalid operation ID.");
  const response = await exnessFetch<unknown>({
    base: access,
    apiKey: creds.apiKey,
    privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/trading/accounts/${encodeURIComponent(creds.accountId.trim())}/operations/${encodeURIComponent(operationId)}`,
  });
  const record = expectRecord(response, "operation status");
  const status = expectStringField(record, "status", "operation status");
  if (!["pending", "confirmed", "rejected", "failed"].includes(status)) {
    throw new Error(`Exness operation status response contains unknown status "${status}".`);
  }
  return record as unknown as OperationStatus;
}


export type ApiLimits = {
  limits?: {
    candles?: { max_count?: number; [key: string]: unknown };
    websocket?: { [key: string]: unknown };
    [key: string]: unknown;
  };
};

export type TradingSnapshot = Snapshot & {
  orders?: Array<{
    order_id?: string;
    position_id?: string;
    order_type?: string;
    state?: string;
    direction?: string;
    instrument?: string;
    price?: string;
    volume?: string;
    stop_loss_price?: string | null;
    take_profit_price?: string | null;
    create_time?: string;
  }>;
};

export type Ack = {
  operation_id?: string;
  client_request_id?: string;
  status: "accepted" | string;
};

export type OperationStatus = {
  operation_id: string;
  status: "pending" | "confirmed" | "rejected" | "failed";
  client_request_id?: string;
  error_code?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
};

export type OrderHistoryRecord = {
  event_time: string;
  order: {
    order_id: string;
    order_type: string;
    state: string;
    direction?: string;
    instrument?: string;
    price?: string;
    volume?: string;
    stop_loss_price?: string | null;
    take_profit_price?: string | null;
    create_time?: string;
  };
};

export type DealHistoryRecord = {
  event_time: string;
  deal: {
    deal_id: string;
    order_id?: string;
    position_id?: string;
    type: string;
    direction?: string;
    instrument?: string;
    volume?: string;
    price?: string;
    profit?: string;
    commission?: string;
    create_time?: string;
  };
};

export type HistoryPage<T> = {
  items: T[];
  next_cursor?: string;
  has_more?: boolean;
  range?: { from?: string; to?: string };
};

function accountPath(creds: Creds, suffix: string): string {
  const accountId = encodeURIComponent(creds.accountId.trim());
  if (!accountId) throw new Error("Account ID is missing.");
  return `/v1/trading/accounts/${accountId}${suffix}`;
}

/** Fetch current REST/WebSocket limits. Use the returned limits before opening streams or requesting large candle ranges. */
export function pullLimits(creds: Creds, access: string): Promise<ApiLimits> {
  return exnessFetch({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/configuration/accounts/${encodeURIComponent(creds.accountId.trim())}/limits`,
  });
}

/** Refresh the authoritative current open orders, positions and account state. */
export async function pullSnapshot(creds: Creds, access: string): Promise<TradingSnapshot> {
  const snapshot = await exnessFetch<TradingSnapshot>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "GET", pathWithQuery: accountPath(creds, "/snapshot"),
  });
  if (!snapshot || typeof snapshot !== "object" ||
      (snapshot.orders !== undefined && !Array.isArray(snapshot.orders)) ||
      (snapshot.positions !== undefined && !Array.isArray(snapshot.positions))) {
    throw new Error("Exness trading snapshot response validation failed.");
  }
  return snapshot;
}

/** Place a limit/stop pending order or an SLTP instruction, according to the Trader API contract. */
export function placePendingOrder(
  creds: Creds,
  access: string,
  body: Record<string, string>,
  requestId?: string,
): Promise<Ack> {
  const response = await exnessFetch<unknown>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "POST", pathWithQuery: accountPath(creds, "/orders"),
    body, idempotencyKey: requestId || idempotencyKey(),
  });
  return validateAck(response, "order request");
}

/** Modify an active pending/SLTP order. Use null to remove an existing SL or TP. */
export function modifyOrder(
  creds: Creds,
  access: string,
  orderId: string,
  changes: { price?: string; stop_loss_price?: string | null; take_profit_price?: string | null; comment?: string },
  requestId?: string,
): Promise<Ack> {
  if (!/^\d{1,20}$/.test(orderId)) throw new Error("Invalid order ID.");
  if (!Object.keys(changes).some((key) => key !== "comment")) throw new Error("At least one order price field must change.");
  const response = await exnessFetch<unknown>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "PATCH",
    pathWithQuery: accountPath(creds, `/orders/${encodeURIComponent(orderId)}`),
    body: changes, idempotencyKey: requestId || idempotencyKey(),
  });
  return validateAck(response, "order modification");
}

/** Cancel an active pending or SLTP order. */
export function cancelOrder(
  creds: Creds,
  access: string,
  orderId: string,
  requestId?: string,
): Promise<Ack> {
  if (!/^\d{1,20}$/.test(orderId)) throw new Error("Invalid order ID.");
  const response = await exnessFetch<unknown>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "DELETE",
    pathWithQuery: accountPath(creds, `/orders/${encodeURIComponent(orderId)}`),
    idempotencyKey: requestId || idempotencyKey(),
  });
  return validateAck(response, "order cancellation");
}

/** Close a position fully, or partially when volume is supplied. */
export function closePosition(
  creds: Creds,
  access: string,
  positionId: string,
  options: { volume?: string; price?: string; deviation?: string } = {},
  requestId?: string,
): Promise<Ack> {
  if (!/^\d{1,20}$/.test(positionId)) throw new Error("Invalid position ID.");
  const params = new URLSearchParams();
  if (options.volume !== undefined) params.set("volume", options.volume);
  if (options.price !== undefined) params.set("price", options.price);
  if (options.deviation !== undefined) params.set("deviation", options.deviation);
  const query = params.toString();
  const response = await exnessFetch<unknown>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "DELETE",
    pathWithQuery: accountPath(creds, `/positions/${encodeURIComponent(positionId)}`)+(query ? `?${query}` : ""),
    idempotencyKey: requestId || idempotencyKey(),
  });
  return validateAck(response, "position close");
}

export type HistoryRange = { from?: string; to?: string; cursor?: string; limit?: number; instrument?: string };

function historyQuery(range: HistoryRange): string {
  if (range.cursor && (range.from || range.to || range.instrument)) {
    throw new Error("History cursor cannot be combined with date or instrument filters.");
  }
  if (!range.cursor && !range.from) throw new Error("History start time is required.");
  if (range.from && Number.isNaN(Date.parse(range.from))) throw new Error("History start time is invalid.");
  if (range.to && (Number.isNaN(Date.parse(range.to)) || Date.parse(range.to) <= Date.parse(range.from || ""))) {
    throw new Error("History end time must be later than the start time.");
  }
  const params = new URLSearchParams();
  if (range.cursor) params.set("cursor", range.cursor);
  else {
    params.set("from", range.from!);
    if (range.to) params.set("to", range.to);
    if (range.instrument) params.set("instrument", range.instrument);
  }
  const limit = range.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("History limit must be between 1 and 200.");
  params.set("limit", String(limit));
  return params.toString();
}

/** Historical orders only; active orders must be read from the trading snapshot. */
export function pullOrderHistory(
  creds: Creds, access: string, range: HistoryRange,
): Promise<HistoryPage<OrderHistoryRecord>> {
  const response = await exnessFetch<unknown>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/history/accounts/${encodeURIComponent(creds.accountId.trim())}/orders?${historyQuery(range)}`,
  });
  return validateHistoryPage<OrderHistoryRecord>(response, "order");
}

/** Historical deals, including close/open and balance-related activity. */
export function pullDealHistory(
  creds: Creds, access: string, range: HistoryRange,
): Promise<HistoryPage<DealHistoryRecord>> {
  const response = await exnessFetch<unknown>({
    base: access, apiKey: creds.apiKey, privateKey: creds.privateKey,
    method: "GET",
    pathWithQuery: `/v1/history/accounts/${encodeURIComponent(creds.accountId.trim())}/deals?${historyQuery(range)}`,
  });
  return validateHistoryPage<DealHistoryRecord>(response, "deal");
}
