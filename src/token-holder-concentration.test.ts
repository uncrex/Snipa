import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchTokenHolderConcentration } from "./token-holder-concentration.js";

const mint = "So11111111111111111111111111111111111111112";

test("holder concentration uses the ten largest raw balances over total supply", async () => {
  let requestBody: unknown;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json([
      {
        jsonrpc: "2.0",
        id: "0:largest",
        result: { value: Array.from({ length: 12 }, (_, index) => ({ amount: index < 10 ? "50" : "250" })) },
      },
      { jsonrpc: "2.0", id: "0:supply", result: { value: { amount: "1000" } } },
    ]);
  };

  const result = await fetchTokenHolderConcentration("https://rpc.example", [mint], fetchImpl);

  assert.deepEqual(result, [{ mint, top10HolderPercent: 50 }]);
  assert.deepEqual((requestBody as Array<{ method: string }>).map((item) => item.method), [
    "getTokenLargestAccounts",
    "getTokenSupply",
  ]);
});
