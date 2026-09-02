import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  assertPumpswapCandidateSimulationAdmissible,
  assertPumpswapCandidateVaultSimulationAdmissible,
  assertPumpswapSimulationAgreement,
  assertReserveSnapshotAdvances,
  assertReserveSourcesConverged,
  assertReserveSnapshotsUsable,
  decodePumpswapReserveSnapshot,
  decodePumpswapReserveSnapshots,
  decodePumpswapSimulationVaultBalances,
  derivePumpswapSimulationObservation,
  quoteAdmissiblePumpswapCandidate,
  quotePumpswapExactInput,
  ReserveSnapshotStore,
  type ReserveSnapshot,
} from "./reserve-snapshots.js";

const baseMint = "So11111111111111111111111111111111111111112";
const quoteMint = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function simulatedTokenAccount(mint: string, amount: bigint, overrides: {
  owner?: string;
  executable?: boolean;
  state?: number;
  dataLength?: number;
} = {}): unknown {
  const data = Buffer.alloc(overrides.dataLength ?? 165);
  if (data.length === 165) {
    new PublicKey(mint).toBuffer().copy(data, 0);
    data.writeBigUInt64LE(amount, 64);
    data.writeUInt8(overrides.state ?? 1, 108);
  }
  return {
    owner: overrides.owner ?? tokenProgram,
    executable: overrides.executable ?? false,
    data: [data.toString("base64"), "base64"],
  };
}

function rpcTokenAccount(mint: string, amount: bigint, overrides: {
  owner?: PublicKey;
  executable?: boolean;
  state?: number;
  dataLength?: number;
} = {}): unknown {
  const simulated = simulatedTokenAccount(mint, amount, {
    executable: overrides.executable,
    state: overrides.state,
    dataLength: overrides.dataLength,
  }) as { executable: boolean; data: [string, string] };
  return {
    owner: overrides.owner ?? new PublicKey(tokenProgram),
    executable: simulated.executable,
    data: Buffer.from(simulated.data[0], "base64"),
  };
}

function snapshot(overrides: Partial<ReserveSnapshot> = {}): ReserveSnapshot {
  return {
    schemaVersion: 1,
    decoderVersion: "pump-reserves-v1",
    eventId: "reserve:100:1:pump",
    kind: "reserve-updated",
    venue: "pump",
    source: "rpc-primary",
    observedAt: "2026-08-31T12:00:00.000Z",
    slot: 100,
    writeVersion: 1,
    poolAddress: "11111111111111111111111111111111",
    baseMint,
    quoteMint,
    baseReserveRaw: "1000000",
    quoteReserveRaw: "2000000",
    ...overrides,
  };
}

const requirements = {
  now: "2026-08-31T12:00:00.500Z",
  maxAgeMs: 1_000,
  maxSlotSkew: 2,
};

test("reserve fixtures validate deterministically across synchronized venues", () => {
  const fixtures = [
    snapshot(),
    snapshot({
      decoderVersion: "pumpswap-reserves-v1",
      eventId: "reserve:102:1:pumpswap",
      venue: "pumpswap",
      source: "rpc-secondary",
      slot: 102,
      poolAddress: "ComputeBudget111111111111111111111111111111",
    }),
  ];

  assert.deepEqual(assertReserveSnapshotsUsable(fixtures, requirements), fixtures);
  assert.deepEqual(assertReserveSnapshotsUsable(fixtures, requirements), fixtures);
});

test("PumpSwap simulation vault returns decode by requested policy address", () => {
  const trade = {
    poolAddress: "11111111111111111111111111111111",
    baseMint,
    quoteMint,
    poolBaseTokenAccount: "base-vault",
    poolQuoteTokenAccount: "quote-vault",
  };
  assert.deepEqual(decodePumpswapSimulationVaultBalances(
    trade,
    ["quote-vault", "base-vault"],
    [simulatedTokenAccount(quoteMint, 2_000_000n), simulatedTokenAccount(baseMint, 1_000_000n)],
  ), {
    poolAddress: trade.poolAddress,
    baseMint,
    quoteMint,
    postBaseReserveRaw: "1000000",
    postQuoteReserveRaw: "2000000",
  });
});

