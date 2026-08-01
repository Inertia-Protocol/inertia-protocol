"use client";

import { useEffect, useRef, useState } from "react";

type Stage = "moving" | "stalled" | "rescued";

const STAGE_COLOR: Record<Stage, string> = {
  moving: "var(--accent)",
  stalled: "var(--danger)",
  rescued: "var(--success)",
};

const STAGE_LABEL: Record<Stage, string> = {
  moving: "pending",
  stalled: "stalled",
  rescued: "rescued",
};

function Spark({ color }: { color: string }) {
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" fill="none">
      <path d="M8 0L0 10.5H5.5L5 18L14 6.5H8L8 0Z" fill={color} />
    </svg>
  );
}

export default function RescueHero() {
  const [pct, setPct] = useState(0);
  const [keeperPct, setKeeperPct] = useState(38);
  const [stage, setStage] = useState<Stage>("moving");
  const [slot, setSlot] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    function clearTimers() {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    }

    function run() {
      clearTimers();
      setPct(0);
      setStage("moving");
      setSlot(0);

      let p = 0;
      const moveInterval = window.setInterval(() => {
        p += 2;
        setPct(Math.min(p, 38));
        if (p >= 38) {
          window.clearInterval(moveInterval);
          stall();
        }
      }, 40);
      timers.current.push(moveInterval);
    }

    function stall() {
      setStage("stalled");
      let s = 0;
      const tickInterval = window.setInterval(() => {
        s += 1;
        setSlot(s);
        if (s >= 3) {
          window.clearInterval(tickInterval);
          rescue();
        }
      }, 550);
      timers.current.push(tickInterval);
    }

    function rescue() {
      setStage("rescued");
      let p = 38;
      const endInterval = window.setInterval(() => {
        p += 3;
        const clamped = Math.min(p, 100);
        setPct(clamped);
        setKeeperPct(clamped);
        if (p >= 100) {
          window.clearInterval(endInterval);
          const resetTimeout = window.setTimeout(run, 2400);
          timers.current.push(resetTimeout);
        }
      }, 30);
      timers.current.push(endInterval);
    }

    run();
    return clearTimers;
  }, []);

  const color = STAGE_COLOR[stage];

  return (
    <div style={{ width: "100%", maxWidth: 560 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 40,
        }}
      >
        <span className="eyebrow">Wallet</span>
        <span className="eyebrow">Destination</span>
      </div>

      <div style={{ position: "relative", marginBottom: 36 }}>
        <div
          style={{
            height: 1,
            background: "var(--border-strong)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: 1,
            width: `${pct}%`,
            background: color,
            transition: "background-color 0.4s ease",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: `${pct}%`,
            width: 9,
            height: 9,
            marginTop: -4.5,
            marginLeft: -4.5,
            borderRadius: "50%",
            background: color,
            transition: "background-color 0.4s ease",
            boxShadow: stage === "stalled" ? `0 0 0 5px ${"var(--accent-dim)"}` : "none",
          }}
        />
        {stage === "rescued" && (
          <div
            style={{
              position: "absolute",
              top: -24,
              left: `${keeperPct}%`,
              marginLeft: -7,
            }}
          >
            <Spark color="var(--success)" />
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            padding: "6px 14px",
            border: `1px solid ${color}`,
            color,
            transition: "color 0.4s ease, border-color 0.4s ease",
          }}
        >
          {STAGE_LABEL[stage]}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          slot +{slot}
        </span>
      </div>
    </div>
  );
}
