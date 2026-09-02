import { Connection, Keypair } from "@solana/web3.js";
import WebSocket from "ws";
import type { Config } from "./config.js";
import {
  decodePumpPortalLaunchEvent,
  EventDeduplicator,
  StreamContinuityGuard,
  type NormalizedLaunchEvent,
} from "./market-events.js";
import {
  appendProjectionEvent,
  AsyncProjectionPublisher,
  streamHealthChangedProjection,
  tokenDetectedProjection,
  tokenStatusChangedProjection,
} from "./projection-events.js";
import { executeTrade, maxBuySpendSol } from "./trader.js";

function optionalRegex(pattern: string | undefined): RegExp | undefined {
  return pattern ? new RegExp(pattern, "i") : undefined;
}

function matchesFilters(
  event: NormalizedLaunchEvent,
  nameFilter: RegExp | undefined,
  symbolFilter: RegExp | undefined,
): boolean {
  return (!nameFilter || nameFilter.test(event.name))
    && (!symbolFilter || symbolFilter.test(event.symbol));
}

export function reconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt), 30_000);
}

export function canAutoBuy(
  buys: number,
  spentSol: number,
  buyAmountSol: number,
  maxBuys: number,
  maxSpendSol: number,
  mint: string,
  boughtMints: ReadonlySet<string>,
): boolean {
  return autoBuyRejectionReasons(
    buys,
    spentSol,
    buyAmountSol,
    maxBuys,
    maxSpendSol,
    mint,
    boughtMints,
  ).length === 0;
}