test("PumpSwap simulation vault decoding rejects untrusted account state", () => {
  const trade = {
    poolAddress: "11111111111111111111111111111111",
    baseMint,
    quoteMint,
    poolBaseTokenAccount: "base-vault",
    poolQuoteTokenAccount: "quote-vault",
  };
  const addresses = ["base-vault", "quote-vault"];
  const validQuote = simulatedTokenAccount(quoteMint, 2_000_000n);
  assert.throws(
    () => decodePumpswapSimulationVaultBalances(trade, addresses, [validQuote]),
    /requested address count/,
  );
  assert.throws(
    () => decodePumpswapSimulationVaultBalances(trade, addresses, [null, validQuote]),
    /omitted a policy-verified vault/,
  );
  assert.throws(
    () => decodePumpswapSimulationVaultBalances(trade, addresses, [
      simulatedTokenAccount(baseMint, 1n, { owner: PublicKey.default.toBase58() }),
      validQuote,
    ]),
    /malformed or not classic SPL Token data/,
  );
  assert.throws(
    () => decodePumpswapSimulationVaultBalances(trade, addresses, [
      simulatedTokenAccount(quoteMint, 1n),
      validQuote,
    ]),
    /mint does not match policy/,
  );
  assert.throws(
    () => decodePumpswapSimulationVaultBalances(trade, addresses, [
      simulatedTokenAccount(baseMint, 1n, { state: 2 }),
      validQuote,
    ]),
    /not initialized/,
  );
  assert.throws(
    () => decodePumpswapSimulationVaultBalances(trade, addresses, [
      simulatedTokenAccount(baseMint, 1n, { dataLength: 164 }),
      validQuote,
    ]),
    /invalid base64 or layout length/,
  );
});

test("PumpSwap simulation observations derive positive deltas in either direction", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  assert.deepEqual(derivePumpswapSimulationObservation(pumpswap, {
    poolAddress: pumpswap.poolAddress,
    baseMint,
    quoteMint,
    postBaseReserveRaw: "1100000",
    postQuoteReserveRaw: "1818182",
  }, "base", 102), {
    poolAddress: pumpswap.poolAddress,
    baseMint,
    quoteMint,
    inputSide: "base",
    slot: 102,
    effectiveInputAmountRaw: "100000",
    outputAmountRaw: "181818",
    postBaseReserveRaw: "1100000",
    postQuoteReserveRaw: "1818182",
  });
  assert.deepEqual(derivePumpswapSimulationObservation(pumpswap, {
    poolAddress: pumpswap.poolAddress,
    baseMint,
    quoteMint,
    postBaseReserveRaw: "909919",
    postQuoteReserveRaw: "2198000",
  }, "quote", 101), {
    poolAddress: pumpswap.poolAddress,
    baseMint,
    quoteMint,
    inputSide: "quote",
    slot: 101,
    effectiveInputAmountRaw: "198000",
    outputAmountRaw: "90081",
    postBaseReserveRaw: "909919",
    postQuoteReserveRaw: "2198000",
  });
});

test("PumpSwap simulation observation derivation rejects wrong identity and delta direction", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  const balances = {
    poolAddress: pumpswap.poolAddress,
    baseMint,
    quoteMint,
    postBaseReserveRaw: "1100000",
    postQuoteReserveRaw: "1818182",
  };
  assert.throws(
    () => derivePumpswapSimulationObservation(snapshot(), balances, "base", 102),
    /cannot use pump reserve semantics/,
  );
  assert.throws(
    () => derivePumpswapSimulationObservation(pumpswap, {
      ...balances,
      poolAddress: "ComputeBudget111111111111111111111111111111",
    }, "base", 102),
    /do not match the reserve snapshot identity/,
  );
  assert.throws(
    () => derivePumpswapSimulationObservation(pumpswap, {
      ...balances,
      postBaseReserveRaw: "900000",
    }, "base", 102),
    /do not describe a positive exact-input swap/,
  );
  assert.throws(
    () => derivePumpswapSimulationObservation(pumpswap, balances, "quote", 102),
    /do not describe a positive exact-input swap/,
  );
  assert.throws(
    () => derivePumpswapSimulationObservation(pumpswap, balances, "base", -1),
    /slot must be a non-negative safe integer/,
  );
});

