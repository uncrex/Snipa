import { z } from "zod";

const MAX_BATCH_SIZE = 30;
const amountSchema = z.string().regex(/^\d+$/);
const rpcResponsesSchema = z.array(z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}));
const largestAccountsSchema = z.object({
  value: z.array(z.object({ amount: amountSchema })),
});
const supplySchema = z.object({ value: z.object({ amount: amountSchema }) });

export interface TokenHolderConcentration {
  mint: string;
  top10HolderPercent: number | null;
}

export async function fetchTokenHolderConcentration(
  rpcUrl: string,
  mints: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<TokenHolderConcentration[]> {
  const uniqueMints = [...new Set(mints)];
  const results = new Map<string, number>();

  for (let offset = 0; offset < uniqueMints.length; offset += MAX_BATCH_SIZE) {
    const chunk = uniqueMints.slice(offset, offset + MAX_BATCH_SIZE);
    const requests = chunk.flatMap((mint, index) => [
      { jsonrpc: "2.0", id: `${index}:largest`, method: "getTokenLargestAccounts", params: [mint, { commitment: "confirmed" }] },
      { jsonrpc: "2.0", id: `${index}:supply`, method: "getTokenSupply", params: [mint, { commitment: "confirmed" }] },
    ]);
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requests),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Holder concentration RPC returned ${response.status}.`);
    const responses = rpcResponsesSchema.parse(await response.json() as unknown);
    const byId = new Map(responses.map((item) => [item.id, item]));

    chunk.forEach((mint, index) => {
      try {
        const largest = largestAccountsSchema.parse(byId.get(`${index}:largest`)?.result);
        const supply = BigInt(supplySchema.parse(byId.get(`${index}:supply`)?.result).value.amount);
        if (supply === 0n) return;
        const top10 = largest.value.slice(0, 10)
          .reduce((sum, account) => sum + BigInt(account.amount), 0n);
        const basisPoints = Number((top10 * 10_000n) / supply);
        results.set(mint, Math.min(100, basisPoints / 100));
      } catch {
        // Invalid, missing, or unsupported mints remain unavailable.
      }
    });
  }

  return uniqueMints.map((mint) => ({
    mint,
    top10HolderPercent: results.get(mint) ?? null,
  }));
}