export function autoBuyRejectionReasons(
  buys: number,
  spentSol: number,
  buyAmountSol: number,
  maxBuys: number,
  maxSpendSol: number,
  mint: string,
  boughtMints: ReadonlySet<string>,
): string[] {
  const subLamportTolerance = 1e-12;
  const reasons: string[] = [];
  if (buys >= maxBuys) reasons.push(`Session buy count ${buys} reached limit ${maxBuys}.`);
  if (spentSol + buyAmountSol > maxSpendSol + subLamportTolerance) {
    reasons.push(
      `Reserved session spend ${spentSol + buyAmountSol} SOL exceeds limit ${maxSpendSol} SOL.`,
    );
  }
  if (boughtMints.has(mint)) reasons.push("Token was already bought in this monitor session.");
  return reasons;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function monitorTokens(
  config: Config,
  wallet: Keypair | undefined,
  connection: Connection,
): Promise<void> {
  const nameFilter = optionalRegex(config.TOKEN_NAME_REGEX);
  const symbolFilter = optionalRegex(config.TOKEN_SYMBOL_REGEX);
  const apiKey = config.PUMPPORTAL_API_KEY
    ? `?api-key=${encodeURIComponent(config.PUMPPORTAL_API_KEY)}`
    : "";
  let buys = 0;
  let spentSol = 0;
  const boughtMints = new Set<string>();
  let tradePending = false;
  let reconnectAttempt = 0;
  const reservedBuySpendSol = maxBuySpendSol(config.BUY_AMOUNT_SOL, config.SLIPPAGE_PERCENT);
  const seenEvents = new EventDeduplicator();
  const streamContinuity = new StreamContinuityGuard();
  let streamHealthSequence = 0;
  const projectionPublisher = config.DASHBOARD_EVENT_LOG_ENABLED
    ? new AsyncProjectionPublisher(
        (event) => appendProjectionEvent(config.DASHBOARD_EVENT_LOG_PATH, event),
        config.DASHBOARD_EVENT_QUEUE_CAPACITY,
        {
          onError: (error) => console.error(
            `Dashboard event write failed: ${error instanceof Error ? error.message : error}`,
          ),
        },
      )
    : undefined;
  const publishStreamHealth = (
    status: "connected" | "disconnected" | "compromised",
    reason: string | null,
  ): void => {
    const occurredAt = new Date().toISOString();
    streamHealthSequence += 1;
    projectionPublisher?.publish(streamHealthChangedProjection({
      projectionId: `dashboard:stream-health:pumpportal:${occurredAt}:${streamHealthSequence}`,
      occurredAt,
      status,
      reason,
    }));
  };

  while (true) {
    const socket = new WebSocket(`wss://pumpportal.fun/api/data${apiKey}`);
    let opened = false;

    await new Promise<void>((resolve) => {
      socket.on("open", () => {
        opened = true;
        streamContinuity.connected();
        const continuityReason = streamContinuity.rejectionReason();
        publishStreamHealth(continuityReason ? "compromised" : "connected", continuityReason);
        socket.send(JSON.stringify({ method: "subscribeNewToken" }));
        console.log("Monitoring new Pump.fun tokens. Press Ctrl+C to stop.");
      });

      socket.on("message", async (data) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(data.toString()) as unknown;
        } catch {
          console.error("Ignored a malformed PumpPortal message.");
          return;
        }
        let event: NormalizedLaunchEvent;
        try {
          event = decodePumpPortalLaunchEvent(parsedJson, new Date().toISOString());
        } catch {
          return;
        }
        if (!seenEvents.accept(event)) return;
        if (projectionPublisher && !projectionPublisher.publish(tokenDetectedProjection(event))) {
          const health = projectionPublisher.health();
          console.error(`Dashboard event queue full; dropped ${health.dropped} event(s).`);
        }
        const matched = matchesFilters(event, nameFilter, symbolFilter);
        console.log(`${matched ? "MATCH" : "NEW  "} ${event.symbol} | ${event.name} | ${event.mint}`);
        let decisionLatencyPublished = false;
        const publishStatus = (
          status: "monitoring" | "skipped" | "entered" | "rejected",
          reasons: string[] = [],
        ): void => {
          const occurredAt = new Date();
          const stage = status === "entered" ? "position" : "decision";
          const observationToDecisionMs = stage === "decision" && !decisionLatencyPublished
            ? Math.max(0, occurredAt.getTime() - Date.parse(event.observedAt))
            : undefined;
          if (observationToDecisionMs !== undefined) decisionLatencyPublished = true;
          projectionPublisher?.publish(tokenStatusChangedProjection({
            projectionId: `dashboard:${status}:${event.eventId}`,
            occurredAt: occurredAt.toISOString(),
            tokenEventId: event.eventId,
            mint: event.mint,
            stage,
            status,
            reasons,
            observationToDecisionMs,
          }));
        };
        const filterReasons = [
          ...(nameFilter && !nameFilter.test(event.name)
            ? [`Token name does not match filter ${nameFilter}.`]
            : []),
          ...(symbolFilter && !symbolFilter.test(event.symbol)
            ? [`Token symbol does not match filter ${symbolFilter}.`]
            : []),
        ];
        if (!matched) {
          publishStatus("skipped", filterReasons);
          return;
        }
        if (!config.AUTO_BUY) {
          publishStatus("monitoring", ["Automatic buying is disabled."]);
          return;
        }
        if (!wallet) {
          publishStatus("rejected", ["Automatic buying requires a configured wallet."]);
          return;
        }
        const continuityReason = streamContinuity.rejectionReason();
        if (continuityReason) {
          publishStatus("skipped", [continuityReason]);
          return;
        }
        if (tradePending) {
          publishStatus("skipped", ["Another trade decision is pending."]);
          return;
        }
        const limitReasons = autoBuyRejectionReasons(
          buys,
          spentSol,
          reservedBuySpendSol,
          config.MAX_BUYS_PER_SESSION,
          config.MAX_SESSION_BUY_SOL,
          event.mint,
          boughtMints,
        );
        if (limitReasons.length > 0) {
          publishStatus("skipped", limitReasons);
          return;
        }

        publishStatus("monitoring", ["Entry checks passed; guarded execution is pending."]);
        tradePending = true;
        try {
          const signature = await executeTrade({
            action: "buy",
            mint: event.mint,
            amount: config.BUY_AMOUNT_SOL,
            denominatedInSol: true,
          }, config, wallet, connection);
          buys += 1;
          spentSol += reservedBuySpendSol;
          boughtMints.add(event.mint);
          publishStatus("entered");
          if (signature) console.log(`Confirmed: https://solscan.io/tx/${signature}`);
        } catch (error) {
          publishStatus("rejected", [error instanceof Error ? error.message : String(error)]);
          console.error(error instanceof Error ? error.message : error);
        } finally {
          tradePending = false;
        }
      });

      socket.on("error", (error) => console.error(`WebSocket error: ${error.message}`));
      socket.on("close", () => {
        streamContinuity.disconnected();
        publishStreamHealth(
          "disconnected",
          "PumpPortal WebSocket closed; launch-stream continuity is no longer verified.",
        );
        resolve();
      });
    });

    if (opened) reconnectAttempt = 0;
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    console.log(`PumpPortal connection closed. Reconnecting in ${delay / 1_000}s.`);
    await wait(delay);
  }
}