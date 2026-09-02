import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeTradeJournalState,
  readTradeHistory,
  summarizeTradeHistory,
} from "./history.js";

test("summarizeTradeHistory reports activity and skips invalid lines", () => {
  const contents = [
    JSON.stringify({
      timestamp: "2026-08-30T12:00:00.000Z",
      action: "buy",
      mint: "MintA",
      amount: 0.1,
      denominatedInSol: true,
      mode: "PAPER",
      wallet: "WalletA",
      signature: null,
    }),
    "not-json",
    JSON.stringify({
      timestamp: "2026-08-30T12:01:00.000Z",
      action: "sell",
      mint: "MintA",
      amount: "100%",
      denominatedInSol: false,
      mode: "LIVE",
      wallet: "WalletA",
      signature: "SignatureA",
    }),
  ].join("\n");

  assert.deepEqual(summarizeTradeHistory(contents), {
    records: 2,
    buys: 1,
    sells: 1,
    buySpendSol: 0.1,
    live: 1,
    paper: 1,
    invalidLines: 1,
    missing: false,
    submissionToConfirmation: {
      sampleCount: 0,
      invalidSamples: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      alertThresholdMs: null,
      aboveThresholdSamples: 0,
      p95WithinThreshold: null,
    },
  });
});

test("readTradeHistory treats a missing journal as empty", async () => {
  const summary = await readTradeHistory("./does-not-exist-history-test.jsonl");
  assert.equal(summary.missing, true);
  assert.equal(summary.records, 0);
});

test("summarizeTradeHistory counts only the terminal record for a v2 decision", () => {
  const base = {
    schemaVersion: 2,
    decisionId: "68adf508-1e9b-4c63-b4a7-2910d2155d0a",
    timestamp: "2026-08-30T12:00:00.000Z",
    candidateAt: "2026-08-30T12:00:00.000Z",
    action: "buy",
    mint: "MintA",
    amount: 0.1,
    denominatedInSol: true,
    mode: "LIVE",
    wallet: "WalletA",
    signature: null,
  };
  const contents = [
    JSON.stringify({ ...base, status: "candidate" }),
    JSON.stringify({ ...base, status: "policy-approved" }),
    JSON.stringify({
      ...base,
      timestamp: "2026-08-30T12:00:01.000Z",
      status: "rejected",
      rejectionReason: "simulation failed",
    }),
  ].join("\n");

  const summary = summarizeTradeHistory(contents);
  assert.equal(summary.records, 1);
  assert.equal(summary.buys, 1);
  assert.equal(summary.buySpendSol, 0.1);
});

test("trade history summarizes confirmed live observation latency without claiming landing", () => {
  const base = {
    schemaVersion: 2,
    timestamp: "2026-08-30T12:00:01.000Z",
    action: "buy",
    mint: "MintA",
    amount: 0.1,
    denominatedInSol: true,
    mode: "LIVE",
    wallet: "WalletA",
    signature: "SignatureA",
    status: "confirmed",
  };
  const contents = [
    ["68adf508-1e9b-4c63-b4a7-2910d2155d0a", "12:00:00.000", "12:00:00.100"],
    ["ee3f998b-f52c-4535-b66d-29c76f6c99a4", "12:00:00.000", "12:00:00.200"],
    ["fa219392-c710-44b2-9b08-78eda529c407", "12:00:00.000", "12:00:01.000"],
    ["854d0d55-8b89-45b9-9949-c02029389455", "12:00:01.000", "12:00:00.999"],
  ].map(([decisionId, submittedTime, finalizedTime]) => JSON.stringify({
    ...base,
    decisionId,
    submittedAt: `2026-08-30T${submittedTime}Z`,
    finalizedAt: `2026-08-30T${finalizedTime}Z`,
  })).join("\n");

  assert.deepEqual(summarizeTradeHistory(contents, 500).submissionToConfirmation, {
    sampleCount: 3,
    invalidSamples: 1,
    p50Ms: 200,
    p95Ms: 1_000,
    maxMs: 1_000,
    alertThresholdMs: 500,
    aboveThresholdSamples: 1,
    p95WithinThreshold: false,
  });
});

test("confirmation observation threshold is inclusive and requires samples", () => {
  const empty = summarizeTradeHistory("", 500).submissionToConfirmation;
  assert.equal(empty.p95WithinThreshold, null);
  assert.equal(empty.aboveThresholdSamples, 0);
  assert.throws(
    () => summarizeTradeHistory("", 0),
    /alert threshold must be a positive safe integer/,
  );
});

test("journal state finds only decisions whose latest lifecycle is submitted", () => {
  const base = {
    schemaVersion: 2,
    timestamp: "2026-08-30T12:00:00.000Z",
    candidateAt: "2026-08-30T12:00:00.000Z",
    action: "buy",
    mint: "MintA",
    amount: 0.1,
    denominatedInSol: true,
    mode: "LIVE",
    wallet: "WalletA",
    rejectionReason: null,
  };
  const unresolvedId = "68adf508-1e9b-4c63-b4a7-2910d2155d0a";
  const confirmedId = "ee3f998b-f52c-4535-b66d-29c76f6c99a4";
  const failedId = "fa219392-c710-44b2-9b08-78eda529c407";
  const state = analyzeTradeJournalState([
    JSON.stringify({ ...base, decisionId: unresolvedId, status: "candidate", signature: null }),
    JSON.stringify({ ...base, decisionId: unresolvedId, status: "submitted", signature: "SignatureA" }),
    JSON.stringify({ ...base, decisionId: unresolvedId, status: "submitted", signature: "SignatureA" }),
    JSON.stringify({ ...base, decisionId: confirmedId, status: "submitted", signature: "SignatureB" }),
    JSON.stringify({ ...base, decisionId: confirmedId, status: "confirmed", signature: "SignatureB" }),
    JSON.stringify({ ...base, decisionId: failedId, status: "submitted", signature: "SignatureC" }),
    JSON.stringify({ ...base, decisionId: failedId, status: "failed", signature: "SignatureC" }),
    "malformed",
  ].join("\n"));

  assert.equal(state.invalidLines, 1);
  assert.deepEqual(
    state.unresolvedSubmissions.map((entry) => entry.decisionId),
    [unresolvedId],
  );
});