import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  env: {
    NEXT_PUBLIC_GAME_TRANSPORT: process.env.VERCEL === "1" || process.env.SUPABASE_URL ? "http" : "socket",
  },
};

export default nextConfig;
