import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Strict-ish CSP without nonces (next/dist/docs: content-security-policy "Without Nonces").
// 'unsafe-inline' scripts are needed for the no-flash theme script and Next's bootstrap.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The demo workspace is seeded from the synthetic fixtures' expected JSON (never
  // the PDFs or CSVs); the seed's file reads are dynamic, so they're listed here.
  outputFileTracingIncludes: {
    "/api/demo": ["./evals/fixtures/synthetic/{dbs,uob,posb,uob-one}/*-??.expected.json"],
  },
  outputFileTracingExcludes: {
    "/api/demo": [
      "./evals/fixtures/synthetic/**/*.{pdf,csv}",
      "./evals/fixtures/synthetic/**/*.csv.expected.json",
      "./evals/fixtures/synthetic/{ledger.json,variants/**}",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