test("PumpSwap exact-input quotes use integer constant-product math in either direction", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  assert.deepEqual(quotePumpswapExactInput(pumpswap, "base", 100_000n, 0, 910), {
    modelVersion: "pumpswap-constant-product-v1",
    reserveEventId: pumpswap.eventId,
    decoderVersion: pumpswap.decoderVersion,
    poolAddress: pumpswap.poolAddress,
    source: pumpswap.source,
    observedAt: pumpswap.observedAt,
    slot: pumpswap.slot,
    writeVersion: pumpswap.writeVersion,
    baseMint: pumpswap.baseMint,
    quoteMint: pumpswap.quoteMint,
    inputSide: "base",
    inputAmountRaw: "100000",
    feeBps: 0,
    maxPriceImpactBps: 910,
    feeAmountRaw: "0",
    effectiveInputAmountRaw: "100000",
    outputAmountRaw: "181818",
    priceImpactBps: 910,
    postBaseReserveRaw: "1100000",
    postQuoteReserveRaw: "1818182",
    invariantBeforeRaw: "2000000000000",
    invariantAfterRaw: "2000000200000",
  });
  assert.deepEqual(quotePumpswapExactInput(pumpswap, "quote", 200_000n, 100, 901), {
    modelVersion: "pumpswap-constant-product-v1",
    reserveEventId: pumpswap.eventId,
    decoderVersion: pumpswap.decoderVersion,
    poolAddress: pumpswap.poolAddress,
    source: pumpswap.source,
    observedAt: pumpswap.observedAt,
    slot: pumpswap.slot,
    writeVersion: pumpswap.writeVersion,
    baseMint: pumpswap.baseMint,
    quoteMint: pumpswap.quoteMint,
    inputSide: "quote",
    inputAmountRaw: "200000",
    feeBps: 100,
    maxPriceImpactBps: 901,
    feeAmountRaw: "2000",
    effectiveInputAmountRaw: "198000",
    outputAmountRaw: "90081",
    priceImpactBps: 901,
    postBaseReserveRaw: "909919",
    postQuoteReserveRaw: "2198000",
    invariantBeforeRaw: "2000000000000",
    invariantAfterRaw: "2000001962000",
  });
});

test("PumpSwap quotes fail closed on mismatched semantics and unusable inputs", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  assert.throws(() => quotePumpswapExactInput(snapshot(), "base", 1n, 0, 10_000), /cannot use pump/);
  assert.throws(() => quotePumpswapExactInput(pumpswap, "base", 0n, 0, 10_000), /input must be positive/);
  assert.throws(() => quotePumpswapExactInput(pumpswap, "base", 1n, 1, 10_000), /rounds to zero after fees/);
  assert.throws(() => quotePumpswapExactInput(pumpswap, "base", 1n, 10_000, 10_000), /between 0 and 9999/);
  assert.throws(() => quotePumpswapExactInput(pumpswap, "base", 1n, 0, 10_001), /between 0 and 10000/);
  assert.throws(
    () => quotePumpswapExactInput({ ...pumpswap, baseReserveRaw: "0" }, "base", 1n, 0, 10_000),
    /nonzero reserves/,
  );
});

test("PumpSwap quote price-impact ceilings are inclusive", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  assert.equal(
    quotePumpswapExactInput(pumpswap, "base", 100_000n, 0, 910).priceImpactBps,
    910,
  );
  assert.throws(
    () => quotePumpswapExactInput(pumpswap, "base", 100_000n, 0, 909),
    /price impact 910 bps exceeds maximum 909 bps/,
  );
});

