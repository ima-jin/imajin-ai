-- Add conversation_did to pods — links a pod to its chat conversation DID
-- Membership lives in connections (pod_members), communication lives in chat

ALTER TABLE connections.pods ADD COLUMN IF NOT EXISTS conversation_did TEXT;
CREATE INDEX IF NOT EXISTS trust_pods_conversation_did_idx ON connections.pods(conversation_did);
