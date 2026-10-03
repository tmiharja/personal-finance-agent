/**
 * Curated global merchant map (PRD CAT-2, CAT-3): well-known Singapore and
 * online merchants → a clean name and a default category. It is public
 * knowledge, not user data. Matched against the *sanitised* descriptor.
 *
 * KEYWORDS catch generic businesses ("… CLINIC", "… RAMEN …") with a category
 * only; the merchant name then comes from the descriptor.
 */

export type CategoryName =
  | "Dining"
  | "Groceries"
  | "Transport"
  | "Shopping"
  | "Bills & Utilities"
  | "Telco & Internet"
  | "Insurance"
  | "Health"
  | "Entertainment"
  | "Subscriptions"
  | "Travel"
  | "Education"
  | "Home"
  | "Fees & Charges"
  | "Gifts & Donations"
  | "Cashback & Rewards"
  | "Income"
  | "Transfers"
  | "Uncategorised";

/** merchant null: a group of brands; the name then comes from the descriptor itself. */
type Entry = readonly [pattern: RegExp, merchant: string | null, category: CategoryName | null];

export const MERCHANTS: readonly Entry[] = [
  // Card system rows (category comes from the row kind)
  [/^(AUTOPAY|GIRO PAYMENT|PAYMENT - THANK YOU|PAYMT THRU)/i, "Card payment", null],
  [
    /^(ANNUAL FEE|GST @|LATE (PAYMENT )?(FEE|CHARGE)|FINANCE CHARGE|INTEREST CHARGE)/i,
    "Card fees",
    null,
  ],
  [/\bCASHBACK$/i, "Card cashback", null],
  // Transport
  [/^GRAB\s*FOOD\b/i, "GrabFood", "Dining"],
  [/^GRAB(\*|\s|$)/i, "Grab", "Transport"],
  [/^GOJEK\b/i, "Gojek", "Transport"],
  [/^(BUS\/MRT|SIMPLYGO|TRANSITLINK)\b/i, "SimplyGo / Transit", "Transport"],
  [/^(COMFORTDELGRO|CDG TAXI|ZIG\b)/i, "ComfortDelGro", "Transport"],
  [/^TADA\b/i, "TADA", "Transport"],
  [/^(SHELL|ESSO|CALTEX|SPC|SINOPEC)\b/i, null, "Transport"],
  [/^(EZ-?LINK|EZLINK)\b/i, "EZ-Link", "Transport"],
  // Groceries
  [/^(NTUC )?FAIRPRICE\b/i, "FairPrice", "Groceries"],
  [/^COLD STORAGE\b/i, "Cold Storage", "Groceries"],
  [/^GIANT\b/i, "Giant", "Groceries"],
  [/^SHENG SIONG\b/i, "Sheng Siong", "Groceries"],
  [/^DON DON DONKI\b/i, "Don Don Donki", "Groceries"],
  [/^(REDMART|RED MART)\b/i, "RedMart", "Groceries"],
  [/^(7-ELEVEN|7 ELEVEN|SEVEN ELEVEN)\b/i, "7-Eleven", "Groceries"],
  // Dining
  [/^STARBUCKS\b/i, "Starbucks", "Dining"],
  [/^TOAST BOX\b/i, "Toast Box", "Dining"],
  [/^YA KUN\b/i, "Ya Kun", "Dining"],
  [/^KOPITIAM\b/i, "Kopitiam", "Dining"],
  [/^(MCDONALD'?S|MCD\b)/i, "McDonald's", "Dining"],
  [/^(KFC|BURGER KING|SUBWAY|MOS BURGER|JOLLIBEE)\b/i, null, "Dining"],
  [/^FOODPANDA\b/i, "foodpanda", "Dining"],
  [/^DELIVEROO\b/i, "Deliveroo", "Dining"],
  [/^(DIN TAI FUNG|PEPPER LUNCH|SUKIYA|GENKI SUSHI|SUSHIRO)\b/i, null, "Dining"],
  [/^(COFFEE BEAN|FLASH COFFEE|LUCKIN)\b/i, null, "Dining"],
  // Shopping
  [/^SHOPEE\b/i, "Shopee", "Shopping"],
  [/^LAZADA\b/i, "Lazada", "Shopping"],
  [/^(AMAZON|AMZN)\b/i, "Amazon", "Shopping"],
  [/^TAOBAO\b/i, "Taobao", "Shopping"],
  [/^UNIQLO\b/i, "Uniqlo", "Shopping"],
  [/^(H&M|ZARA|COTTON ON|DECATHLON|CHARLES & KEITH)\b/i, null, "Shopping"],
  [/^(DAISO|MINISO)\b/i, null, "Shopping"],
  [/^(CHALLENGER|BEST DENKI|HARVEY NORMAN|GAIN CITY)\b/i, null, "Shopping"],
  [/^COURTS\b/i, "Courts", "Home"],
  [/^IKEA\b/i, "IKEA", "Home"],
  // Health
  [/^(WATSONS|GUARDIAN|UNITY)\b/i, null, "Health"],
  // Entertainment
  [/^(GOLDEN VILLAGE|GV\b|SHAW THEATRES|CATHAY CINEPLEXES)/i, null, "Entertainment"],
  [/^(STEAM|STEAMGAMES|PLAYSTATION|NINTENDO|XBOX)\b/i, null, "Entertainment"],
  // Subscriptions
  [/^NETFLIX\b/i, "Netflix", "Subscriptions"],
  [/^SPOTIFY\b/i, "Spotify", "Subscriptions"],
  [/^APPLE\.COM\/BILL\b/i, "Apple", "Subscriptions"],
  [/^GOOGLE\s*\*?\s*(YOUTUBE|STORAGE|GOOGLE ONE|PLAY)/i, "Google", "Subscriptions"],
  [/^(DISNEY PLUS|DISNEYPLUS)\b/i, "Disney Plus", "Subscriptions"],
  [/^(OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI)\b/i, null, "Subscriptions"],
  [/^(ADOBE|MICROSOFT\*|MSFT\*|DROPBOX)\b/i, null, "Subscriptions"],
  // Telco & utilities
  [/^SINGTEL\b/i, "Singtel", "Telco & Internet"],
  [/^STARHUB\b/i, "StarHub", "Telco & Internet"],
  [/^(M1 |M1LIMITED|M1 LIMITED)/i, "M1", "Telco & Internet"],
  [/^(CIRCLES\.?LIFE|GIGA|SIMBA|MYREPUBLIC)\b/i, null, "Telco & Internet"],
  [/^(SP DIGITAL|SP SERVICES|SP GROUP)\b/i, "SP Group", "Bills & Utilities"],
  [/^(GENECO|SENOKO|TUAS POWER|KEPPEL ELECTRIC)\b/i, null, "Bills & Utilities"],
  [/^(TOWN COUNCIL|.* TOWN COUNCIL)\b/i, null, "Bills & Utilities"],
  // Insurance
  [
    /^(AIA|PRUDENTIAL|GREAT EASTERN|INCOME INSURANCE|NTUC INCOME|AVIVA|SINGLIFE|FWD)\b/i,
    null,
    "Insurance",
  ],
  // Travel
  [/^(SINGAPORE AIRLINES|SIA\b|SCOOT|JETSTAR|AIRASIA|CATHAY PACIFIC)/i, null, "Travel"],
  [/^(AGODA|BOOKING\.COM|AIRBNB|EXPEDIA|TRIP\.COM|KLOOK)\b/i, null, "Travel"],
];

export const KEYWORDS: readonly [RegExp, CategoryName][] = [
  [/\b(CLINIC|MEDICAL|DENTAL|HOSPITAL|PHARMACY|POLYCLINIC|PHYSIO)\b/i, "Health"],
  [/\b(FITNESS|GYM|YOGA|PILATES)\b/i, "Health"],
  [
    /\b(RESTAURANT|RAMEN|SUSHI|CAFE|COFFEE|BAKERY|FOOD COURT|HAWKER|BISTRO|BAR & GRILL|EATERY|KITCHEN|NOODLE|DIM SUM)\b/i,
    "Dining",
  ],
  [/\b(SUPERMARKET|MART|GROCER)\b/i, "Groceries"],
  [/\b(HOTEL|HOSTEL|RYOKAN|RESORT|AIRLINES?|AIRWAYS)\b/i, "Travel"],
  [/\b(BOOKSTORE|BOOKSHOP|SCHOOL|TUITION|ACADEMY|COURSE|UDEMY|COURSERA)\b/i, "Education"],
  [/\b(CINEMA|THEATRE|KARAOKE|BOWLING)\b/i, "Entertainment"],
  [/\b(FURNITURE|HARDWARE|MEGASTORE)\b/i, "Home"],
  [/\b(CHARITY|DONATION|FOUNDATION)\b/i, "Gifts & Donations"],
];

/** The curated name and category for a sanitised descriptor, if known. */
export function lookupMerchant(
  descriptor: string,
): { merchant: string | null; category: CategoryName | null } | null {
  for (const [re, merchant, category] of MERCHANTS) {
    if (re.test(descriptor)) return { merchant, category };
  }
  for (const [re, category] of KEYWORDS) {
    if (re.test(descriptor)) return { merchant: null, category };
  }
  return null;
}
