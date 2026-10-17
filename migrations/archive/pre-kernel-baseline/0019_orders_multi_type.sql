-- Allow orders to span multiple ticket types (multi-type EMT carts).
-- Each ticket still carries its own ticket_type_id; the order's
-- ticket_type_id is now optional (set to NULL for multi-type orders,
-- still set for single-type orders by Stripe webhook + legacy paths).
ALTER TABLE events.orders ALTER COLUMN ticket_type_id DROP NOT NULL;
