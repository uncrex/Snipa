import { z } from "zod";

const API_ROOT = "https://api.dexscreener.com/tokens/v1/solana";
const MAX_TOKENS_PER_REQUEST = 30;

const pairSchema = z.object({
  chainId: z.literal("solana"),
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string() }),
  quoteToken: z.object({ address: z.string() }),
  liquidity: z.object({ usd: z.number().nullable() }).optional(),
  marketCap: z.number().nullable().optional(),
  priceUsd: z.string().nullable().optional(),
  boosts: z.object({ active: z.number().int().nonnegative() }).optional(),
});

const pairsSchema = z.array(pairSchema);

export interface TokenMarketCap {
  mint: string;
  marketCapUsd: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  pairAddress: string | null;
  activeBoosts?: number | null;
  curveProgressBps?: number | null;
}

export type MarketCapsFetch = typeof fetch;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function fetchTokenMarketCaps(
  mints: readonly string[],
  fetchImpl: MarketCapsFetch = fetch,
): Promise<TokenMarketCap[]> {
  const uniqueMints = [...new Set(mints)];
  const bestPairs = new Map<string, z.infer<typeof pairSchema>>();

  const responses = await Promise.all(chunks(uniqueMints, MAX_TOKENS_PER_REQUEST).map(async (batch) => {
    const response = await fetchImpl(`${API_ROOT}/${batch.map(encodeURIComponent).join(",")}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Market-cap provider returned ${response.status}.`);
    return pairsSchema.parse(await response.json() as unknown);
  }));
  for (const pair of responses.flat()) {
    const mint = pair.baseToken.address;
    if (!uniqueMints.includes(mint)) continue;
    const current = bestPairs.get(mint);
    if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) {
      bestPairs.set(mint, pair);
    }
  }

  return uniqueMints.map((mint) => {
    const pair = bestPairs.get(mint);
    const priceUsd = pair?.priceUsd === undefined || pair.priceUsd === null
      ? null
      : Number(pair.priceUsd);
    return {
      mint,
      marketCapUsd: pair?.marketCap ?? null,
      priceUsd: priceUsd !== null && Number.isFinite(priceUsd) ? priceUsd : null,
      liquidityUsd: pair?.liquidity?.usd ?? null,
      pairAddress: pair?.pairAddress ?? null,
      activeBoosts: pair?.boosts?.active ?? null,
    };
  });
}