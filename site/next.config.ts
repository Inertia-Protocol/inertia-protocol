import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin explicitly -- an unrelated lockfile in the user's broader Documents
    // folder (outside this repo) otherwise gets picked up by Next's root
    // auto-inference, since it also lives above this directory.
    root: path.join(__dirname),
  },
};

export default nextConfig;
