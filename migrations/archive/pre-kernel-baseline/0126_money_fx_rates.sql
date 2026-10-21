-- 0126_money_fx_rates.sql
-- packages/money (#1950, D1/D2 of #1075) — cache table backing
-- `getRate(base, quote, date, db)`'s table-first, ECB-fetch-on-miss
-- lookup.
--
-- One row per (base, quote, date) rate actually looked up — this is a
-- cache, not a full mirror of every rate ECB publishes daily, so it only
-- ever contains the pairs/dates the application has asked for. `rate` is
-- NUMERIC (exact, arbitrary-precision), never FLOAT/REAL — packages/money
-- treats every rate as a decimal string end to end and never rounds it
-- through a float on the way in or out.
--
-- `source` distinguishes a direct ECB EUR-base quote ('ecb') from one this
-- package derived by triangulating two EUR-base quotes ('ecb:triangulated'),
-- e.g. USD->CAD (ECB only ever publishes EUR-base rates).

CREATE SCHEMA IF NOT EXISTS money;

CREATE TABLE IF NOT EXISTS money.fx_rates (
  id          BIGSERIAL     PRIMARY KEY,
  base        TEXT          NOT NULL,
  quote       TEXT          NOT NULL,
  date        DATE          NOT NULL,
  rate        NUMERIC(24, 10) NOT NULL,
  source      TEXT          NOT NULL,
  fetched_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_money_fx_rates_base_quote_date
  ON money.fx_rates (base, quote, date);