test("PumpSwap candidate quotes atomically enforce identity, freshness, and impact", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  const candidate = {
    poolAddress: pumpswap.poolAddress,
    baseMint: pumpswap.baseMint,
    quoteMint: pumpswap.quoteMint,
    quoteSource: pumpswap.source,
    inputSide: "base" as const,
    inputAmountRaw: 100_000n,
    feeBps: 0,
    maxPriceImpactBps: 910,
    snapshots: requirements,
  };

  assert.deepEqual(
    quoteAdmissiblePumpswapCandidate([pumpswap], candidate),
    quotePumpswapExactInput(pumpswap, "base", 100_000n, 0, 910),
  );
  assert.throws(
    () => quoteAdmissiblePumpswapCandidate([pumpswap], {
      ...candidate,
      poolAddress: "ComputeBudget111111111111111111111111111111",
    }),
    /pool or ordered mint pair does not match/,
  );
  assert.throws(
    () => quoteAdmissiblePumpswapCandidate([pumpswap], {
      ...candidate,
      snapshots: { ...requirements, now: "2026-08-31T12:00:02.000Z" },
    }),
    /stale/,
  );
  assert.throws(
    () => quoteAdmissiblePumpswapCandidate([pumpswap], {
      ...candidate,
      maxPriceImpactBps: 909,
    }),
    /price impact 910 bps exceeds maximum 909 bps/,
  );
});

test("PumpSwap candidate quotes require converged providers and an explicit source", () => {
  const primary = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  const secondary = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    eventId: "reserve:101:1:pumpswap:secondary",
    venue: "pumpswap",
    source: "rpc-secondary",
    slot: 101,
    baseReserveRaw: "1000100",
    quoteReserveRaw: "1999900",
  });
  const candidate = {
    poolAddress: primary.poolAddress,
    baseMint: primary.baseMint,
    quoteMint: primary.quoteMint,
    quoteSource: primary.source,
    inputSide: "base" as const,
    inputAmountRaw: 100_000n,
    feeBps: 0,
    maxPriceImpactBps: 910,
    snapshots: requirements,
  };

  assert.equal(
    quoteAdmissiblePumpswapCandidate([secondary, primary], {
      ...candidate,
      maxReserveDivergenceBps: 1,
    }).source,
    "rpc-primary",
  );
  assert.throws(
    () => quoteAdmissiblePumpswapCandidate([primary, secondary], candidate),
    /requires a reserve divergence limit for multiple sources/,
  );
  assert.throws(
    () => quoteAdmissiblePumpswapCandidate([primary, secondary], {
      ...candidate,
      quoteSource: "rpc-tertiary",
      maxReserveDivergenceBps: 1,
    }),
    /quote source rpc-tertiary is unavailable/,
  );
  assert.throws(
    () => quoteAdmissiblePumpswapCandidate([primary, {
      ...secondary,
      baseReserveRaw: "1100000",
    }], {
      ...candidate,
      maxReserveDivergenceBps: 1,
    }),
    /diverges by/,
  );
});

test("PumpSwap pre-execution admission requires both reserve and simulation agreement", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  const requirementsWithSimulation = {
    poolAddress: pumpswap.poolAddress,
    baseMint: pumpswap.baseMint,
    quoteMint: pumpswap.quoteMint,
    quoteSource: pumpswap.source,
    inputSide: "base" as const,
    inputAmountRaw: 100_000n,
    feeBps: 0,
    maxPriceImpactBps: 910,
    snapshots: requirements,
    simulationMaxSlotSkew: 2,
    simulationMaxDivergenceBps: 1,
  };
  const quote = quotePumpswapExactInput(pumpswap, "base", 100_000n, 0, 910);
  const observation = {
    poolAddress: quote.poolAddress,
    baseMint: quote.baseMint,
    quoteMint: quote.quoteMint,
    inputSide: quote.inputSide,
    slot: 102,
    effectiveInputAmountRaw: quote.effectiveInputAmountRaw,
    outputAmountRaw: "181800",
    postBaseReserveRaw: quote.postBaseReserveRaw,
    postQuoteReserveRaw: quote.postQuoteReserveRaw,
  };

  assert.deepEqual(
    assertPumpswapCandidateSimulationAdmissible(
      [pumpswap],
      observation,
      requirementsWithSimulation,
    ),
    {
      quote,
      simulation: assertPumpswapSimulationAgreement(quote, observation, 2, 1),
    },
  );
  assert.throws(
    () => assertPumpswapCandidateSimulationAdmissible(
      [pumpswap],
      { ...observation, poolAddress: "ComputeBudget111111111111111111111111111111" },
      requirementsWithSimulation,
    ),
    /pool, ordered mint pair, or input side does not match/,
  );
  assert.throws(
    () => assertPumpswapCandidateSimulationAdmissible(
      [pumpswap],
      { ...observation, outputAmountRaw: "180000" },
      requirementsWithSimulation,
    ),
    /outputAmount divergence 100 bps exceeds 1 bps/,
  );
  assert.throws(
    () => assertPumpswapCandidateSimulationAdmissible(
      [pumpswap],
      null,
      {
        ...requirementsWithSimulation,
        snapshots: { ...requirements, now: "2026-08-31T12:00:02.000Z" },
      },
    ),
    /stale/,
  );
});

