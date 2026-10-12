import { z } from "zod";

// Demo sellers. Every name, place and number below is fictional and labeled as
// such in each tool response; the point is the payment flow, not the data.

export const DEMO_NOTICE = "Demo data: fictional sellers, places and figures.";

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  /** USD price per call, e.g. "0.05". Omit for free tools. */
  price?: string;
  inputSchema: z.ZodRawShape;
  run: (args: Record<string, unknown>) => unknown;
}

export interface SellerSpec {
  id: string;
  name: string;
  description: string;
  tools: ToolSpec[];
}

const ARTICLES: Record<string, { title: string; date: string; body: string }> = {
  "pa-0412": {
    title: "Ferry timetable change brings weekday crowds to the Port Alder waterfront",
    date: "2026-09-28",
    body:
      "Since the new 7:40 commuter ferry started in August, weekday foot traffic on Harbor Street rose about 18% (city counter data). " +
      "Morning visits concentrate between 7:50 and 9:30. Two cafés near the terminal report sold-out cold drinks before 10:00 on warm days.",
  },
  "pa-0419": {
    title: "Oat milk shortage eases as regional dairy co-op adds a second line",
    date: "2026-10-03",
    body:
      "The Alder Valley co-op says its new oat line doubles output from November. Wholesale buyers were quoted 9–12% lower prices for winter contracts. " +
      "Smaller cafés can now order in 10-carton lots instead of 40.",
  },
  "pa-0423": {
    title: "City council debates summer street-seating permits",
    date: "2026-10-07",
    body:
      "A proposal would let waterfront cafés add up to six outdoor tables from May to September for a flat $240 permit. A vote is expected in December.",
  },
};

export const SELLERS: SellerSpec[] = [
  {
    id: "harbor-gazette",
    name: "Harbor Gazette",
    description: "Independent local newsroom. Headlines are free; full articles are pay-per-read.",
    tools: [
      {
        name: "search_headlines",
        title: "Search headlines (free)",
        description: "Search local news headlines. Free. Returns article ids you can buy with read_article.",
        inputSchema: { query: z.string().describe("Keywords") },
        run: ({ query }) => {
          const q = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
          const hits = Object.entries(ARTICLES)
            .filter(([, a]) => !q.length || q.some((w) => (a.title + " " + a.body).toLowerCase().includes(w)))
            .map(([id, a]) => ({ id, title: a.title, date: a.date, price: "$0.05" }));
          return { results: hits.length ? hits : Object.entries(ARTICLES).map(([id, a]) => ({ id, title: a.title, date: a.date, price: "$0.05" })) };
        },
      },
      {
        name: "read_article",
        title: "Read full article",
        description: "Full text of one article. $0.05 per article.",
        price: "0.05",
        inputSchema: { id: z.string().describe("Article id from search_headlines") },
        run: ({ id }) => {
          const a = ARTICLES[String(id)];
          if (!a) throw new Error(`no article ${String(id)}`);
          return { id, ...a };
        },
      },
    ],
  },
  {
    id: "openfield-data",
    name: "Openfield Data",
    description: "Small-business market data: wholesale prices and competitor menus.",
    tools: [
      {
        name: "price_history",
        title: "Wholesale price history",
        description: "Twelve months of wholesale prices for one ingredient. $0.02 per query.",
        price: "0.02",
        inputSchema: { item: z.enum(["oat_milk", "coffee_beans", "cups"]).describe("Ingredient") },
        run: ({ item }) => {
          const base = { oat_milk: 3.1, coffee_beans: 11.4, cups: 0.09 }[String(item) as "oat_milk"] ?? 1;
          const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
          const drift = String(item) === "oat_milk" ? [0, 2, 4, 7, 9, 12, 14, 13, 11, 8, 4, 1] : [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6];
          return { item, unit: item === "cups" ? "per cup" : "per litre/kg", currency: "USD", series: months.map((m, i) => ({ month: m, price: +(base * (1 + drift[i]! / 100)).toFixed(2) })) };
        },
      },
      {
        name: "competitor_menu",
        title: "Competitor menu prices",
        description: "Cold drink prices at cafés within 500 m. $0.25 per query.",
        price: "0.25",
        inputSchema: { area: z.string().describe("Neighbourhood, e.g. 'Harbor Street'") },
        run: ({ area }) => ({
          area,
          cafes: [
            { name: "Tidepool Coffee", cold_brew: 4.25, oat_cold_brew: 4.95 },
            { name: "Pier 9 Espresso", cold_brew: 3.9, oat_cold_brew: null },
            { name: "The Lantern", cold_brew: 4.5, oat_cold_brew: 5.25 },
          ],
        }),
      },
    ],
  },
  {
    id: "field-panel",
    name: "Field Panel",
    description: "A panel of local residents who answer short questions; each answer is paid.",
    tools: [
      {
        name: "ask_panel",
        title: "Ask the local panel",
        description: "Ask five local panelists one short question. $0.40 per question (panelists are paid from it).",
        price: "0.40",
        inputSchema: { question: z.string().max(200).describe("One short question") },
        run: ({ question }) => ({
          question,
          answers: [
            "Yes, I'd buy an oat cold brew on the way to the ferry if it's under $5.",
            "I usually skip coffee shops at the terminal because the line is long.",
            "Only on hot days. $4.50 feels right.",
            "I already buy one at Tidepool; I'd switch for a loyalty discount.",
            "Not interested, I prefer hot drinks.",
          ],
        }),
      },
    ],
  },
  {
    id: "velvet-insights",
    name: "Velvet Insights",
    description: "Premium forecasts. Expensive, and not on any default allowlist.",
    tools: [
      {
        name: "premium_forecast",
        title: "Premium demand forecast",
        description: "Proprietary demand forecast. $25.00 per call.",
        price: "25.00",
        inputSchema: { topic: z.string() },
        run: ({ topic }) => ({ topic, forecast: "Demand will rise." }),
      },
    ],
  },
];
