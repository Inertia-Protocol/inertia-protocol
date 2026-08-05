import { ImageResponse } from "next/og";

// Required for `output: "export"` -- without it Next can't tell this route
// is safe to render once at build time rather than per-request.
export const dynamic = "force-static";

export const alt = "Inertia Protocol -- stall recovery, on chain.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Deliberately no custom font loading here -- next/og's bundled default
// font renders reliably in any build environment (including Cloudflare's),
// where fetching a Google Fonts file at build time is one more thing that
// can silently fail. Brand identity comes from the exact site palette
// instead (see site/app/globals.css), not from matching Bodoni Moda here.
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#262f38",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: "#e0a63a",
            display: "flex",
          }}
        />
        <div
          style={{
            display: "flex",
            fontSize: 132,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "#ece7d6",
          }}
        >
          INERTIA
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 40,
            color: "#e0a63a",
            marginTop: 20,
          }}
        >
          Stall recovery, on chain.
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            color: "#8a93a0",
            marginTop: 36,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Live on Solana devnet &middot; unaudited &middot; pre-mainnet
        </div>
      </div>
    ),
    { ...size }
  );
}