test("PumpSwap vault simulation admission binds deltas to the selected quote snapshot", () => {
  const primary = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  const secondary = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    eventId: "reserve:101:1:pumpswap:secondary",
    venue: "pumpswap",
    source: "rpc-secondary",
    slot: 101,
  });
  const candidate = {
    poolAddress: primary.poolAddress,
    baseMint: primary.baseMint,
    quoteMint: primary.quoteMint,
    quoteSource: primary.source,
    inputSide: "base" as const,
    inputAmountRaw: 100_000n,
    feeBps: 0,
    maxPriceImpactBps: 910,
    snapshots: requirements,
    maxReserveDivergenceBps: 0,
    simulationMaxSlotSkew: 2,
    simulationMaxDivergenceBps: 0,
  };
  const quote = quotePumpswapExactInput(primary, "base", 100_000n, 0, 910);
  const observation = derivePumpswapSimulationObservation(primary, {
    poolAddress: primary.poolAddress,
    baseMint,
    quoteMint,
    postBaseReserveRaw: quote.postBaseReserveRaw,
    postQuoteReserveRaw: quote.postQuoteReserveRaw,
  }, "base", 102);
  assert.deepEqual(assertPumpswapCandidateVaultSimulationAdmissible(
    [secondary, primary],
    {
      poolAddress: primary.poolAddress,
      baseMint,
      quoteMint,
      postBaseReserveRaw: quote.postBaseReserveRaw,
      postQuoteReserveRaw: quote.postQuoteReserveRaw,
    },
    102,
    candidate,
  ), {
    quote,
    observation,
    simulation: assertPumpswapSimulationAgreement(quote, observation, 2, 0),
  });
  assert.throws(
    () => assertPumpswapCandidateVaultSimulationAdmissible(
      [{ ...primary }, { ...primary, source: "rpc-secondary" }],
      {
        poolAddress: primary.poolAddress,
        baseMint,
        quoteMint,
        postBaseReserveRaw: quote.postBaseReserveRaw,
        postQuoteReserveRaw: quote.postQuoteReserveRaw,
      },
      102,
      candidate,
    ),
    /exactly one reserve snapshot event/,
  );
});

