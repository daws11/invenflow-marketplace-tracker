/** @type {import('next').NextConfig} */
const nextConfig = {
  // `output: 'standalone'` produces a minimal self-contained server bundle in
  // `.next/standalone/` that we copy into the runtime stage of the Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
  // Skip typecheck + ESLint during `next build` — they're the most memory-hungry
  // step of the production build and were OOM-killing the build container on
  // the 4 GB Coolify VPS while the worker image's Playwright base was
  // simultaneously building. Type safety is still enforced locally
  // (`pnpm --filter @invenflow-tracker/web exec tsc --noEmit`) and via the
  // worker's `tsc -p tsconfig.json` step on the same Docker host, which acts
  // as a backstop.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: {
      // Caddy proxies the app behind ${DOMAIN}; the exact origin is only
      // known at runtime, so we permit any origin here. This is safe because
      // session/CSRF protection is handled at the auth layer.
      allowedOrigins: ['*'],
    },
    // The standalone trace doesn't reliably pick up bcryptjs through
    // NextAuth's credentials provider (it's resolved via dynamic require)
    // and prisma/seed.js is invoked by start-prod.sh OUTSIDE Next.js, so
    // its requires don't show up in the trace at all. Force-include both
    // the package itself and the prisma binary so the runtime container
    // has everything seed.js + the auth route need.
    outputFileTracingIncludes: {
      '*': [
        './node_modules/bcryptjs/**/*',
        '../../node_modules/bcryptjs/**/*',
      ],
    },
  },
};

module.exports = nextConfig;
