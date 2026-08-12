/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export for Cloudflare Pages deployment
  output: "export",
  images: { unoptimized: true },
  // Dev-only rewrites (proxy API calls to the toque Worker to avoid CORS)
  async rewrites() {
    const workerUrl = process.env.TOQUE_WORKER_URL || "https://toque.decloud.workers.dev";
    return [
      { source: "/api/proxy/:path*", destination: `${workerUrl}/:path*` },
      { source: "/api/proxy-autha/:path*", destination: `${workerUrl}/autha/:path*` },
      { source: "/api/proxy-app/:path*", destination: `${workerUrl}/app/:path*` },
      { source: "/api/proxy-mcp/:path*", destination: `${workerUrl}/mcp/:path*` },
    ];
  },
};

export default nextConfig;
