// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, API, RSS).
import { CATEGORIES, CHANNEL_KEYS, DEFAULT_COLUMNS, DOMAINS } from "@aihot/industry/taxonomy";
export { CHANNEL_KEYS, CHANNEL_LABELS } from "@aihot/industry/taxonomy";

export type DomainKey = (typeof DOMAINS)[number]["key"];
export const DOMAIN_KEYS = DOMAINS.map((d) => d.key) as unknown as readonly [DomainKey, ...DomainKey[]];
export const DOMAIN_LABELS = Object.fromEntries(DOMAINS.map((d) => [d.key, d.label])) as Record<DomainKey, string>;

export function isDomainKey(value: unknown): value is DomainKey {
  return typeof value === "string" && (DOMAIN_KEYS as readonly string[]).includes(value);
}

/** Stable order and one occurrence of each already-validated domain. */
export function normalizeDomains(values: readonly DomainKey[]): DomainKey[] {
  return DOMAIN_KEYS.filter((key) => values.includes(key));
}

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Website tab labels. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

/** The public API, RSS and MCP use the same categories as the website. */
export const PUBLIC_API_CATEGORY_KEYS = CATEGORY_KEYS;
export type PublicApiCategoryKey = CategoryKey;

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  return isCategoryKey(category) ? category : null;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/** Presentation presets reuse the site's existing filter dimensions. */
export interface FeedColumn {
  readonly key: string;
  readonly label: string;
  readonly filters: Readonly<{ category?: CategoryKey; tag?: string; channel?: ChannelKey }>;
}

export function feedColumns(scope: DomainKey | null): readonly FeedColumn[] {
  return scope === null ? DEFAULT_COLUMNS : DOMAINS.find((domain) => domain.key === scope)!.columns;
}

export const LEADERBOARD_PUBLIC_BOARDS = ["overall", "coding", "reasoning", "knowledge", "professional"] as const;
export type LeaderboardBoardKey = (typeof LEADERBOARD_PUBLIC_BOARDS)[number];

export const LEADERBOARD_BOARD_LABELS: Record<LeaderboardBoardKey, string> = {
  overall: "综合",
  coding: "编程",
  reasoning: "推理",
  knowledge: "知识",
  professional: "专业办公",
};

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
