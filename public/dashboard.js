const pinStorageKey = "snipa-scanner-pins-v1";
const quickBuyStorageKey = "snipa-quick-buy-sol-v1";
function loadPins() {
  try {
    const value = JSON.parse(localStorage.getItem(pinStorageKey) || "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}
function loadQuickBuyAmount() {
  const value = Number(localStorage.getItem(quickBuyStorageKey));
  return Number.isFinite(value) && value > 0 ? value : 0.01;
}
const state = {
  tokens: [],
  status: "",
  query: "",
  sort: "newest",
  pins: loadPins(),
  control: null,
  selectedMint: null,
  marketData: null,
  marketCaps: {},
  marketCapsLoaded: false,
  tokenActivity: {},
  holderConcentration: {},
  quickBuyAmount: loadQuickBuyAmount(),
};
const $ = (selector) => document.querySelector(selector);
const elements = {
  body: $("#scanner-body"),
  empty: $("#empty-state"),
  error: $("#error-state"),
  total: $("#token-total"),
  healthDot: $("#health-dot"),
  healthLabel: $("#health-label"),
  decisionLatency: $("#decision-latency"),
  lastUpdate: $("#last-update"),
  tradingMode: $("#trading-mode"),
  wallet: $("#wallet-button"),
  search: $("#search-input"),
  sort: $("#sort-select"),
  quickAmount: $("#quick-buy-amount"),
  filters: $("#status-filters"),
  refresh: $("#refresh-button"),
  canvas: $("#activity-canvas"),
  drawer: $("#token-drawer"),
  backdrop: $("#drawer-backdrop"),
  close: $("#close-drawer"),
  drawerTitle: $("#drawer-title"),
  drawerSymbol: $("#drawer-symbol"),
  drawerContent: $("#drawer-content"),
};
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );
}
function age(timestamp) {
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
function titleCase(value) {
  return String(value)
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
function sortableMetric(token) {
  if (state.sort.startsWith("market-cap-"))
    return state.marketCaps[token.mint]?.marketCapUsd;
  if (state.sort.startsWith("liquidity-"))
    return state.marketCaps[token.mint]?.liquidityUsd;
  if (state.sort.startsWith("buy-pressure-"))
    return state.tokenActivity[token.mint]?.buyPressurePercent;
  if (state.sort.startsWith("volume-acceleration-"))
    return state.tokenActivity[token.mint]?.volumeAcceleration;
  if (state.sort.startsWith("activity-"))
    return state.tokenActivity[token.mint]?.activeTraders5m;
  if (state.sort.startsWith("curve-progress-"))
    return state.marketCaps[token.mint]?.curveProgressBps;
  if (state.sort.startsWith("holders-"))
    return state.holderConcentration[token.mint]?.top10HolderPercent;
  if (state.sort.startsWith("boosts-"))
    return state.marketCaps[token.mint]?.activeBoosts;
  return undefined;
}
function compareTokens(left, right) {
  const metricSort = state.sort.endsWith("-asc") || state.sort.endsWith("-desc");
  if (!metricSort) {
    const pinDifference =
      Number(state.pins.has(right.mint)) - Number(state.pins.has(left.mint));
    if (pinDifference) return pinDifference;
  }
  let comparison = 0;
  if (state.sort === "oldest")
    comparison = Date.parse(left.detectedAt) - Date.parse(right.detectedAt);
  else if (state.sort === "status")
    comparison = left.status.localeCompare(right.status);
  else if (state.sort === "token")
    comparison = left.name.localeCompare(right.name);
  else if (metricSort) {
    const leftValue = sortableMetric(left);
    const rightValue = sortableMetric(right);
    const leftAvailable = Number.isFinite(leftValue);
    const rightAvailable = Number.isFinite(rightValue);
    if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
    if (leftAvailable)
      comparison =
        state.sort.endsWith("-desc")
          ? rightValue - leftValue
          : leftValue - rightValue;
  } else
    comparison = Date.parse(right.detectedAt) - Date.parse(left.detectedAt);
  return (
    comparison ||
    Date.parse(right.detectedAt) - Date.parse(left.detectedAt) ||
    left.mint.localeCompare(right.mint)
  );
}
function visibleTokens() {
  const query = state.query.trim().toLowerCase();
  return state.tokens
    .filter(
      (token) =>
        (!state.status || token.status === state.status) &&
        (!query ||
          [token.name, token.symbol, token.mint].some((value) =>
            value.toLowerCase().includes(query),
          )),
    )
    .sort(compareTokens);
}
function renderTable() {
  const tokens = visibleTokens();
  const buyEnabled = Boolean(state.control?.manualBuy?.enabled);
  elements.body.innerHTML = tokens
    .map((token) => {
      const pinned = state.pins.has(token.mint);
      const marketCap = state.marketCaps[token.mint];
      const activity = state.tokenActivity[token.mint];
      const holderConcentration =
        state.holderConcentration[token.mint]?.top10HolderPercent;
      const marketCapAvailable = Number.isFinite(marketCap?.marketCapUsd);
      const marketCapLabel = marketCapAvailable
        ? formatUsd(marketCap.marketCapUsd)
        : state.marketCapsLoaded && marketCap === undefined
          ? "Outside fast window"
          : "Indexing";
      const marketCapTitle = marketCap?.pairAddress
        ? `Deepest indexed pool ${marketCap.pairAddress}`
        : marketCapAvailable
          ? "Verified Pump bonding curve"
          : marketCap === undefined && state.marketCapsLoaded
            ? "Only the 90 newest scanner mints use the market-data fast path"
            : "Waiting for indexed market data";
      return `<tr tabindex="0" data-event-id="${escapeHtml(token.tokenEventId)}"><td><div class="token-heading"><button class="pin-button${pinned ? " pinned" : ""}" type="button" data-pin-mint="${escapeHtml(token.mint)}" aria-pressed="${pinned}" aria-label="${pinned ? "Unpin" : "Pin"} ${escapeHtml(token.name)}" title="${pinned ? "Unpin token" : "Pin token"}"><span aria-hidden="true">${pinned ? "&#9733;" : "&#9734;"}</span></button><span class="token-name">${escapeHtml(token.symbol)} / ${escapeHtml(token.name)}</span></div><span class="token-mint">${escapeHtml(token.mint)}</span><a class="pump-link" href="https://pump.fun/coin/${encodeURIComponent(token.mint)}" target="_blank" rel="noopener noreferrer">Pump.fun</a></td><td class="age-cell" data-detected-at="${escapeHtml(token.detectedAt)}">${age(token.detectedAt)}</td><td>${escapeHtml(titleCase(token.venue))}</td><td>${escapeHtml(titleCase(token.stage))}</td><td><span class="badge badge-${escapeHtml(token.status)}">${escapeHtml(token.status)}</span></td><td class="market-cap-cell ${marketCapAvailable ? "" : "unavailable"}" title="${escapeHtml(marketCapTitle)}">${escapeHtml(marketCapLabel)}</td><td class="signal-cell ${Number.isFinite(marketCap?.liquidityUsd) ? "" : "unavailable"}">${Number.isFinite(marketCap?.liquidityUsd) ? escapeHtml(formatUsd(marketCap.liquidityUsd)) : "Unavailable"}</td><td class="signal-cell ${Number.isFinite(activity?.buyPressurePercent) ? "" : "unavailable"}" title="Share of five-minute trades that are buys.">${Number.isFinite(activity?.buyPressurePercent) ? `${escapeHtml(activity.buyPressurePercent.toFixed(1))}%` : "Unavailable"}</td><td class="signal-cell ${Number.isFinite(activity?.volumeAcceleration) ? "" : "unavailable"}" title="Five-minute volume pace divided by the preceding ten-minute pace.">${Number.isFinite(activity?.volumeAcceleration) ? `${escapeHtml(activity.volumeAcceleration.toFixed(2))}x` : "Unavailable"}</td><td class="activity-cell ${Number.isFinite(activity?.activeTraders5m) ? "" : "unavailable"}" title="Buyer plus seller counts; a wallet active on both sides may be counted twice.">${Number.isFinite(activity?.activeTraders5m) ? escapeHtml(activity.activeTraders5m) : "Unavailable"}</td><td class="signal-cell ${Number.isFinite(marketCap?.curveProgressBps) ? "" : "unavailable"}">${Number.isFinite(marketCap?.curveProgressBps) ? `${escapeHtml((marketCap.curveProgressBps / 100).toFixed(1))}%` : "Unavailable"}</td><td class="signal-cell ${Number.isFinite(holderConcentration) ? "" : "unavailable"}" title="Share held by the ten largest token accounts; pools and bonding curves may be included.">${Number.isFinite(holderConcentration) ? `${escapeHtml(holderConcentration.toFixed(1))}%` : "Unavailable"}</td><td class="signal-cell ${Number.isFinite(marketCap?.activeBoosts) ? "" : "unavailable"}" title="Active paid DexScreener boosts; promotion is not evidence of legitimacy or organic demand.">${Number.isFinite(marketCap?.activeBoosts) ? escapeHtml(marketCap.activeBoosts) : "Unavailable"}</td><td><span class="reason">${escapeHtml(token.reasons.join("; ") || "No decision reason recorded")}</span></td><td><button class="quick-buy-button" type="button" data-quick-buy-mint="${escapeHtml(token.mint)}" ${buyEnabled ? "" : "disabled"}>Quick buy</button><span class="quick-buy-status" role="status"></span></td></tr>`;
    })
    .join("");
  elements.empty.classList.toggle("hidden", tokens.length > 0);
}
function updateAges() {
  document.querySelectorAll(".age-cell").forEach((cell) => {
    cell.textContent = age(cell.dataset.detectedAt);
  });
}
function drawDistribution(counts) {
  const canvas = elements.canvas;
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 480;
  const height = canvas.clientHeight || 112;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  const values = Object.values(counts);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) {
    context.strokeStyle = "#cbd2cd";
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
    return;
  }
  let x = 0;
  ["#276a8c", "#a86508", "#087a5b", "#b4382f"].forEach((color, index) => {
    const segment =
      index === values.length - 1 ? width - x : width * (values[index] / total);
    context.fillStyle = color;
    context.fillRect(x, 34, Math.max(0, segment - 3), 44);
    x += segment;
  });
}
function renderMetrics() {
  const counts = Object.fromEntries(
    ["scanning", "monitoring", "entered", "rejected"].map((status) => [
      status,
      state.tokens.filter((token) => token.status === status).length,
    ]),
  );
  elements.total.textContent = String(state.tokens.length);
  Object.entries(counts).forEach(([status, count]) => {
    $(`#metric-${status}`).textContent = String(count);
  });
  drawDistribution(counts);
}
function renderTimeline(token) {
  if (!Array.isArray(token.timeline))
    return '<p class="unavailable">Lifecycle unavailable from this projection.</p>';
  return `<ol class="timeline">${token.timeline.map((entry) => `<li><div class="timeline-heading"><span class="badge badge-${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span><time datetime="${escapeHtml(entry.occurredAt)}">${escapeHtml(new Date(entry.occurredAt).toLocaleTimeString())}</time></div><p>${escapeHtml(titleCase(entry.stage))}${Number.isInteger(entry.observationToDecisionMs) ? ` · Decision in ${escapeHtml(entry.observationToDecisionMs)} ms` : ""}</p>${entry.reasons.length ? `<ul>${entry.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ol>`;
}
function openDrawer(token) {
  const buy = state.control?.manualBuy;
  const max = buy?.enabled ? buy.maxAmountSol : 0;
  const defaultAmount = Math.min(0.01, max);
  state.selectedMint = token.mint;
  state.marketData = null;
  elements.drawerTitle.textContent = token.name;
  elements.drawerSymbol.textContent = token.symbol;
  elements.drawerContent.innerHTML = `<section class="trade-block"><div class="trade-heading"><h3>Manual buy</h3><span class="mode-badge">${escapeHtml(buy?.mode || "Unavailable")}</span></div>${buy?.enabled ? `<form class="buy-form" id="manual-buy-form" data-mint="${escapeHtml(token.mint)}"><label><span>Amount (SOL)</span><input name="amountSol" type="number" min="0.000001" max="${escapeHtml(max)}" step="0.001" value="${escapeHtml(defaultAmount)}" required></label><button class="buy-button" type="submit">Buy ${escapeHtml(buy.mode)}</button><p class="trade-status" role="status">Maximum ${escapeHtml(max)} SOL</p></form>` : '<p class="trade-status">Manual buying is unavailable.</p>'}</section><section class="market-block" aria-labelledby="market-heading"><div class="market-heading"><div><p class="eyebrow">Live market</p><h3 id="market-heading">Price &amp; transactions</h3></div><a class="source-link" href="https://www.geckoterminal.com/solana/tokens/${escapeHtml(token.mint)}" target="_blank" rel="noopener noreferrer">GeckoTerminal</a></div><div class="market-state" id="market-state" role="status">Loading live market data...</div><div class="market-content hidden" id="market-content"><dl class="market-metrics" id="market-metrics"></dl><canvas class="price-chart" id="price-chart" width="456" height="220" aria-label="Live token price chart"></canvas><div class="chart-axis"><span>120 minutes ago</span><span>Now</span></div><div class="transaction-heading"><h4>Recent swaps</h4><span id="market-updated"></span></div><div class="transaction-scroll"><table class="transaction-table"><thead><tr><th>Time</th><th>Side</th><th>Value</th><th>Wallet</th><th>Tx</th></tr></thead><tbody id="transaction-body"></tbody></table></div></div></section><dl class="detail-grid"><div><dt>Status</dt><dd><span class="badge badge-${escapeHtml(token.status)}">${escapeHtml(token.status)}</span></dd></div><div><dt>Stage</dt><dd>${escapeHtml(titleCase(token.stage))}</dd></div><div><dt>Venue</dt><dd>${escapeHtml(titleCase(token.venue))}</dd></div><div><dt>Detected</dt><dd>${escapeHtml(new Date(token.detectedAt).toLocaleString())}</dd></div><div><dt>Mint</dt><dd>${escapeHtml(token.mint)}</dd></div><div><dt>Last update</dt><dd>${escapeHtml(new Date(token.updatedAt).toLocaleString())}</dd></div><div><dt>Safety</dt><dd class="unavailable">Unavailable</dd></div><div><dt>Momentum</dt><dd class="unavailable">Unavailable</dd></div></dl><section class="finding-block"><h3>Decision findings</h3>${token.reasons.length ? token.reasons.map((reason) => `<p class="finding">${escapeHtml(reason)}</p>`).join("") : '<p class="unavailable">No decision findings recorded.</p>'}</section><section class="timeline-block"><h3>Decision timeline</h3>${renderTimeline(token)}</section>`;
  elements.drawer.classList.add("open");
  elements.drawer.setAttribute("aria-hidden", "false");
  elements.backdrop.classList.remove("hidden");
  elements.close.focus();
  void refreshTokenMarket(token.mint);
}
function closeDrawer() {
  state.selectedMint = null;
  state.marketData = null;
  elements.drawer.classList.remove("open");
  elements.drawer.setAttribute("aria-hidden", "true");
  elements.backdrop.classList.add("hidden");
}
function formatUsd(value) {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (Math.abs(value) < 0.01) return `$${value.toPrecision(4)}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(value) >= 1000000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}
function shortAddress(value) {
  return value.length > 10
    ? `${value.slice(0, 4)}...${value.slice(-4)}`
    : value;
}
function drawPriceChart(candles) {
  const canvas = $("#price-chart");
  if (!canvas || !candles.length) return;
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 456;
  const height = canvas.clientHeight || 220;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  const padding = { top: 12, right: 8, bottom: 12, left: 8 };
  const high = Math.max(...candles.map((item) => item.high));
  const low = Math.min(...candles.map((item) => item.low));
  const range = high - low || Math.max(high * 0.01, 1e-12);
  const y = (price) =>
    padding.top +
    ((high - price) / range) * (height - padding.top - padding.bottom);
  const step = (width - padding.left - padding.right) / candles.length;
  context.strokeStyle = "#d9dfda";
  context.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const gridY =
      padding.top + (index * (height - padding.top - padding.bottom)) / 3;
    context.beginPath();
    context.moveTo(padding.left, gridY);
    context.lineTo(width - padding.right, gridY);
    context.stroke();
  }
  candles.forEach((candle, index) => {
    const x = padding.left + (index + 0.5) * step;
    const rising = candle.close >= candle.open;
    const candleWidth = Math.min(8, Math.max(1, step * 0.56));
    context.strokeStyle = rising ? "#087a5b" : "#b4382f";
    context.fillStyle = context.strokeStyle;
    context.beginPath();
    context.moveTo(x, y(candle.high));
    context.lineTo(x, y(candle.low));
    context.stroke();
    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));
    context.fillRect(
      x - candleWidth / 2,
      top,
      candleWidth,
      Math.max(1, bottom - top),
    );
  });
}
function renderTokenMarket(data) {
  const content = $("#market-content");
  const loading = $("#market-state");
  if (!content || !loading) return;
  state.marketData = data;
  loading.classList.add("hidden");
  content.classList.remove("hidden");
  const change = data.pool.change24hPercent;
  $("#market-metrics").innerHTML =
    `<div><dt>Price</dt><dd>${escapeHtml(formatUsd(data.pool.priceUsd))}</dd></div><div><dt>24h change</dt><dd class="${change === null ? "" : change >= 0 ? "positive" : "negative"}">${change === null ? "Unavailable" : `${change >= 0 ? "+" : ""}${escapeHtml(change.toFixed(2))}%`}</dd></div><div><dt>Active traders (5m)</dt><dd title="Buyer plus seller counts; a wallet active on both sides may be counted twice.">${escapeHtml(data.pool.activeTraders5m)}</dd></div><div><dt>Swaps (5m)</dt><dd><span class="positive">${escapeHtml(data.pool.buys5m)} buys</span> / <span class="negative">${escapeHtml(data.pool.sells5m)} sells</span></dd></div><div><dt>Liquidity</dt><dd>${escapeHtml(formatUsd(data.pool.liquidityUsd))}</dd></div><div><dt>24h volume</dt><dd>${escapeHtml(formatUsd(data.pool.volume24hUsd))}</dd></div>`;
  $("#market-updated").textContent =
    `${data.pool.name} · ${titleCase(data.pool.dex)} · ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#transaction-body").innerHTML =
    data.trades
      .slice(0, 30)
      .map(
        (trade) =>
          `<tr><td>${escapeHtml(new Date(trade.timestamp).toLocaleTimeString())}</td><td><span class="trade-side ${escapeHtml(trade.side)}">${escapeHtml(trade.side)}</span></td><td>${escapeHtml(formatUsd(trade.volumeUsd))}</td><td><a href="https://solscan.io/account/${escapeHtml(trade.wallet)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortAddress(trade.wallet))}</a></td><td><a href="https://solscan.io/tx/${escapeHtml(trade.signature)}" target="_blank" rel="noopener noreferrer">View</a></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="unavailable">No recent swaps indexed.</td></tr>';
  drawPriceChart(data.candles);
}
async function refreshTokenMarket(mint) {
  try {
    const response = await fetch(
      `/api/token-market?mint=${encodeURIComponent(mint)}`,
      { cache: "no-store" },
    );
    const data = await response.json();
    if (state.selectedMint !== mint) return;
    if (!response.ok)
      throw new Error(data.error || `Market API returned ${response.status}`);
    renderTokenMarket(data);
  } catch (error) {
    if (state.selectedMint !== mint) return;
    const marketState = $("#market-state");
    if (marketState) {
      marketState.classList.remove("hidden");
      marketState.textContent =
        error instanceof Error
          ? error.message
          : "Live market data is unavailable.";
    }
  } finally {
    window.setTimeout(() => {
      if (state.selectedMint === mint) void refreshTokenMarket(mint);
    }, 15000);
  }
}
async function loadControl() {
  try {
    const response = await fetch("/api/control", { cache: "no-store" });
    if (response.ok) {
      state.control = await response.json();
      const buy = state.control.manualBuy;
      elements.tradingMode.textContent = buy.enabled
        ? `${buy.mode} trading`
        : "Trading unavailable";
      elements.tradingMode.classList.toggle("live", buy.mode === "live");
      elements.wallet.disabled = !state.control.wallet?.available;
      elements.quickAmount.max = String(buy.maxAmountSol);
      if (state.quickBuyAmount > buy.maxAmountSol) {
        state.quickBuyAmount = buy.maxAmountSol;
        elements.quickAmount.value = String(state.quickBuyAmount);
      }
      renderTable();
    }
  } catch {
    state.control = null;
    elements.tradingMode.textContent = "Trading unavailable";
    elements.wallet.disabled = true;
    renderTable();
  }
}
async function refreshMarketCaps() {
  try {
    const response = await fetch("/api/market-caps", { cache: "no-store" });
    if (!response.ok)
      throw new Error(`Market-cap API returned ${response.status}`);
    const data = await response.json();
    state.marketCaps = Object.fromEntries(
      data.tokens.map((token) => [token.mint, token]),
    );
    state.marketCapsLoaded = true;
    renderTable();
  } catch {}
}
async function refreshTokenActivity() {
  try {
    const response = await fetch("/api/token-activity", { cache: "no-store" });
    if (!response.ok)
      throw new Error(`Activity API returned ${response.status}`);
    const data = await response.json();
    state.tokenActivity = Object.fromEntries(
      data.tokens.map((token) => [token.mint, token]),
    );
    renderTable();
  } catch {}
}
async function refreshHolderConcentration() {
  try {
    const response = await fetch("/api/holder-concentration", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Holder API returned ${response.status}`);
    const data = await response.json();
    state.holderConcentration = Object.fromEntries(
      data.tokens.map((token) => [token.mint, token]),
    );
    renderTable();
  } catch {}
}
async function connectWallet() {
  elements.wallet.disabled = true;
  elements.wallet.textContent = "Connecting...";
  try {
    const response = await fetch("/api/wallet", { cache: "no-store" });
    const wallet = await response.json();
    if (!response.ok)
      throw new Error(wallet.error || "Local wallet unavailable.");
    elements.wallet.textContent = `${shortAddress(wallet.address)} · ${wallet.balanceSol.toFixed(4)} SOL`;
    elements.wallet.title = wallet.address;
  } catch (error) {
    elements.wallet.textContent = "Wallet unavailable";
    elements.wallet.title =
      error instanceof Error ? error.message : "Local wallet unavailable.";
  } finally {
    elements.wallet.disabled = false;
  }
}
async function submitBuy(
  mint,
  amountSol,
  button,
  status,
  statusClass = "trade-status",
) {
  const buy = state.control?.manualBuy;
  if (!buy?.enabled) {
    status.className = `${statusClass} rejected`;
    status.textContent = "Trading unavailable.";
    return;
  }
  const mode = buy.mode;
  if (
    !Number.isFinite(amountSol) ||
    amountSol <= 0 ||
    amountSol > buy.maxAmountSol
  ) {
    status.className = `${statusClass} rejected`;
    status.textContent = `Enter up to ${buy.maxAmountSol} SOL.`;
    return;
  }
  if (
    !window.confirm(
      `${mode === "live" ? "Send a LIVE" : "Record a PAPER"} buy of ${amountSol} SOL for ${mint}?`,
    )
  )
    return;
  button.disabled = true;
  status.className = `${statusClass} pending`;
  status.textContent = `Submitting ${mode} buy...`;
  try {
    const response = await fetch("/api/manual-buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Snipa-CSRF": state.control.csrfToken,
      },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        mint,
        amountSol,
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error || `Manual buy rejected (${response.status})`,
      );
    status.className = `${statusClass} success`;
    status.innerHTML = result.signature
      ? `Confirmed: <a href="https://solscan.io/tx/${escapeHtml(result.signature)}" target="_blank" rel="noopener noreferrer">View transaction</a>`
      : `Paper buy recorded: ${escapeHtml(result.amountSol)} SOL`;
  } catch (error) {
    status.className = `${statusClass} rejected`;
    status.textContent =
      error instanceof Error ? error.message : "Manual buy rejected.";
  } finally {
    button.disabled = false;
  }
}
async function submitManualBuy(form) {
  const amountSol = Number(new FormData(form).get("amountSol"));
  await submitBuy(
    form.dataset.mint,
    amountSol,
    form.querySelector("button"),
    form.querySelector(".trade-status"),
  );
}
async function refresh() {
  elements.refresh.disabled = true;
  try {
    const response = await fetch("/api/scanner?limit=1000", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Scanner API returned ${response.status}`);
    const snapshot = await response.json();
    const changed =
      JSON.stringify(state.tokens) !== JSON.stringify(snapshot.tokens);
    state.tokens = snapshot.tokens;
    elements.error.classList.add("hidden");
    const freshness = snapshot.freshness;
    const unhealthyStream = snapshot.streams?.find(
      (stream) => stream.status !== "connected",
    );
    const degraded =
      snapshot.sourceMissing ||
      snapshot.replay.invalidLines > 0 ||
      snapshot.replay.rejectedTransitions > 0 ||
      !freshness ||
      Boolean(unhealthyStream);
    elements.healthDot.className = `health-dot ${degraded || freshness?.stale ? "degraded" : "healthy"}`;
    elements.healthLabel.textContent = unhealthyStream
      ? unhealthyStream.status === "compromised"
        ? "Stream compromised"
        : "Stream disconnected"
      : !freshness
        ? "Freshness unavailable"
        : degraded
          ? "Projection degraded"
          : freshness.stale
            ? "Projection stale"
            : freshness.lastEventAt
              ? "Projection healthy"
              : "Waiting for events";
    elements.healthLabel.title = unhealthyStream?.reason || "";
    const latency = snapshot.observationToDecision;
    elements.decisionLatency.textContent =
      latency?.p95Ms === null || latency?.p95Ms === undefined
        ? "Decision P95 unavailable"
        : `Decision P95 ${latency.p95Ms} ms`;
    elements.decisionLatency.title = latency?.sampleCount
      ? `Local observation-to-decision latency from ${latency.sampleCount} sample${latency.sampleCount === 1 ? "" : "s"}; P50 ${latency.p50Ms} ms, max ${latency.maxMs} ms`
      : "No local decision-latency samples recorded";
    elements.lastUpdate.textContent = freshness?.lastEventAt
      ? `Event ${age(freshness.lastEventAt)} ago`
      : `Checked ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
    if (changed) {
      renderTable();
      renderMetrics();
    } else updateAges();
  } catch (error) {
    elements.healthDot.className = "health-dot degraded";
    elements.healthLabel.textContent = "API unavailable";
    elements.healthLabel.title = "";
    elements.decisionLatency.textContent = "Decision P95 unavailable";
    elements.error.textContent =
      error instanceof Error ? error.message : String(error);
    elements.error.classList.remove("hidden");
  } finally {
    elements.refresh.disabled = false;
  }
}
elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  renderTable();
});
elements.sort.addEventListener("change", () => {
  state.sort = elements.sort.value;
  renderTable();
});
elements.quickAmount.value = String(state.quickBuyAmount);
elements.quickAmount.addEventListener("change", () => {
  const amount = Number(elements.quickAmount.value);
  const max =
    state.control?.manualBuy?.maxAmountSol ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(amount) || amount <= 0 || amount > max) {
    elements.quickAmount.value = String(state.quickBuyAmount);
    return;
  }
  state.quickBuyAmount = amount;
  try {
    localStorage.setItem(quickBuyStorageKey, String(amount));
  } catch {}
});
elements.filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  state.status = button.dataset.status;
  elements.filters
    .querySelectorAll("button")
    .forEach((item) => item.classList.toggle("active", item === button));
  renderTable();
});
elements.body.addEventListener("click", (event) => {
  const pin = event.target.closest("button[data-pin-mint]");
  if (pin) {
    const mint = pin.dataset.pinMint;
    if (state.pins.has(mint)) state.pins.delete(mint);
    else state.pins.add(mint);
    try {
      localStorage.setItem(pinStorageKey, JSON.stringify([...state.pins]));
    } catch {}
    renderTable();
    return;
  }
  const quickBuy = event.target.closest("button[data-quick-buy-mint]");
  if (quickBuy) {
    const status = quickBuy.parentElement.querySelector(".quick-buy-status");
    void submitBuy(
      quickBuy.dataset.quickBuyMint,
      state.quickBuyAmount,
      quickBuy,
      status,
      "quick-buy-status",
    );
    return;
  }
  if (event.target.closest("a")) return;
  const row = event.target.closest("tr[data-event-id]");
  const token = state.tokens.find(
    (item) => item.tokenEventId === row?.dataset.eventId,
  );
  if (token) openDrawer(token);
});
elements.body.addEventListener("keydown", (event) => {
  if (
    event.target.closest("button,a") ||
    (event.key !== "Enter" && event.key !== " ")
  )
    return;
  const row = event.target.closest("tr[data-event-id]");
  const token = state.tokens.find(
    (item) => item.tokenEventId === row?.dataset.eventId,
  );
  if (token) openDrawer(token);
});
elements.drawerContent.addEventListener("submit", (event) => {
  if (event.target.id !== "manual-buy-form") return;
  event.preventDefault();
  void submitManualBuy(event.target);
});
elements.wallet.addEventListener("click", () => void connectWallet());
elements.refresh.addEventListener("click", () => {
  void refresh();
  void refreshMarketCaps();
  void refreshTokenActivity();
});
elements.close.addEventListener("click", closeDrawer);
elements.backdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});
window.addEventListener("resize", renderMetrics);
void loadControl();
refresh();
void refreshMarketCaps();
void refreshTokenActivity();
window.setInterval(refresh, 2000);
window.setInterval(refreshMarketCaps, 5000);
window.setInterval(refreshTokenActivity, 60000);
window.setTimeout(() => {
  void refreshHolderConcentration();
  window.setInterval(refreshHolderConcentration, 300000);
}, 30000);
window.setInterval(updateAges, 1000);
