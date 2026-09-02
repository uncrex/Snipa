import { z } from "zod";

const API_ROOT = "https://api.geckoterminal.com/api/v2";
const MAX_BATCH_SIZE = 30;

const tokensSchema = z.object({
  data: z.array(z.object({
    attributes: z.object({ address: z.string() }),
    relationships: z.object({
      top_pools: z.object({
        data: z.array(z.object({ id: z.string() })),
      }),
    }),
  })),
});

const poolsSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    attributes: z.object({
      transactions: z.object({
        m5: z.object({
          buys: z.number().int().nonnegative().nullable(),
          sells: z.number().int().nonnegative().nullable(),
          buyers: z.number().int().nonnegative().nullable(),
          sellers: z.number().int().nonnegative().nullable(),
        }),
      }),
      volume_usd: z.object({
        m5: z.string().nullable(),
        m15: z.string().nullable(),
      }),
    }),
  })),
});

export interface TokenActivity {
  mint: string;
  activeTraders5m: number | null;
  buyPressurePercent: number | null;
  volumeAcceleration: number | null;
}

export type ActivityFetch = typeof fetch;

async function fetchJson(url: string, fetchImpl: ActivityFetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Activity provider returned ${response.status}.`);
  return response.json() as Promise<unknown>;
}

export async function fetchTokenActivity(
  mints: readonly string[],
  fetchImpl: ActivityFetch = fetch,
): Promise<TokenActivity[]> {
  const uniqueMints = [...new Set(mints)];
  const results = new Map<string, Omit<TokenActivity, "mint">>();

  for (let offset = 0; offset < uniqueMints.length; offset += MAX_BATCH_SIZE) {
    const chunk = uniqueMints.slice(offset, offset + MAX_BATCH_SIZE);
    const encodedMints = chunk.map(encodeURIComponent).join(",");
    const tokens = tokensSchema.parse(await fetchJson(
      `${API_ROOT}/networks/solana/tokens/multi/${encodedMints}`,
      fetchImpl,
    )).data;
    const poolToMint = new Map<string, string>();
    for (const token of tokens) {
      const poolId = token.relationships.top_pools.data[0]?.id;
      if (poolId) poolToMint.set(poolId.replace(/^solana_/, ""), token.attributes.address);
    }
    if (poolToMint.size === 0) continue;

    const encodedPools = [...poolToMint.keys()].map(encodeURIComponent).join(",");
    const pools = poolsSchema.parse(await fetchJson(
      `${API_ROOT}/networks/solana/pools/multi/${encodedPools}`,
      fetchImpl,
    )).data;
    for (const pool of pools) {
      const mint = poolToMint.get(pool.id.replace(/^solana_/, ""));
      if (!mint) continue;
      const transactions = pool.attributes.transactions.m5;
      if (transactions.buys === null
        || transactions.sells === null
        || transactions.buyers === null
        || transactions.sellers === null) continue;
      const tradeCount = transactions.buys + transactions.sells;
      const volume5m = Number(pool.attributes.volume_usd.m5);
      const volume15m = Number(pool.attributes.volume_usd.m15);
      const prior10mVolume = volume15m - volume5m;
      results.set(mint, {
        activeTraders5m: transactions.buyers + transactions.sellers,
        buyPressurePercent: tradeCount === 0 ? null : transactions.buys / tradeCount * 100,
        volumeAcceleration: Number.isFinite(volume5m)
          && Number.isFinite(prior10mVolume)
          && prior10mVolume > 0
          ? volume5m * 2 / prior10mVolume
          : null,
      });
    }
  }

  return uniqueMints.map((mint) => ({
    mint,
    activeTraders5m: results.get(mint)?.activeTraders5m ?? null,
    buyPressurePercent: results.get(mint)?.buyPressurePercent ?? null,
    volumeAcceleration: results.get(mint)?.volumeAcceleration ?? null,
  }));
}
