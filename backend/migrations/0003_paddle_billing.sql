-- Paddle Billing state. Checkout rows bind Paddle transactions to an
-- authenticated DomBook account; webhook rows provide idempotency.

CREATE TABLE billing_checkouts (
  transaction_id TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  plan            TEXT NOT NULL CHECK (plan IN ('pro', 'business')),
  price_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX billing_checkouts_account_idx ON billing_checkouts(account_id, created_at);

CREATE TABLE billing_subscriptions (
  account_id             TEXT PRIMARY KEY REFERENCES accounts(id),
  paddle_subscription_id TEXT NOT NULL UNIQUE,
  paddle_customer_id     TEXT,
  plan                   TEXT NOT NULL CHECK (plan IN ('pro', 'business')),
  status                 TEXT NOT NULL,
  price_id               TEXT NOT NULL,
  current_period_end     TEXT,
  scheduled_change_json  TEXT,
  last_event_at          TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE paddle_webhook_events (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  processed_at  TEXT NOT NULL,
  payload_json  TEXT NOT NULL
);
CREATE INDEX paddle_webhook_events_occurred_idx ON paddle_webhook_events(occurred_at);

