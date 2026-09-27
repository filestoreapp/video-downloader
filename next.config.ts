import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bundle the standalone binaries (downloaded by postinstall into ./bin)
  // into the API functions so extraction/processing can spawn them.
  // (On plain Node hosts like Koyeb the files are simply present on disk;
  // this matters for serverless targets.)
  outputFileTracingIncludes: {
    "/api/dl/extract": ["./bin/yt-dlp"],
    "/api/dl/process": ["./bin/yt-dlp", "./bin/ffmpeg"],
  },
};

export default nextConfig;
