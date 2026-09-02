import { z } from "zod";

const API_ROOT = "https://api.geckoterminal.com/api/v2";

const poolSchema = z.object({
  attributes: z.object({
    address: z.string().min(32),
    name: z.string(),
    token_price_usd: z.string().nullable(),
    reserve_in_usd: z.string().nullable(),
    volume_usd: z.object({ h24: z.string().nullable() }),
    price_change_percentage: z.object({ h24: z.string().nullable() }),
    transactions: z.object({
      m5: z.object({
        buys: z.number().int().nonnegative(),
        sells: z.number().int().nonnegative(),
        buyers: z.number().int().nonnegative(),
        sellers: z.number().int().nonnegative(),
      }),
    }),
  }),
  relationships: z.object({
    base_token: z.object({ data: z.object({ id: z.string() }) }),
    quote_token: z.object({ data: z.object({ id: z.string() }) }),
    dex: z.object({ data: z.object({ id: z.string() }) }),
  }),
});

const poolsSchema = z.object({ data: z.array(poolSchema) });
const ohlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.tuple([
        z.number(), z.number(), z.number(), z.number(), z.number(), z.number(),
      ])),
    }),
  }),
});
const tradesSchema = z.object({
  data: z.array(z.object({
    attributes: z.object({
      block_timestamp: z.string(),
      tx_hash: z.string(),
      tx_from_address: z.string(),
      kind: z.enum(["buy", "sell"]),
      volume_in_usd: z.string(),
      from_token_amount: z.string(),
      to_token_amount: z.string(),
      price_from_in_usd: z.string().nullable(),
      price_to_in_usd: z.string().nullable(),
      from_token_address: z.string(),
      to_token_address: z.string(),
    }),
  })),
});

export interface TokenMarketData {
  generatedAt: string;
  pool: {
    address: string;
    name: string;
    dex: string;
    priceUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    change24hPercent: number | null;
    activeTraders5m: number;
    buys5m: number;
    sells5m: number;
  };
  candles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeUsd: number;
  }>;
  trades: Array<{
    timestamp: string;
    signature: string;
    wallet: string;
    side: "buy" | "sell";
    volumeUsd: number;
    fromAmount: number;
    toAmount: number;
    fromPriceUsd: number | null;
    toPriceUsd: number | null;
  }>;
}

export type MarketDataFetch = typeof fetch;

function nullableNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url: string, fetchImpl: MarketDataFetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Market data provider returned ${response.status}.`);
  return response.json() as Promise<unknown>;
}

export async function fetchTokenMarketData(
  mint: string,
  fetchImpl: MarketDataFetch = fetch,
  now: () => Date = () => new Date(),
): Promise<TokenMarketData> {
  const pools = poolsSchema.parse(await fetchJson(
    `${API_ROOT}/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`,
    fetchImpl,
  )).data;
  const selected = [...pools]
    .sort((left, right) => (nullableNumber(right.attributes.reserve_in_usd) ?? 0)
      - (nullableNumber(left.attributes.reserve_in_usd) ?? 0))[0];
  if (!selected) throw new Error("No indexed liquidity pool is available for this token yet.");

  const poolAddress = selected.attributes.address;
  const requestedTokenId = `solana_${mint}`;
  const tokenSide = selected.relationships.quote_token.data.id === requestedTokenId
    ? "quote"
    : "base";
  const [ohlcv, trades] = await Promise.all([
    fetchJson(
      `${API_ROOT}/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute?aggregate=1&limit=120&currency=usd&token=${tokenSide}`,
      fetchImpl,
    ).then((value) => ohlcvSchema.parse(value)),
    fetchJson(
      `${API_ROOT}/networks/solana/pools/${encodeURIComponent(poolAddress)}/trades`,
      fetchImpl,
    ).then((value) => tradesSchema.parse(value)),
  ]);

  return {
    generatedAt: now().toISOString(),
    pool: {
      address: poolAddress,
      name: selected.attributes.name,
      dex: selected.relationships.dex.data.id,
      priceUsd: nullableNumber(selected.attributes.token_price_usd),
      liquidityUsd: nullableNumber(selected.attributes.reserve_in_usd),
      volume24hUsd: nullableNumber(selected.attributes.volume_usd.h24),
      change24hPercent: nullableNumber(selected.attributes.price_change_percentage.h24),
      activeTraders5m: selected.attributes.transactions.m5.buyers
        + selected.attributes.transactions.m5.sellers,
      buys5m: selected.attributes.transactions.m5.buys,
      sells5m: selected.attributes.transactions.m5.sells,
    },
    candles: ohlcv.data.attributes.ohlcv_list
      .map(([timestamp, open, high, low, close, volumeUsd]) => ({
        timestamp, open, high, low, close, volumeUsd,
      }))
      .sort((left, right) => left.timestamp - right.timestamp),
    trades: trades.data.map(({ attributes }) => ({
      timestamp: attributes.block_timestamp,
      signature: attributes.tx_hash,
      wallet: attributes.tx_from_address,
      side: attributes.to_token_address === mint ? "buy" : "sell",
      volumeUsd: Number(attributes.volume_in_usd),
      fromAmount: Number(attributes.from_token_amount),
      toAmount: Number(attributes.to_token_amount),
      fromPriceUsd: nullableNumber(attributes.price_from_in_usd),
      toPriceUsd: nullableNumber(attributes.price_to_in_usd),
    })),
  };
}