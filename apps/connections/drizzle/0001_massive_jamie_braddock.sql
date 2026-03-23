ALTER TABLE "connections"."graph_invites" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "connections"."graph_invites" CASCADE;--> statement-breakpoint
ALTER TABLE "connections"."invites" DROP CONSTRAINT "trust_invites_code_unique";--> statement-breakpoint
ALTER TABLE "connections"."pod_keys" DROP CONSTRAINT "trust_pod_keys_pod_id_trust_pods_id_fk";
--> statement-breakpoint
ALTER TABLE "connections"."pod_links" DROP CONSTRAINT "trust_pod_links_child_pod_id_trust_pods_id_fk";
--> statement-breakpoint
ALTER TABLE "connections"."pod_links" DROP CONSTRAINT "trust_pod_links_parent_pod_id_trust_pods_id_fk";
--> statement-breakpoint
ALTER TABLE "connections"."pod_members" DROP CONSTRAINT "trust_pod_members_pod_id_trust_pods_id_fk";
--> statement-breakpoint
DROP INDEX "connections"."idx_trust_invites_code";--> statement-breakpoint
DROP INDEX "connections"."idx_trust_invites_from_did";--> statement-breakpoint
DROP INDEX "connections"."idx_invites_code";--> statement-breakpoint
DROP INDEX "connections"."idx_invites_from_did";--> statement-breakpoint
DROP INDEX "connections"."idx_invites_status";--> statement-breakpoint
DROP INDEX "connections"."idx_invites_to_email";--> statement-breakpoint
DROP INDEX "connections"."trust_pods_conversation_did_idx";--> statement-breakpoint
DROP INDEX "connections"."trust_pods_owner_idx";--> statement-breakpoint
DROP INDEX "connections"."trust_pod_members_did_idx";--> statement-breakpoint
ALTER TABLE "connections"."pod_keys" DROP CONSTRAINT "trust_pod_keys_pod_id_version_pk";--> statement-breakpoint
ALTER TABLE "connections"."pod_member_keys" DROP CONSTRAINT "trust_pod_member_keys_pod_id_version_did_pk";--> statement-breakpoint
ALTER TABLE "connections"."pod_links" DROP CONSTRAINT "trust_pod_links_parent_pod_id_child_pod_id_pk";--> statement-breakpoint
ALTER TABLE "connections"."pod_members" DROP CONSTRAINT "trust_pod_members_pod_id_did_pk";--> statement-breakpoint
ALTER TABLE "connections"."pod_keys" ADD CONSTRAINT "pod_keys_pod_id_version_pk" PRIMARY KEY("pod_id","version");--> statement-breakpoint
ALTER TABLE "connections"."pod_member_keys" ADD CONSTRAINT "pod_member_keys_pod_id_version_did_pk" PRIMARY KEY("pod_id","version","did");--> statement-breakpoint
ALTER TABLE "connections"."pod_links" ADD CONSTRAINT "pod_links_parent_pod_id_child_pod_id_pk" PRIMARY KEY("parent_pod_id","child_pod_id");--> statement-breakpoint
ALTER TABLE "connections"."pod_members" ADD CONSTRAINT "pod_members_pod_id_did_pk" PRIMARY KEY("pod_id","did");--> statement-breakpoint
ALTER TABLE "connections"."pod_keys" ADD CONSTRAINT "pod_keys_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections"."pod_links" ADD CONSTRAINT "pod_links_parent_pod_id_pods_id_fk" FOREIGN KEY ("parent_pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections"."pod_links" ADD CONSTRAINT "pod_links_child_pod_id_pods_id_fk" FOREIGN KEY ("child_pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections"."pod_members" ADD CONSTRAINT "pod_members_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invites_code" ON "connections"."invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_invites_from_did" ON "connections"."invites" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_invites_status" ON "connections"."invites" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_invites_to_email" ON "connections"."invites" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "trust_pods_conversation_did_idx" ON "connections"."pods" USING btree ("conversation_did");--> statement-breakpoint
CREATE INDEX "trust_pods_owner_idx" ON "connections"."pods" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "trust_pod_members_did_idx" ON "connections"."pod_members" USING btree ("did");--> statement-breakpoint
ALTER TABLE "connections"."invites" DROP COLUMN "to_phone";--> statement-breakpoint
ALTER TABLE "connections"."invites" DROP COLUMN "consumed_at";--> statement-breakpoint
ALTER TABLE "connections"."invites" ADD CONSTRAINT "invites_code_unique" UNIQUE("code");