-- Idempotency ledger for refund reconciliation (P4.8): each MRR refund transaction is
-- applied to a rental exactly once, keyed by the transaction id, so re-seeing the same
-- credit/refund row on a later poll never double-counts.
CREATE TABLE IF NOT EXISTS applied_refunds (
  tx_id         TEXT PRIMARY KEY,
  rental_mrr_id INTEGER,
  sats          INTEGER,
  applied_at    INTEGER
);
