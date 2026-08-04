import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // Every route here is provably static (loadDoc() just reads local
  // markdown files, no request-specific data anywhere) -- exporting to
  // plain HTML/CSS/JS means deployment needs no Next.js server runtime at
  // all, just a static-file host. Confirmed clean: no next/image,
  // headers(), redirects(), or rewrites() anywhere in this app, all of
  // which static export doesn't support.
  output: "export",
  turbopack: {
    // Pin explicitly -- an unrelated lockfile in the user's broader Documents
    // folder (outside this repo) otherwise gets picked up by Next's root
    // auto-inference, since it also lives above this directory.
    root: path.join(__dirname),
  },
};

export default nextConfig;
