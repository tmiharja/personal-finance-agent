import { z } from "zod";

// Public, non-secret site config. NEXT_PUBLIC_* values are inlined at build time.
const portfolioUrl = z.url().safeParse(process.env.NEXT_PUBLIC_PORTFOLIO_URL);

export const site = {
  name: "Finance Agent",
  description:
    "Your SG bank and card statements, categorised and explained. Finds subscriptions, bills and unusual charges, answers questions, and never acts without your approval.",
  credit: "toninmotion",
  portfolioUrl: portfolioUrl.success ? portfolioUrl.data : undefined,
} as const;
