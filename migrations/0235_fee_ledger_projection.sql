-- owner: kernel
-- Signed receipts remain in kernel.loop_events. Historical rows stay unsigned.
ALTER TABLE pay.fee_ledger ADD COLUMN IF NOT EXISTS receipt_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fee_ledger_receipt ON pay.fee_ledger (receipt_id);

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
SELECT event_type, NULL,
  '[{"type":"loop-projection","config":{},"await":true,"enabled":true},{"type":"fee-ledger","config":{},"await":true,"propagateError":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
FROM (VALUES ('fee.record'), ('fee.rebate'), ('fee.surcharge')) AS fees(event_type)
ON CONFLICT (event_type, scope) DO UPDATE
SET reactors = EXCLUDED.reactors, enabled = EXCLUDED.enabled, updated_at = now();

-- Scoped rows override node defaults too; preserve their enabled policy.
UPDATE kernel.bus_chain_configs
SET reactors = '[{"type":"loop-projection","config":{},"await":true,"enabled":true},{"type":"fee-ledger","config":{},"await":true,"propagateError":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
    updated_at = now()
WHERE event_type IN ('fee.record', 'fee.rebate', 'fee.surcharge') AND scope IS NOT NULL;
