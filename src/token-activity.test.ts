import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchTokenActivity } from "./token-activity.js";

const firstMint = "So11111111111111111111111111111111111111112";
const secondMint = "11111111111111111111111111111111";

test("token activity maps top pools and leaves unindexed tokens unavailable", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/tokens/multi/")) {
      return Response.json({ data: [
        {
          attributes: { address: firstMint },
          relationships: { top_pools: { data: [{ id: "solana_Pool111" }] } },
        },
        {
          attributes: { address: secondMint },
          relationships: { top_pools: { data: [] } },
        },
      ] });
    }
    return Response.json({ data: [{
      id: "solana_Pool111",
      attributes: {
        transactions: { m5: { buys: 8, sells: 2, buyers: 6, sellers: 2 } },
        volume_usd: { m5: "300", m15: "500" },
      },
    }] });
  };

  const result = await fetchTokenActivity([firstMint, secondMint, firstMint], fetchImpl);

  assert.deepEqual(result, [
    {
      mint: firstMint,
      activeTraders5m: 8,
      buyPressurePercent: 80,
      volumeAcceleration: 3,
    },
    {
      mint: secondMint,
      activeTraders5m: null,
      buyPressurePercent: null,
      volumeAcceleration: null,
    },
  ]);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0] ?? "", /tokens\/multi/);
  assert.match(requestedUrls[1] ?? "", /pools\/multi/);
});
