import { useEffect, useRef, type MouseEvent } from "react";
import type { Candle, Fill, Position, Profile } from "@/lib/vp/engine";
import { smaSeries } from "@/lib/vp/engine";

type Props = {
  candles: Candle[];
  profile: Profile;
  position: Position | null;
  fills: Fill[];
  smaPeriod: number;
};

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function PriceChart({ candles, profile, position, fills, smaPeriod }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (width < 20 || height < 20) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const neon = cssVar("--color-neon", "#3ee0ff");
      const up = cssVar("--color-up", "#3dffb0");
      const down = cssVar("--color-down", "#ff5b73");
      const fg = cssVar("--color-fg", "#e7eefc");
      const muted = cssVar("--color-muted", "#8b98b0");
      const line = cssVar("--color-line", "#2a3348");
      const bg = cssVar("--color-bg", "#07080d");

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      const viewCount = Math.min(96, candles.length);
      const start = Math.max(0, candles.length - viewCount);
      const view = candles.slice(start);
      if (!view.length) return;

      const averages = smaSeries(candles, smaPeriod);
      const padL = 8;
      const padT = 16;
      const padB = 28;
      const scaleW = 64;
      const profileW = 84;
      const plotR = width - scaleW - profileW - 8;
      const plotB = height - padB;
      const plotW = Math.max(10, plotR - padL);
      const plotH = Math.max(10, plotB - padT);

      let min = Infinity;
      let max = -Infinity;
      for (const candle of view) {
        if (candle.low < min) min = candle.low;
        if (candle.high > max) max = candle.high;
      }
      if (profile.valid) {
        min = Math.min(min, profile.val, profile.poc, profile.vah);
        max = Math.max(max, profile.val, profile.poc, profile.vah);
      }
      if (position) {
        min = Math.min(min, position.sl, position.openPrice);
        max = Math.max(max, position.sl, position.openPrice);
        if (position.tp > 0) {
          min = Math.min(min, position.tp);
          max = Math.max(max, position.tp);
        }
      }
      const span = Math.max(0.5, max - min);
      min -= span * 0.06;
      max += span * 0.06;
      const yOf = (price: number) => padT + ((max - price) / (max - min)) * plotH;
      const xOf = (offset: number) => padL + (offset + 0.5) * (plotW / view.length);

      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.font = "11px IBM Plex Mono, ui-monospace, monospace";
      ctx.fillStyle = muted;
      for (let g = 0; g < 5; g++) {
        const price = min + ((max - min) * g) / 4;
        const y = yOf(price);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
        ctx.fillText(price.toFixed(2), plotR + 8, y + 4);
      }

      const slot = plotW / view.length;
      const bodyW = Math.max(2, Math.min(8, slot * 0.62));
      view.forEach((candle, offset) => {
        const x = xOf(offset);
        const rising = candle.close >= candle.open;
        ctx.strokeStyle = rising ? up : down;
        ctx.fillStyle = rising ? up : down;
        ctx.beginPath();
        ctx.moveTo(x, yOf(candle.high));
        ctx.lineTo(x, yOf(candle.low));
        ctx.stroke();
        const top = yOf(Math.max(candle.open, candle.close));
        const bottom = yOf(Math.min(candle.open, candle.close));
        ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, bottom - top));
      });

      ctx.beginPath();
      ctx.strokeStyle = neon;
      ctx.lineWidth = 1.4;
      let started = false;
      view.forEach((_, offset) => {
        const value = averages[start + offset];
        if (value == null) return;
        const x = xOf(offset);
        const y = yOf(value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      });
      ctx.stroke();

      const level = (price: number, color: string, label: string, dash: number[]) => {
        if (price < min || price > max) return;
        const y = yOf(price);
        ctx.save();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = color;
        ctx.fillText(label, padL + 6, y - 4);
      };
      if (profile.valid) {
        level(profile.val, muted, "VAL", [4, 4]);
        level(profile.vah, muted, "VAH", [4, 4]);
        level(profile.poc, neon, "POC", []);
      }
      if (position) {
        level(position.openPrice, fg, position.side === "buy" ? "LONG" : "SHORT", [2, 3]);
        level(position.sl, down, "SL", [3, 3]);
        if (position.tp > 0) level(position.tp, up, "TP", [3, 3]);
      }

      const maxVol = profile.bins.reduce((peak, bin) => Math.max(peak, bin.volume), 0);
      let pocIndex = 0;
      profile.bins.forEach((bin, index) => {
        if (bin.volume > (profile.bins[pocIndex]?.volume ?? -1)) pocIndex = index;
      });
      profile.bins.forEach((bin, index) => {
        if (bin.high < min || bin.low > max) return;
        const y1 = yOf(bin.high);
        const y2 = yOf(bin.low);
        const h = Math.max(1, y2 - y1 - 1);
        const w = maxVol > 0 ? (bin.volume / maxVol) * (profileW - 16) : 0;
        ctx.fillStyle = neon;
        ctx.globalAlpha = index === pocIndex ? 0.95 : 0.32;
        ctx.fillRect(width - profileW + 6, y1, w, h);
        ctx.globalAlpha = 1;
      });

      const opens = new Set(fills.map((fill) => fill.openTime));
      view.forEach((candle, offset) => {
        if (!opens.has(candle.time)) return;
        const fill = fills.find((item) => item.openTime === candle.time);
        if (!fill) return;
        ctx.fillStyle = fill.side === "buy" ? up : down;
        const x = xOf(offset);
        const y = yOf(fill.side === "buy" ? candle.low : candle.high);
        ctx.beginPath();
        if (fill.side === "buy") {
          ctx.moveTo(x, y + 10);
          ctx.lineTo(x - 4, y + 3);
          ctx.lineTo(x + 4, y + 3);
        } else {
          ctx.moveTo(x, y - 10);
          ctx.lineTo(x - 4, y - 3);
          ctx.lineTo(x + 4, y - 3);
        }
        ctx.fill();
      });

      const hover = hoverRef.current;
      if (hover != null && hover >= start && hover < candles.length) {
        const offset = hover - start;
        const x = xOf(offset);
        ctx.strokeStyle = muted;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, plotB);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = muted;
      ctx.fillText("M5", padL, height - 8);
      const first = view[0];
      const last = view[view.length - 1];
      const stamp = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
      ctx.fillText(stamp(first.time), padL + 28, height - 8);
      const endLabel = stamp(last.time);
      ctx.fillText(endLabel, plotR - ctx.measureText(endLabel).width, height - 8);
    };

    drawRef.current = draw;
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [candles, profile, position, fills, smaPeriod]);

  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const viewCount = Math.min(96, candles.length);
    const start = Math.max(0, candles.length - viewCount);
    const plotR = rect.width - 64 - 84 - 8;
    const plotW = Math.max(10, plotR - 8);
    const offset = Math.floor(((x - 8) / plotW) * viewCount);
    hoverRef.current = offset >= 0 && offset < viewCount ? start + offset : null;
    drawRef.current();
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-80 min-h-80 w-full flex-1 lg:h-full lg:min-h-0"
      onMouseMove={onMove}
      onMouseLeave={() => {
        hoverRef.current = null;
        drawRef.current();
      }}
    >
      <canvas ref={canvasRef} aria-label="XAUUSD five minute chart" className="block h-full w-full" />
    </div>
  );
}
