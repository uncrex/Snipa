import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchTokenMarketCaps } from "./token-market-caps.js";

test("market caps use the deepest base-token pool without misattributing quote tokens", async () => {
  const firstMint = "So11111111111111111111111111111111111111112";
  const secondMint = "11111111111111111111111111111111";
  const fetchImpl: typeof fetch = async () => Response.json([
    {
      chainId: "solana",
      pairAddress: "shallow",
      baseToken: { address: firstMint },
      quoteToken: { address: secondMint },
      liquidity: { usd: 100 },
      marketCap: 1_000,
      priceUsd: "0.001",
    },
    {
      chainId: "solana",
      pairAddress: "deep",
      baseToken: { address: firstMint },
      quoteToken: { address: secondMint },
      liquidity: { usd: 5_000 },
      marketCap: 2_000,
      priceUsd: "0.002",
      boosts: { active: 7 },
    },
  ]);

  const result = await fetchTokenMarketCaps([firstMint, secondMint], fetchImpl);

  assert.deepEqual(result, [
    { mint: firstMint, marketCapUsd: 2_000, priceUsd: 0.002, liquidityUsd: 5_000, pairAddress: "deep", activeBoosts: 7 },
    { mint: secondMint, marketCapUsd: null, priceUsd: null, liquidityUsd: null, pairAddress: null, activeBoosts: null },
  ]);
});