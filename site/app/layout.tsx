import type { Metadata } from "next";
import { Geist, Geist_Mono, Bodoni_Moda } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bodoniModa = Bodoni_Moda({
  variable: "--font-bodoni",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
});

const SITE_URL = "https://inertia-protocol.odomushi-core.workers.dev";
const DESCRIPTION =
  "A Solana program that rescues stalled swaps via keeper bot economics, before they turn into a bad fill.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Inertia Protocol",
  description: DESCRIPTION,
  openGraph: {
    title: "Inertia Protocol",
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Inertia Protocol",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Inertia Protocol",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bodoniModa.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
