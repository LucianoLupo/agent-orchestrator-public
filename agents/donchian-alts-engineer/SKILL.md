---
name: donchian-alts-engineer
description: Run the "donchian-alts-engineer" agent — Build the alt rotational basket variant of Donchian backtest (Zarattini/Pagani/Barbon 2025 'Catching
---

# donchian-alts-engineer

Build the alt rotational basket variant of Donchian backtest (Zarattini/Pagani/Barbon 2025 'Catching Crypto Trends', SSRN 5209907). Paper's headline was top-20 alts Sharpe 1.57; only majors tested so far (they fail OOS). Task is implementation, not research — the signal logic is already done.

## Context
- Working dir: $HOME/projects/hyperliquid-trading-bot-001
- Committed: 2ef982a adds scripts/backtest/strategies/donchian.py (signal + trailing stop + vol sizing), donchian_stats.py (returns-series metrics), run_donchian.py (CLI for majors).
- In-sample validates (BTC 2017-2025 Sharpe 1.29 ≈ paper's 1.58). OOS 2025-03→2026-04 on BTC/ETH/SOL: Sharpe -0.34 unfiltered, 0.03 with 50% vol filter.
- Existing reusable infra: scripts/backtest/fetcher.py (CCXT+SQLite), db.py (candle storage), strategies/donchian.py (DonchianConfig, backtest_asset, generate_sleeve_signals, signals_to_trades).

## Goal
Reproduce the paper's top-20 alt rotational backtest on post-paper OOS data (2025-03-20 → 2026-04-20) and see if alts carry edge that majors don't.

## Build
Do NOT reimplement Donchian signal — import from existing module.

1. Universe builder (new file, e.g., scripts/backtest/rotational/universe.py):
   - Fetch current top-50 Hyperliquid perps by 24h USD volume via CCXT hyperliquid exchange.
   - For each, check Binance USDT-perp availability; log and skip those not listed.
   - Honest caveat in docstring: universe picked from TODAY's top-50, not point-in-time; survivorship-biased toward survivors.

2. Eligibility filter (per paper):
   - ≥365 days of OHLCV history as of rebalance date
   - ≥$2M median 30d USD volume to ENTER universe
   - ≥$1M median 30d USD volume to STAY (intra-month)
   - ≥0.5% median 30d absolute daily price change to stay (kills stale)

3. Monthly rebalance at UTC month-end:
   - Re-rank eligible universe by 30d median USD volume
   - Take top-N, equal-weight 1/N of AUM per asset
   - Each selected asset runs INDEPENDENT 9-sleeve Donchian Combo at 1/N of AUM
   - Delisting: force-close if asset falls out of universe or Binance returns no data

4. Runner script (new, e.g., scripts/backtest/run_donchian_alts.py):
   - CLI with --start --end --top-n (sweep 10/20/30) --fee-bps --funding-bps-8h
   - Reuse run_donchian.py's print_stat_table formatting
   - Report per-top-N: Sharpe, Sortino, PF, MaxDD, WR, trades, universe turnover, number of assets that passed eligibility each month

## Procedure
- Plan before coding. Write the rebalance logic on paper before typing.
- Smoke-test: run universe selection ONLY for 2025-04-01 and print the 20 chosen assets before running any backtest. Sanity check that they look reasonable (e.g., AVAX, LINK, DOGE, AAVE, UNI — not random obscure coins).
- Run full OOS backtest on 2025-03-20 → 2026-04-20 for top-N ∈ {10, 20, 30}.
- Use .venv/bin/python3 directly — NOT 'uv run'. There's a shim that hangs.

## Commit cadence
Separate commits per logical unit:
- universe builder + eligibility filter
- rebalance orchestrator
- runner
- backtest results (include the output as a docs/ file or similar)

## Kill gate
Portfolio Sharpe > 1.0 AND MaxDD < 20% for at least one top-N variant.

## Stop conditions
- If kill gate FAILS: commit what you have, write a brief markdown report with the numbers, STOP. Do NOT iterate on fixes or 'improve' the strategy. We have a pre-decided next pivot (Cascade Fade).
- If kill gate PASSES: commit, report, STOP. Next steps are a human decision.

## Non-goals
- Do NOT push to origin. Local commits only.
- Do NOT modify src/ (that's production bot code unrelated to this experiment).
- Do NOT try to recover point-in-time rankings via CoinMarketCap scraping — survivor-biased universe is acceptable for MVP, just document.
- Do NOT test Cascade Fade or any other strategy — scope is strictly alt-basket Donchian.

## Reference material
- scripts/backtest/strategies/donchian.py — signal + sizing (reuse)
- scripts/backtest/strategies/donchian_stats.py — stats (reuse)
- scripts/backtest/run_donchian.py — CLI template + print_stat_table (reuse)
- scripts/backtest/fetcher.py — CCXT + SQLite (reuse)
- scripts/backtest/db.py — candle storage (reuse)
- CLAUDE.md — project conventions (relative imports, ruff, type hints)

## Run This Agent

```bash
node ~/projects/agent-orchestrator/orchestrator.mjs run donchian-alts-engineer
```

Or standalone:
```bash
~/projects/agent-orchestrator/agents/donchian-alts-engineer/run.sh
```

## Check Status
```bash
node ~/projects/agent-orchestrator/orchestrator.mjs status donchian-alts-engineer
node ~/projects/agent-orchestrator/orchestrator.mjs logs donchian-alts-engineer
```
