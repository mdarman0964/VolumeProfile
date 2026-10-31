import { useEffect, useRef, useState } from "react";
import { PriceChart } from "@/components/desk/chart";
import {
  pullAccount,
  pullCandles,
  placeMarket,
  closePosition,
  readOperation,
  type Creds,
  type Snapshot,
} from "@/lib/vp/exness";
import {
  DEFAULT_SETTINGS,
  PAPER_BALANCE,
  TAPE_BARS,
  buildTape,
  clock,
  extendTape,
  money,
  px,
  replay,
  step,
  validateSettings,
  type Candle,
  type Session,
  type Settings,
  type Side,
} from "@/lib/vp/engine";

const STORAGE_KEY = "vela-settings";
const INITIAL_TAPE = buildTape(TAPE_BARS);

type Broker = {
  phase: "idle" | "busy" | "ready" | "error";
  detail: string;
  access: string;
  name: string;
  currency: string;
  leverage: string;
  tradeMode: string;
  accountStatus: string;
  balance: string;
  equity: string;
  margin: string;
  digits: number;
  execMode: string;
  contract: number;
  volMin: number;
  volStep: number;
  volMax: number;
  positions: Array<{ id: string; side: string; volume: string; price: string; instrument: string }>;
};

const IDLE_BROKER: Broker = {
  phase: "idle",
  detail: "Key stays in this tab. Requests go only to the host you type.",
  access: "",
  name: "",
  currency: "USD",
  leverage: "",
  tradeMode: "",
  accountStatus: "",
  balance: "",
  equity: "",
  margin: "",
  digits: 2,
  execMode: "",
  contract: 100,
  volMin: 0.01,
  volStep: 0.01,
  volMax: 50,
  positions: [],
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function Check({ on, label, value }: { on: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-muted">{label}</span>
      <span className={`max-w-[14rem] text-right font-mono text-xs ${on ? "text-up" : "text-fg"}`}>{value}</span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  step = "0.01",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg"
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function mapSnapshot(snapshot: Snapshot): Broker["positions"] {
  return (snapshot.positions ?? [])
    .filter((position) => position.state === "open" || !position.state)
    .map((position) => ({
      id: position.position_id ?? "",
      side: position.direction ?? "",
      volume: position.volume ?? "",
      price: position.open_price ?? "",
      instrument: position.instrument ?? "",
    }));
}

export function Terminal() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tape, setTape] = useState<Candle[]>(INITIAL_TAPE);
  const [cursor, setCursor] = useState(() => Math.min(INITIAL_TAPE.length - 1, INITIAL_TAPE.length - 140));
  const [session, setSession] = useState<Session>(() =>
    replay(INITIAL_TAPE, DEFAULT_SETTINGS, Math.min(INITIAL_TAPE.length - 1, INITIAL_TAPE.length - 140)),
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [source, setSource] = useState<"tape" | "exness">("tape");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [formError, setFormError] = useState<string | null>(null);
  const [creds, setCreds] = useState<Creds>({
    gateway: "",
    accountId: "",
    apiKey: "",
    privateKey: "",
    instrument: "XAUUSD",
  });
  const [broker, setBroker] = useState<Broker>(IDLE_BROKER);
  const [liveArmed, setLiveArmed] = useState(false);
  const [liveNote, setLiveNote] = useState("Live orders are off.");

  const tapeRef = useRef(tape);
  const sessionRef = useRef(session);
  const cursorRef = useRef(cursor);
  const settingsRef = useRef(settings);
  const sourceRef = useRef(source);
  const credsRef = useRef(creds);
  const brokerRef = useRef(broker);
  const armedAt = useRef<number | null>(null);
  const seenBar = useRef(0);
  tapeRef.current = tape;
  sessionRef.current = session;
  cursorRef.current = cursor;
  settingsRef.current = settings;
  sourceRef.current = source;
  credsRef.current = creds;
  brokerRef.current = broker;

  useEffect(() => {
    const saved = loadSettings();
    const error = validateSettings(saved);
    if (error) return;
    const nextTape = buildTape(TAPE_BARS);
    const nextCursor = Math.min(nextTape.length - 1, nextTape.length - 140);
    const nextSession = replay(nextTape, saved, nextCursor);
    tapeRef.current = nextTape;
    sessionRef.current = nextSession;
    cursorRef.current = nextCursor;
    setSettings(saved);
    setDraft(saved);
    setTape(nextTape);
    setCursor(nextCursor);
    setSession(nextSession);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) setPlaying(true);
  }, []);

  useEffect(() => {
    if (!playing || source !== "tape") return;
    const delay = speed === 12 ? 90 : speed === 4 ? 260 : 850;
    const timer = window.setInterval(() => {
      const next = cursorRef.current + 1;
      if (next >= tapeRef.current.length) tapeRef.current = extendTape(tapeRef.current, next + 48);
      const nextSession = step(sessionRef.current, tapeRef.current, next, settingsRef.current);
      cursorRef.current = next;
      sessionRef.current = nextSession;
      setTape(tapeRef.current);
      setCursor(next);
      setSession(nextSession);
    }, delay);
    return () => window.clearInterval(timer);
  }, [playing, speed, source]);

  const visible = tape.slice(0, cursor + 1);
  const last = visible[visible.length - 1];
  const decision = session.decision;
  const floating = session.position ? session.equity - session.balance : 0;
  const wins = session.fills.filter((fill) => fill.pnl > 0).length;

  const commit = (next: Settings) => {
    const error = validateSettings(next);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    settingsRef.current = next;
    setSettings(next);
    setDraft(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    const nextSession = replay(tapeRef.current, next, cursorRef.current);
    sessionRef.current = nextSession;
    setSession(nextSession);
  };

  const resetTape = () => {
    const nextTape = buildTape(TAPE_BARS);
    const nextCursor = Math.min(nextTape.length - 1, nextTape.length - 140);
    const nextSession = replay(nextTape, settingsRef.current, nextCursor);
    tapeRef.current = nextTape;
    cursorRef.current = nextCursor;
    sessionRef.current = nextSession;
    sourceRef.current = "tape";
    setSource("tape");
    setTape(nextTape);
    setCursor(nextCursor);
    setSession(nextSession);
    setPlaying(true);
  };

  const connect = async () => {
    setBroker((current) => ({ ...current, phase: "busy", detail: "Discovering the access point…" }));
    try {
      const result = await pullAccount(credsRef.current);
      const positions = mapSnapshot(result.snapshot);
      const next: Broker = {
        phase: "ready",
        detail: "Connected. Candles and orders stay in this browser.",
        access: result.access,
        name: result.account.account_name || "Account",
        currency: result.account.settings?.currency || "USD",
        leverage: result.account.settings?.leverage || "",
        tradeMode: result.account.settings?.trade_mode || "",
        accountStatus: result.account.settings?.account_status || "",
        balance: result.snapshot.account_state?.balance || "",
        equity: result.snapshot.account_state?.equity || "",
        margin: result.snapshot.account_state?.used_margin || "",
        digits: result.conditions.point_digits ?? 2,
        execMode: result.conditions.exec_mode || result.account.settings?.execution_mode || "",
        contract: Number(result.conditions.contract_size || 100),
        volMin: Number(result.conditions.volume_min || 0.01),
        volStep: Number(result.conditions.volume_step || 0.01),
        volMax: Number(result.conditions.volume_max || 50),
        positions,
      };
      brokerRef.current = next;
      setBroker(next);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not connect.";
      setBroker((current) => ({ ...current, phase: "error", detail }));
    }
  };

  const loadBrokerCandles = async () => {
    if (!brokerRef.current.access) return;
    setBroker((current) => ({ ...current, phase: "busy", detail: "Loading XAUUSD M5 candles…" }));
    try {
      const rows = await pullCandles(credsRef.current, brokerRef.current.access, 500);
      const candles: Candle[] = rows
        .map((row) => ({
          time: Date.parse(row.time || ""),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume) || 0,
          spread: 0.12,
        }))
        .filter((candle) => Number.isFinite(candle.time) && candle.high >= candle.low)
        .sort((a, b) => a.time - b.time);
      if (candles.length < 30) throw new Error("Not enough candles came back.");
      const nextCursor = candles.length - 1;
      const nextSession = replay(candles, settingsRef.current, nextCursor);
      tapeRef.current = candles;
      cursorRef.current = nextCursor;
      sessionRef.current = nextSession;
      sourceRef.current = "exness";
      seenBar.current = candles[candles.length - 1]?.time ?? 0;
      setPlaying(false);
      setSource("exness");
      setTape(candles);
      setCursor(nextCursor);
      setSession(nextSession);
      setBroker((current) => ({
        ...current,
        phase: "ready",
        detail: `${candles.length} broker candles on the chart. Fills below are still simulated until you arm live orders.`,
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Candle request failed.";
      setBroker((current) => ({ ...current, phase: "error", detail }));
    }
  };

  const closeBrokerPosition = async (positionId: string) => {
    const link = brokerRef.current;
    if (!link.access || link.phase !== "ready") return;
    if (link.tradeMode === "trading_disabled") {
      setLiveNote("Exness account trading is disabled; position close is unavailable through this API.");
      return;
    }
    if (!window.confirm(`Close Exness position ${positionId} at market?`)) return;
    setLiveNote(`Sending close request for ${positionId}…`);
    try {
      const ack = await closePosition(credsRef.current, link.access, positionId);
      if (ack.operation_id) {
        setLiveNote(`Close accepted · operation ${ack.operation_id}. Waiting for final execution status…`);
        window.setTimeout(async () => {
          try {
            const status = await readOperation(credsRef.current, link.access, ack.operation_id || "");
            setLiveNote(`Close operation ${ack.operation_id}: ${status.status || "pending"}${status.error_message ? ` · ${status.error_message}` : ""}`);
            if (status.status === "confirmed") await connect();
          } catch {
            setLiveNote(`Close operation ${ack.operation_id} is pending; reconnect to reconcile account state.`);
          }
        }, 1500);
      } else {
        setLiveNote("Close request accepted. Refresh the account to reconcile current positions.");
      }
    } catch (error) {
      setLiveNote(error instanceof Error ? error.message : "Position close request failed.");
    }
  };

  const sendLive = async (side: Side, candle: Candle) => {
    const link = brokerRef.current;
    const spec = settingsRef.current;
    if (!liveArmed || !armedAt.current || candle.time + 5 * 60 * 1000 < armedAt.current) return;
    if (link.tradeMode === "trading_disabled" || link.accountStatus === "close_only") {
      setLiveNote("Account cannot open positions.");
      return;
    }
    const entry = side === "buy" ? candle.close + candle.spread : candle.close;
    const sl = side === "buy" ? entry - spec.stopLossPrice : entry + spec.stopLossPrice;
    const digits = link.digits;
    const riskMoney = (Number(link.balance || PAPER_BALANCE) * spec.riskPercent) / 100;
    const lossPerLot = Math.abs(entry - sl) * (link.contract || 100);
    let volume = spec.useRiskPercent ? riskMoney / lossPerLot : spec.fixedLot;
    const stepSize = link.volStep || 0.01;
    volume = Math.floor(volume / stepSize) * stepSize;
    if (volume < link.volMin) {
      setLiveNote("Risk lot is below the instrument minimum.");
      return;
    }
    volume = Math.min(volume, link.volMax);
    const body: Record<string, string> = {
      instrument: credsRef.current.instrument.trim(),
      side,
      volume: volume.toFixed(Math.min(8, String(stepSize).split(".")[1]?.length ?? 2)),
      stop_loss_price: sl.toFixed(digits),
      comment: side === "buy" ? "VP v4 BUY" : "VP v4 SELL",
    };
    if (spec.takeProfitPrice > 0) {
      const tp = side === "buy" ? entry + spec.takeProfitPrice : entry - spec.takeProfitPrice;
      body.take_profit_price = tp.toFixed(digits);
    }
    if (link.execMode === "instant") {
      body.price = entry.toFixed(digits);
      body.deviation = String(spec.slippagePoints);
    }
    setLiveNote(side === "buy" ? "Sending buy…" : "Sending sell…");
    try {
      const ack = await placeMarket(credsRef.current, link.access, body);
      const operation = ack.operation_id ? `Operation ${ack.operation_id}` : "Accepted";
      setLiveNote(`${operation} · ${ack.status || "accepted"}`);
      if (ack.operation_id) {
        window.setTimeout(async () => {
          try {
            const status = await readOperation(credsRef.current, link.access, ack.operation_id || "");
            setLiveNote(`${operation} · ${status.status || "pending"}${status.error_message ? ` · ${status.error_message}` : ""}`);
          } catch {
            setLiveNote(`${operation} is still pending.`);
          }
        }, 1500);
      }
    } catch (error) {
      setLiveNote(error instanceof Error ? error.message : "Order was rejected.");
    }
  };

  useEffect(() => {
    if (source !== "exness" || broker.phase !== "ready" || !broker.access) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await pullAccount(credsRef.current);
        const positions = mapSnapshot(result.snapshot);
        setBroker((current) => ({
          ...current,
          balance: result.snapshot.account_state?.balance || current.balance,
          equity: result.snapshot.account_state?.equity || current.equity,
          margin: result.snapshot.account_state?.used_margin || current.margin,
          positions,
          detail: current.detail,
        }));
        const rows = await pullCandles(credsRef.current, brokerRef.current.access, 80);
        const fresh = rows
          .map((row) => ({
            time: Date.parse(row.time || ""),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume) || 0,
            spread: 0.12,
          }))
          .filter((candle) => candle.time > seenBar.current)
          .sort((a, b) => a.time - b.time);
        if (!fresh.length) return;
        let nextTape = tapeRef.current.slice();
        let nextSession = sessionRef.current;
        for (const candle of fresh) {
          nextTape = nextTape.concat(candle);
          nextSession = step(nextSession, nextTape, nextTape.length - 1, settingsRef.current);
          seenBar.current = candle.time;
          if (nextSession.decision.action === "buy" || nextSession.decision.action === "sell") {
            void sendLive(nextSession.decision.action, candle);
          }
        }
        tapeRef.current = nextTape;
        sessionRef.current = nextSession;
        cursorRef.current = nextTape.length - 1;
        setTape(nextTape);
        setSession(nextSession);
        setCursor(nextTape.length - 1);
      } catch {
        setLiveNote("Snapshot poll failed. Paper rules are unchanged.");
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [source, broker.phase, broker.access, liveArmed]);

  return (
    <main className="min-h-dvh bg-bg text-fg antialiased lg:h-dvh lg:overflow-hidden">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 p-3 lg:h-dvh lg:min-h-0 lg:p-4">
        <header className="panel flex flex-col gap-4 p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="neon-mark" aria-hidden="true" />
              <div>
                <p className="text-xs tracking-[0.22em] text-neon">VELA</p>
                <h1 className="text-balance text-xl font-semibold">Volume Profile Bounce</h1>
              </div>
            </div>
            <p className="mt-2 text-sm text-pretty text-muted">
              XAUUSD · M5 · rules from v4 · {source === "tape" ? "research tape" : "broker candles"}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <p className="text-xs text-muted">Bid</p>
              <p className="neon-text font-mono text-3xl font-medium tabular-nums">{last ? px(last.close) : "—"}</p>
            </div>
            <Stat label="Spread" value={last ? last.spread.toFixed(2) : "—"} />
            <Stat label="Balance" value={broker.balance && source === "exness" ? broker.balance : money(session.balance)} />
            <Stat label="Equity" value={broker.equity && source === "exness" ? broker.equity : money(session.equity)} />
            <Stat
              label="Net"
              value={money(session.balance - PAPER_BALANCE)}
              tone={session.balance >= PAPER_BALANCE ? "up" : "down"}
            />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[minmax(0,1fr)_15rem]">
          <section className="panel flex min-h-80 flex-col overflow-hidden lg:col-start-1 lg:row-start-1 lg:min-h-0">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <p className="text-xs text-muted">Profile {session.profile.valid ? "live" : "warming"} · SMA {settings.m5SmaPeriod}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn h-11" onClick={() => setPlaying((value) => !value)} disabled={source === "exness"}>
                  {playing ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  className="btn h-11"
                  onClick={() => {
                    if (source !== "tape") return;
                    const next = cursorRef.current + 1;
                    if (next >= tapeRef.current.length) tapeRef.current = extendTape(tapeRef.current, next + 8);
                    const nextSession = step(sessionRef.current, tapeRef.current, next, settings);
                    cursorRef.current = next;
                    sessionRef.current = nextSession;
                    setTape(tapeRef.current);
                    setCursor(next);
                    setSession(nextSession);
                  }}
                  disabled={source === "exness"}
                >
                  Step
                </button>
                {[1, 4, 12].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={speed === value ? "btn-neon h-11 px-3" : "btn h-11 px-3"}
                    onClick={() => setSpeed(value)}
                  >
                    {value}×
                  </button>
                ))}
              </div>
            </div>
            <PriceChart
              candles={visible}
              profile={session.profile}
              position={session.position}
              fills={session.fills}
              smaPeriod={settings.m5SmaPeriod}
            />
          </section>

          <aside className="flex min-h-0 flex-col gap-3 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <section className="panel p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Signal</h2>
                <button
                  type="button"
                  className={settings.enableTrading ? "btn-neon h-11 px-3" : "btn h-11 border-down px-3 text-down"}
                  onClick={() => commit({ ...settings, enableTrading: !settings.enableTrading })}
                >
                  {settings.enableTrading ? "Armed" : "Disarmed"}
                </button>
              </div>
              <p className="mt-3 text-sm text-pretty text-fg">{decision.note}</p>
              <div className="mt-2 divide-y divide-line text-sm">
                <Check on={decision.spreadOk} label="Spread" value={decision.spread ? decision.spread.toFixed(2) : "—"} />
                <Check
                  on={decision.profileOk}
                  label="VAL / POC / VAH"
                  value={
                    session.profile.valid
                      ? `${px(session.profile.val)} · ${px(session.profile.poc)} · ${px(session.profile.vah)}`
                      : "—"
                  }
                />
                <Check
                  on={decision.bullish || decision.bearish}
                  label="Trend"
                  value={
                    decision.trendReady
                      ? decision.bullish
                        ? "Bullish"
                        : decision.bearish
                          ? "Bearish"
                          : "Mixed"
                      : "Warming"
                  }
                />
                <Check
                  on={decision.buySignal || decision.sellSignal}
                  label="Bounce"
                  value={
                    decision.buyVal
                      ? "Buy VAL"
                      : decision.buyPoc
                        ? "Buy POC"
                        : decision.sellVah
                          ? "Sell VAH"
                          : decision.sellPoc
                            ? "Sell POC"
                            : "None"
                  }
                />
              </div>
            </section>

            <section className="panel p-4">
              <h2 className="text-sm font-semibold">Simulated position</h2>
              {session.position ? (
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <Info label="Side" value={session.position.side === "buy" ? "Long" : "Short"} />
                  <Info label="Lot" value={session.position.volume.toFixed(2)} />
                  <Info label="Open" value={px(session.position.openPrice)} />
                  <Info label="Float" value={money(floating)} />
                  <Info label="Stop" value={px(session.position.sl)} />
                  <Info label="Target" value={session.position.tp ? px(session.position.tp) : "—"} />
                </dl>
              ) : (
                <p className="mt-3 text-sm text-muted">Flat. One position at a time, same as the EA.</p>
              )}
              <p className="mt-3 text-xs text-muted">
                Margin {money(session.usedMargin)} · {wins}/{session.fills.length || 0} wins · magic {settings.magicNumber}
              </p>
            </section>

            <section className="panel min-h-0 flex-1 overflow-auto p-4">
              <h2 className="text-sm font-semibold">Exness</h2>
              <p className="mt-2 text-sm text-pretty text-muted">{broker.detail}</p>
              <div className="mt-3 grid gap-2">
                <TextField label="Gateway host" value={creds.gateway} onChange={(gateway) => setCreds({ ...creds, gateway })} placeholder="https://…" />
                <TextField label="Account" value={creds.accountId} onChange={(accountId) => setCreds({ ...creds, accountId })} placeholder="123456" />
                <TextField label="API key" value={creds.apiKey} onChange={(apiKey) => setCreds({ ...creds, apiKey })} placeholder="exnsk-…" />
                <TextField
                  label="Private key"
                  value={creds.privateKey}
                  onChange={(privateKey) => setCreds({ ...creds, privateKey })}
                  placeholder="128 hex or PKCS8 PEM"
                  secret
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn-neon h-11 px-3" onClick={() => void connect()} disabled={broker.phase === "busy"}>
                  {broker.phase === "busy" ? "Working" : "Connect"}
                </button>
                <button type="button" className="btn h-11" onClick={() => void loadBrokerCandles()} disabled={!broker.access || broker.phase === "busy"}>
                  Load candles
                </button>
                <button
                  type="button"
                  className={liveArmed ? "btn h-11 border-down text-down" : "btn h-11"}
                  onClick={() => {
                    const next = !liveArmed;
                    setLiveArmed(next);
                    armedAt.current = next ? Date.now() : null;
                    setLiveNote(next ? "Armed. Only a new closed candle can send an order." : "Live orders are off.");
                  }}
                  disabled={broker.phase !== "ready"}
                >
                  {liveArmed ? "Disarm live" : "Arm live"}
                </button>
              </div>
              <p className="mt-3 text-sm text-pretty text-fg">{liveNote}</p>
              {broker.phase === "ready" ? (
                <p className="mt-2 font-mono text-xs text-muted">
                  {broker.name} · {broker.currency} · 1:{broker.leverage || "—"} · {broker.tradeMode || "mode"} · {broker.accountStatus || "status"}
                </p>
              ) : null}
              {broker.positions.length ? (
                <ul className="mt-3 space-y-2 text-sm">
                  {broker.positions.map((position) => (
                    <li key={position.id} className="flex items-center justify-between gap-2 font-mono">
                      <span className="min-w-0">
                        {position.instrument} {position.side} · {position.volume} @ {position.price}
                      </span>
                      <button
                        type="button"
                        className="btn h-9 shrink-0 border-down px-2 text-down"
                        onClick={() => void closeBrokerPosition(position.id)}
                        disabled={!position.id || broker.phase !== "ready" || broker.tradeMode === "trading_disabled"}
                      >
                        Close
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </aside>

          <section className="panel flex min-h-64 flex-col overflow-hidden lg:col-start-1 lg:row-start-2 lg:min-h-0">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">Fills</h2>
              <div className="flex gap-2">
                <button type="button" className="btn h-11" onClick={resetTape}>
                  Reset tape
                </button>
                <button
                  type="button"
                  className="btn h-11"
                  onClick={() => {
                    setDraft(settings);
                    setSettingsOpen(true);
                  }}
                >
                  Rules
                </button>
              </div>
            </div>
            <div className="scroll min-h-0 flex-1 overflow-auto">
              {session.fills.length === 0 ? (
                <p className="p-4 text-sm text-muted">No fills yet. The desk is waiting for a rejection at VAL, POC, or VAH.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-medium">Time</th>
                      <th className="px-2 py-2 font-medium">Side</th>
                      <th className="px-2 py-2 font-medium">Lot</th>
                      <th className="hidden px-2 py-2 font-medium sm:table-cell">Open</th>
                      <th className="hidden px-2 py-2 font-medium sm:table-cell">Close</th>
                      <th className="px-2 py-2 font-medium">PnL</th>
                      <th className="px-4 py-2 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.fills
                      .slice()
                      .reverse()
                      .slice(0, 24)
                      .map((fill) => (
                        <tr key={fill.id} className="border-t border-line font-mono tabular-nums">
                          <td className="px-4 py-2 text-muted">{clock(fill.closeTime)}</td>
                          <td className={fill.side === "buy" ? "px-2 py-2 text-up" : "px-2 py-2 text-down"}>
                            {fill.side === "buy" ? "Buy" : "Sell"}
                          </td>
                          <td className="px-2 py-2">{fill.volume.toFixed(2)}</td>
                          <td className="hidden px-2 py-2 sm:table-cell">{px(fill.openPrice)}</td>
                          <td className="hidden px-2 py-2 sm:table-cell">{px(fill.closePrice)}</td>
                          <td className={fill.pnl >= 0 ? "px-2 py-2 text-up" : "px-2 py-2 text-down"}>{money(fill.pnl)}</td>
                          <td className="px-4 py-2 text-muted">{fill.trailed && fill.reason === "sl" ? "TRAIL" : fill.reason.toUpperCase()}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>

      {settingsOpen ? (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-bg/80 p-3 sm:items-center" role="presentation">
          <div className="panel max-h-[90dvh] w-full max-w-xl overflow-auto p-4" role="dialog" aria-modal="true" aria-label="Strategy rules">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Strategy rules</h2>
              <button type="button" className="btn h-11" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Risk %" value={draft.riskPercent} step="0.1" onChange={(riskPercent) => setDraft({ ...draft, riskPercent })} />
              <Field label="Fixed lot" value={draft.fixedLot} onChange={(fixedLot) => setDraft({ ...draft, fixedLot })} />
              <Field label="Stop $" value={draft.stopLossPrice} onChange={(stopLossPrice) => setDraft({ ...draft, stopLossPrice })} />
              <Field label="Target $" value={draft.takeProfitPrice} onChange={(takeProfitPrice) => setDraft({ ...draft, takeProfitPrice })} />
              <Field label="Lookback" value={draft.vpLookbackBars} step="1" onChange={(vpLookbackBars) => setDraft({ ...draft, vpLookbackBars })} />
              <Field label="Bins" value={draft.vpNumBins} step="1" onChange={(vpNumBins) => setDraft({ ...draft, vpNumBins })} />
              <Field label="Value area %" value={draft.vpValueAreaPct} step="1" onChange={(vpValueAreaPct) => setDraft({ ...draft, vpValueAreaPct })} />
              <Field label="Bounce tolerance" value={draft.vpBounceTolerance} onChange={(vpBounceTolerance) => setDraft({ ...draft, vpBounceTolerance })} />
              <Field label="M5 SMA" value={draft.m5SmaPeriod} step="1" onChange={(m5SmaPeriod) => setDraft({ ...draft, m5SmaPeriod })} />
              <Field label="H1 SMA" value={draft.h1SmaPeriod} step="1" onChange={(h1SmaPeriod) => setDraft({ ...draft, h1SmaPeriod })} />
              <Field label="Max spread" value={draft.maxSpreadPrice} onChange={(maxSpreadPrice) => setDraft({ ...draft, maxSpreadPrice })} />
              <Field label="ATR period" value={draft.atrPeriod} step="1" onChange={(atrPeriod) => setDraft({ ...draft, atrPeriod })} />
              <Field label="Trail × ATR" value={draft.trailAtrMult} onChange={(trailAtrMult) => setDraft({ ...draft, trailAtrMult })} />
              <Field label="Trail starts × ATR" value={draft.trailStartAtr} onChange={(trailStartAtr) => setDraft({ ...draft, trailStartAtr })} />
              <Field label="Min trail $" value={draft.trailMinPrice} onChange={(trailMinPrice) => setDraft({ ...draft, trailMinPrice })} />
              <Field label="Slippage pts" value={draft.slippagePoints} step="1" onChange={(slippagePoints) => setDraft({ ...draft, slippagePoints })} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Toggle on={draft.useRiskPercent} label="Risk percent" onClick={() => setDraft({ ...draft, useRiskPercent: !draft.useRiskPercent })} />
              <Toggle on={draft.allowBuy} label="Buys" onClick={() => setDraft({ ...draft, allowBuy: !draft.allowBuy })} />
              <Toggle on={draft.allowSell} label="Sells" onClick={() => setDraft({ ...draft, allowSell: !draft.allowSell })} />
              <Toggle on={draft.useM5Trend} label="M5 trend" onClick={() => setDraft({ ...draft, useM5Trend: !draft.useM5Trend })} />
              <Toggle on={draft.useH1Trend} label="H1 trend" onClick={() => setDraft({ ...draft, useH1Trend: !draft.useH1Trend })} />
              <Toggle on={draft.useAtrTrailing} label="ATR trail" onClick={() => setDraft({ ...draft, useAtrTrailing: !draft.useAtrTrailing })} />
            </div>
            {formError ? <p className="mt-3 text-sm text-down">{formError}</p> : null}
            <p className="mt-3 text-xs text-pretty text-muted">
              SpreadSafetyMult is on the EA inputs but v4 never reads it, so it is not applied here. ATR trail arms after one ATR of profit, then ratchets by the larger of half an ATR and the minimum distance.
            </p>
            <button
              type="button"
              className="btn-neon mt-4 h-11 px-4"
              onClick={() => {
                commit(draft);
                if (!validateSettings(draft)) setSettingsOpen(false);
              }}
            >
              Apply and replay
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={tone === "up" ? "font-mono text-lg tabular-nums text-up" : tone === "down" ? "font-mono text-lg tabular-nums text-down" : "font-mono text-lg tabular-nums"}>
        {value}
      </p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={on ? "btn-neon h-11 px-3" : "btn h-11 px-3"} onClick={onClick} aria-pressed={on}>
      {label}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  secret?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg"
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