test("PumpSwap simulation agreement checks modeled deltas, reserves, and slots", () => {
  const pumpswap = snapshot({
    decoderVersion: "pumpswap-reserves-v1",
    venue: "pumpswap",
  });
  const quote = quotePumpswapExactInput(pumpswap, "base", 100_000n, 0, 910);
  const observation = {
    poolAddress: quote.poolAddress,
    baseMint: quote.baseMint,
    quoteMint: quote.quoteMint,
    inputSide: quote.inputSide,
    slot: 102,
    effectiveInputAmountRaw: quote.effectiveInputAmountRaw,
    outputAmountRaw: "181800",
    postBaseReserveRaw: quote.postBaseReserveRaw,
    postQuoteReserveRaw: quote.postQuoteReserveRaw,
  };
  assert.deepEqual(assertPumpswapSimulationAgreement(quote, observation, 2, 1), {
    quoteSlot: 100,
    simulationSlot: 102,
    slotSkew: 2,
    maxDivergenceBps: 1,
    divergenceBps: {
      effectiveInputAmount: 0,
      outputAmount: 1,
      postBaseReserve: 0,
      postQuoteReserve: 0,
    },
  });
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, observation, 2, 0),
    /outputAmount divergence 1 bps exceeds 0 bps/,
  );
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, {
      ...observation,
      poolAddress: "ComputeBudget111111111111111111111111111111",
    }, 2, 1),
    /pool, ordered mint pair, or input side does not match/,
  );
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, {
      ...observation,
      baseMint: quote.quoteMint,
      quoteMint: quote.baseMint,
    }, 2, 1),
    /pool, ordered mint pair, or input side does not match/,
  );
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, {
      ...observation,
      inputSide: "quote",
    }, 2, 1),
    /pool, ordered mint pair, or input side does not match/,
  );
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, { ...observation, slot: 99 }, 2, 1),
    /slot 99 regressed below quote slot 100/,
  );
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, { ...observation, slot: 103 }, 2, 1),
    /slot skew 3 exceeds 2/,
  );
  assert.throws(
    () => assertPumpswapSimulationAgreement(quote, observation, -1, 1),
    /slot skew must be a non-negative safe integer/,
  );
});

test("reserve snapshots reject unsupported or cross-venue decoder versions", () => {
  assert.throws(
    () => assertReserveSnapshotsUsable([
      snapshot({ decoderVersion: "unknown-reserves-v1" }),
    ], requirements),
    /Unsupported reserve decoder unknown-reserves-v1 for venue pump/,
  );
  assert.throws(
    () => assertReserveSnapshotsUsable([
      snapshot({ decoderVersion: "pumpswap-reserves-v1" }),
    ], requirements),
    /Unsupported reserve decoder pumpswap-reserves-v1 for venue pump/,
  );
  assert.throws(
    () => assertReserveSnapshotsUsable([
      snapshot({
        venue: "raydium-cpmm",
        decoderVersion: "raydium-cpmm-reserves-v1",
      }),
    ], requirements),
    /No trusted reserve decoder is implemented for venue raydium-cpmm/,
  );
});

test("reserve validation rejects stale, future, and slot-divergent snapshots", () => {
  assert.throws(
    () => assertReserveSnapshotsUsable(
      [snapshot({ observedAt: "2026-08-31T11:59:58.000Z" })],
      requirements,
    ),
    /stale/,
  );
  assert.throws(
    () => assertReserveSnapshotsUsable(
      [snapshot({ observedAt: "2026-08-31T12:00:01.000Z" })],
      requirements,
    ),
    /future/,
  );
  assert.throws(
    () => assertReserveSnapshotsUsable(
      [snapshot(), snapshot({
        venue: "pumpswap",
        decoderVersion: "pumpswap-reserves-v1",
        poolAddress: quoteMint,
        slot: 103,
      })],
      requirements,
    ),
    /slot skew 3 exceeds 2/,
  );
});

test("reserve validation rejects internally inconsistent liquidity", () => {
  assert.throws(
    () => assertReserveSnapshotsUsable([snapshot({ baseReserveRaw: "0" })], requirements),
    /zero liquidity/,
  );
  assert.throws(
    () => assertReserveSnapshotsUsable(
      [snapshot(), snapshot({
        venue: "pumpswap",
        decoderVersion: "pumpswap-reserves-v1",
        poolAddress: quoteMint,
        quoteMint: baseMint,
      })],
      requirements,
    ),
    /same mint on both sides|same ordered mint pair/,
  );
  assert.throws(
    () => assertReserveSnapshotsUsable([snapshot(), snapshot()], requirements),
    /Duplicate reserve snapshot/,
  );
});

