"use client";

import { useEffect, useRef, useState } from "react";

type Stage = "moving" | "stalled" | "rescued";

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
      }, 500);
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
          const resetTimeout = window.setTimeout(run, 2200);
          timers.current.push(resetTimeout);
        }
      }, 30);
      timers.current.push(endInterval);
    }

    run();
    return clearTimers;
  }, []);

  const badgeColor =
    stage === "stalled"
      ? "var(--danger)"
      : stage === "rescued"
        ? "var(--success)"
        : "var(--accent)";

  const badgeLabel =
    stage === "stalled" ? "stalled" : stage === "rescued" ? "rescued" : "pending";

  return (
    <div style={{ maxWidth: 480, width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 32 }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)", letterSpacing: 1 }}>
          WALLET
        </span>
        <span style={{ fontSize: 13, color: "var(--text-muted)", letterSpacing: 1 }}>
          DESTINATION
        </span>
      </div>

      <div
        style={{
          position: "relative",
          height: 2,
          background: "var(--border)",
          marginBottom: 28,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: `${pct}%`,
            background: badgeColor,
            transition: "background 0.3s",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: `${pct}%`,
            width: 10,
            height: 10,
            marginTop: -5,
            marginLeft: -5,
            borderRadius: "50%",
            background: badgeColor,
            transition: "background 0.3s",
          }}
        />
        {stage === "rescued" && (
          <div
            style={{
              position: "absolute",
              top: -26,
              left: `${keeperPct}%`,
              marginLeft: -8,
              fontSize: 15,
              color: "var(--accent)",
            }}
          >
            ⚡
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          fontFamily: "var(--font-mono)",
          fontSize: 13,
        }}
      >
        <span
          style={{
            padding: "4px 12px",
            border: `1px solid ${badgeColor}`,
            color: badgeColor,
            letterSpacing: 1,
          }}
        >
          {badgeLabel}
        </span>
        <span style={{ color: "var(--text-muted)" }}>slot +{slot}</span>
      </div>
    </div>
  );
}
