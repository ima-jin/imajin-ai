CREATE SCHEMA "connections";
--> statement-breakpoint
CREATE TABLE "connections"."invites" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"from_did" text NOT NULL,
	"from_handle" text,
	"to_email" text,
	"to_did" text,
	"note" text,
	"delivery" text DEFAULT 'link' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"accepted_at" timestamp with time zone,
	"consumed_by" text,
	"expires_at" timestamp with time zone,
	"role" text,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "connections"."pod_keys" (
	"pod_id" text NOT NULL,
	"version" integer NOT NULL,
	"rotated_at" timestamp DEFAULT now() NOT NULL,
	"rotated_by" text,
	CONSTRAINT "pod_keys_pod_id_version_pk" PRIMARY KEY("pod_id","version")
);
--> statement-breakpoint
CREATE TABLE "connections"."pod_links" (
	"parent_pod_id" text NOT NULL,
	"child_pod_id" text NOT NULL,
	"linked_by" text,
	"linked_at" timestamp DEFAULT now() NOT NULL,
	"unlinked_at" timestamp,
	CONSTRAINT "pod_links_parent_pod_id_child_pod_id_pk" PRIMARY KEY("parent_pod_id","child_pod_id")
);
--> statement-breakpoint
CREATE TABLE "connections"."pod_member_keys" (
	"pod_id" text NOT NULL,
	"version" integer NOT NULL,
	"did" text NOT NULL,
	"encrypted_pod_key" text NOT NULL,
	CONSTRAINT "pod_member_keys_pod_id_version_did_pk" PRIMARY KEY("pod_id","version","did")
);
--> statement-breakpoint
CREATE TABLE "connections"."pod_members" (
	"pod_id" text NOT NULL,
	"did" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" text,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"removed_at" timestamp,
	CONSTRAINT "pod_members_pod_id_did_pk" PRIMARY KEY("pod_id","did")
);
--> statement-breakpoint
CREATE TABLE "connections"."pods" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar" text,
	"owner_did" text NOT NULL,
	"type" text DEFAULT 'personal' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"conversation_did" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections"."pod_keys" ADD CONSTRAINT "pod_keys_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections"."pod_links" ADD CONSTRAINT "pod_links_parent_pod_id_pods_id_fk" FOREIGN KEY ("parent_pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections"."pod_links" ADD CONSTRAINT "pod_links_child_pod_id_pods_id_fk" FOREIGN KEY ("child_pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections"."pod_members" ADD CONSTRAINT "pod_members_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "connections"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invites_code" ON "connections"."invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_invites_from_did" ON "connections"."invites" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_invites_to_email" ON "connections"."invites" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "idx_invites_status" ON "connections"."invites" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trust_pod_members_did_idx" ON "connections"."pod_members" USING btree ("did");--> statement-breakpoint
CREATE INDEX "trust_pods_owner_idx" ON "connections"."pods" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "trust_pods_conversation_did_idx" ON "connections"."pods" USING btree ("conversation_did");