test("reserve updates require monotonic slot and write version", () => {
  const previous = snapshot();
  const next = snapshot({
    eventId: "reserve:100:2:pump",
    observedAt: "2026-08-31T12:00:00.100Z",
    writeVersion: 2,
  });
  assert.deepEqual(assertReserveSnapshotAdvances(previous, next), next);
  assert.throws(
    () => assertReserveSnapshotAdvances(previous, snapshot({ slot: 99 })),
    /slot regressed/,
  );
  assert.throws(
    () => assertReserveSnapshotAdvances(previous, snapshot({ writeVersion: 1 })),
    /write version did not advance/,
  );
  assert.throws(
    () => assertReserveSnapshotAdvances(
      previous,
      snapshot({ observedAt: "2026-08-31T11:59:59.999Z", writeVersion: 2 }),
    ),
    /observation time regressed/,
  );
  assert.throws(
    () => assertReserveSnapshotAdvances(previous, snapshot({
      decoderVersion: "pumpswap-reserves-v1",
      venue: "pumpswap",
      writeVersion: 2,
    })),
    /identity does not match/,
  );
});

test("reserve store exposes only fresh source-selected snapshots", () => {
  const store = new ReserveSnapshotStore();
  store.ingest(snapshot());
  store.ingest(snapshot({
    eventId: "reserve:100:1:pump:secondary",
    source: "rpc-secondary",
  }));

  assert.throws(
    () => store.getUsablePair(baseMint, quoteMint, requirements),
    /Duplicate reserve snapshot/,
  );
  assert.equal(
    store.getUsablePair(baseMint, quoteMint, requirements, "rpc-primary")[0]?.source,
    "rpc-primary",
  );
  assert.throws(
    () => store.getUsablePair(baseMint, quoteMint, { ...requirements, now: "2026-08-31T12:00:02.000Z" }),
    /stale/,
  );
});

test("reserve store rejects regressions and evicts least-recently-updated state", () => {
  const store = new ReserveSnapshotStore(2);
  const firstPool = "11111111111111111111111111111111";
  const secondPool = "ComputeBudget111111111111111111111111111111";
  const thirdPool = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  store.ingest(snapshot({ poolAddress: firstPool }));
  assert.throws(() => store.ingest(snapshot({ slot: 99 })), /slot regressed/);
  store.ingest(snapshot({ eventId: "reserve:100:1:second", poolAddress: secondPool }));
  store.ingest(snapshot({ eventId: "reserve:100:1:third", poolAddress: thirdPool }));

  assert.equal(store.size, 2);
  assert.deepEqual(
    store.getUsablePair(baseMint, quoteMint, requirements).map((item) => item.poolAddress).sort(),
    [secondPool, thirdPool].sort(),
  );
});

test("reserve store rejects unknown decoders without mutating state", () => {
  const store = new ReserveSnapshotStore();
  assert.throws(
    () => store.ingest(snapshot({ decoderVersion: "pump-reserves-v2" })),
    /Unsupported reserve decoder pump-reserves-v2 for venue pump/,
  );
  assert.equal(store.size, 0);
});

test("reserve source convergence enforces identity, slot, and reserve agreement", () => {
  const primary = snapshot();
  const secondary = snapshot({
    eventId: "reserve:102:1:pump:secondary",
    source: "rpc-secondary",
    slot: 102,
    baseReserveRaw: "1005000",
    quoteReserveRaw: "1990000",
  });
  assert.deepEqual(
    assertReserveSourcesConverged([secondary, primary], requirements, 51).map((item) => item.source),
    ["rpc-primary", "rpc-secondary"],
  );
  assert.throws(
    () => assertReserveSourcesConverged([primary, secondary], requirements, 50),
    /diverges by 50 base bps and 51 quote bps/,
  );
  assert.throws(
    () => assertReserveSourcesConverged(
      [primary, { ...secondary, slot: 103 }],
      requirements,
      100,
    ),
    /source slot skew 3 exceeds 2/,
  );
});

test("reserve store exposes converged multi-provider pool state", () => {
  const store = new ReserveSnapshotStore();
  store.ingest(snapshot());
  store.ingest(snapshot({
    eventId: "reserve:101:1:pump:secondary",
    source: "rpc-secondary",
    slot: 101,
  }));
  assert.equal(
    store.getConvergedPool("pump", "11111111111111111111111111111111", requirements, 0).length,
    2,
  );
});

