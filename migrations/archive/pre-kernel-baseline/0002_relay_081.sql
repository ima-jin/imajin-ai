CREATE TABLE IF NOT EXISTS "relay"."relay_revocations" (
  "cid" text NOT NULL,
  "issuer_did" text NOT NULL,
  "credential_cid" text NOT NULL,
  "jws_token" text NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  CONSTRAINT "relay_revocations_issuer_did_credential_cid_pk" PRIMARY KEY ("issuer_did", "credential_cid")
);

CREATE INDEX IF NOT EXISTS "idx_relay_revocations_cid" ON "relay"."relay_revocations" ("cid");

CREATE TABLE IF NOT EXISTS "relay"."relay_public_credentials" (
  "cid" text PRIMARY KEY NOT NULL,
  "issuer_did" text,
  "att" jsonb DEFAULT '[]',
  "exp" bigint,
  "jws_token" text,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_relay_public_credentials_issuer_did" ON "relay"."relay_public_credentials" ("issuer_did");

CREATE TABLE IF NOT EXISTS "relay"."relay_documents" (
  "operation_cid" text NOT NULL,
  "content_id" text NOT NULL,
  "document_cid" text,
  "document" jsonb,
  "signer_did" text,
  "created_at" text,
  "seq" bigserial NOT NULL,
  CONSTRAINT "relay_documents_content_id_operation_cid_pk" PRIMARY KEY ("content_id", "operation_cid")
);

CREATE INDEX IF NOT EXISTS "idx_relay_documents_content_id_seq" ON "relay"."relay_documents" ("content_id", "seq");
