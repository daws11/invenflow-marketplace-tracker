/** @type {import('next').NextConfig} */
const nextConfig = {
  // `output: 'standalone'` produces a minimal self-contained server bundle in
  // `.next/standalone/` that we copy into the runtime stage of the Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // Caddy proxies the app behind ${DOMAIN}; the exact origin is only
      // known at runtime, so we permit any origin here. This is safe because
      // session/CSRF protection is handled at the auth layer.
      allowedOrigins: ['*'],
    },
  },
};

module.exports = nextConfig;
