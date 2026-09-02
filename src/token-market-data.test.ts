import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchTokenMarketData } from "./token-market-data.js";

const mint = "So11111111111111111111111111111111111111112";

test("market data follows the requested token when it is the quote asset", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/tokens/")) {
      return Response.json({ data: [{
        attributes: {
          address: "Pool111111111111111111111111111111111111111",
          name: "TOKEN / SOL",
          token_price_usd: "100.5",
          reserve_in_usd: "50000",
          volume_usd: { h24: "12000" },
          price_change_percentage: { h24: "2.5" },
          transactions: { m5: { buys: 8, sells: 3, buyers: 6, sellers: 2 } },
        },
        relationships: {
          base_token: { data: { id: "solana_Token1111111111111111111111111111111111111" } },
          quote_token: { data: { id: `solana_${mint}` } },
          dex: { data: { id: "pumpswap" } },
        },
      }] });
    }
    if (url.includes("/ohlcv/")) {
      return Response.json({ data: { attributes: { ohlcv_list: [
        [200, 2, 3, 1, 2.5, 20],
        [100, 1, 2, 0.5, 1.5, 10],
      ] } } });
    }
    return Response.json({ data: [{ attributes: {
      block_timestamp: "2026-09-02T12:00:00Z",
      tx_hash: "signature",
      tx_from_address: "wallet",
      kind: "sell",
      volume_in_usd: "25",
      from_token_amount: "250",
      to_token_amount: "0.25",
      price_from_in_usd: "0.1",
      price_to_in_usd: "100",
      from_token_address: "Token1111111111111111111111111111111111111",
      to_token_address: mint,
    } }] });
  };

  const result = await fetchTokenMarketData(
    mint,
    fetchImpl,
    () => new Date("2026-09-02T12:00:01Z"),
  );

  assert.ok(requestedUrls.some((url) => url.includes("token=quote")));
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), [100, 200]);
  assert.equal(result.trades[0]?.side, "buy");
  assert.equal(result.pool.priceUsd, 100.5);
  assert.equal(result.pool.activeTraders5m, 8);
  assert.equal(result.pool.buys5m, 8);
  assert.equal(result.pool.sells5m, 3);
});