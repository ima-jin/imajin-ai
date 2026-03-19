ALTER TABLE "events"."tickets" DROP CONSTRAINT "tickets_magic_token_unique";--> statement-breakpoint
DROP INDEX "events"."idx_tickets_magic_token";--> statement-breakpoint
ALTER TABLE "events"."tickets" DROP COLUMN "magic_token";