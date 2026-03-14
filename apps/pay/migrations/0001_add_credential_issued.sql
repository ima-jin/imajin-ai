ALTER TABLE pay.transactions ADD COLUMN IF NOT EXISTS credential_issued BOOLEAN DEFAULT false;