test("PumpSwap same-slot vault reads decode into a pinned reserve snapshot", () => {
  const trade = {
    poolAddress: "11111111111111111111111111111111",
    baseMint,
    quoteMint,
    poolBaseTokenAccount: "base-vault",
    poolQuoteTokenAccount: "quote-vault",
  };
  assert.deepEqual(decodePumpswapReserveSnapshot(
    trade,
    ["quote-vault", "base-vault"],
    [rpcTokenAccount(quoteMint, 2_000_000n), rpcTokenAccount(baseMint, 1_000_000n)],
    123,
    "rpc-primary",
    "2026-08-31T12:00:00.000Z",
  ), {
    schemaVersion: 1,
    decoderVersion: "pumpswap-reserves-v1",
    eventId: "rpc-point-read:rpc-primary:123:11111111111111111111111111111111",
    kind: "reserve-updated",
    venue: "pumpswap",
    source: "rpc-primary",
    observedAt: "2026-08-31T12:00:00.000Z",
    slot: 123,
    writeVersion: 0,
    poolAddress: trade.poolAddress,
    baseMint,
    quoteMint,
    baseReserveRaw: "1000000",
    quoteReserveRaw: "2000000",
  });
});

test("PumpSwap same-slot reserve decoding rejects malformed or mismatched vaults", () => {
  const trade = {
    poolAddress: "11111111111111111111111111111111",
    baseMint,
    quoteMint,
    poolBaseTokenAccount: "base-vault",
    poolQuoteTokenAccount: "quote-vault",
  };
  const addresses = ["base-vault", "quote-vault"];
  const validQuote = rpcTokenAccount(quoteMint, 2_000_000n);
  const decode = (accounts: unknown) => decodePumpswapReserveSnapshot(
    trade,
    addresses,
    accounts,
    123,
    "rpc-primary",
    "2026-08-31T12:00:00.000Z",
  );
  assert.throws(() => decode([validQuote]), /requested address count/);
  assert.throws(() => decode([null, validQuote]), /omitted a policy-verified vault/);
  assert.throws(
    () => decode([rpcTokenAccount(baseMint, 1n, { owner: PublicKey.default }), validQuote]),
    /malformed or not classic SPL Token data/,
  );
  assert.throws(
    () => decode([rpcTokenAccount(quoteMint, 1n), validQuote]),
    /mint does not match policy/,
  );
  assert.throws(
    () => decode([rpcTokenAccount(baseMint, 1n, { state: 2 }), validQuote]),
    /not initialized/,
  );
  assert.throws(
    () => decode([rpcTokenAccount(baseMint, 1n, { dataLength: 164 }), validQuote]),
    /unsupported layout length/,
  );
  assert.throws(
    () => decode([rpcTokenAccount(baseMint, 0n), validQuote]),
    /zero liquidity/,
  );
});

test("PumpSwap reserve point reads deduplicate exact pools and reject conflicting vault state", () => {
  const primaryTrade = {
    poolAddress: "11111111111111111111111111111111",
    baseMint,
    quoteMint,
    poolBaseTokenAccount: "base-vault",
    poolQuoteTokenAccount: "quote-vault",
  };
  const conflictingTrade = {
    ...primaryTrade,
    poolBaseTokenAccount: "other-base-vault",
    poolQuoteTokenAccount: "other-quote-vault",
  };
  const addresses = ["base-vault", "quote-vault", "other-base-vault", "other-quote-vault"];
  const accounts = [
    rpcTokenAccount(baseMint, 1_000_000n),
    rpcTokenAccount(quoteMint, 2_000_000n),
    rpcTokenAccount(baseMint, 1_000_001n),
    rpcTokenAccount(quoteMint, 2_000_000n),
  ];
  assert.equal(decodePumpswapReserveSnapshots(
    [primaryTrade, primaryTrade],
    addresses,
    accounts,
    123,
    "rpc-primary",
    "2026-08-31T12:00:00.000Z",
  ).length, 1);
  assert.throws(
    () => decodePumpswapReserveSnapshots(
      [primaryTrade, conflictingTrade],
      addresses,
      accounts,
      123,
      "rpc-primary",
      "2026-08-31T12:00:00.000Z",
    ),
    /conflicting reserve identities for one pool/,
  );
});