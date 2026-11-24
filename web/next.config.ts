import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  outputFileTracingRoot: path.join(__dirname),
  trailingSlash: false,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
