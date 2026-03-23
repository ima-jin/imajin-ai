CREATE SCHEMA "www";
--> statement-breakpoint
CREATE TABLE "www"."bug_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_did" text NOT NULL,
	"reporter_name" text,
	"reporter_email" text,
	"type" text DEFAULT 'bug' NOT NULL,
	"description" text NOT NULL,
	"screenshot_url" text,
	"page_url" text,
	"user_agent" text,
	"viewport" text,
	"status" text DEFAULT 'new' NOT NULL,
	"github_issue_number" integer,
	"github_issue_url" text,
	"admin_notes" text,
	"duplicate_of" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "www"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"source" text DEFAULT 'register' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_www_contacts_email" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "www"."mailing_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_www_mailing_lists_slug" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "www"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"mailing_list_id" uuid NOT NULL,
	"status" text DEFAULT 'subscribed' NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now(),
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "uniq_www_subscription" UNIQUE("contact_id","mailing_list_id")
);
--> statement-breakpoint
ALTER TABLE "www"."subscriptions" ADD CONSTRAINT "subscriptions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "www"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "www"."subscriptions" ADD CONSTRAINT "subscriptions_mailing_list_id_mailing_lists_id_fk" FOREIGN KEY ("mailing_list_id") REFERENCES "www"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bug_reports_reporter" ON "www"."bug_reports" USING btree ("reporter_did");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_status" ON "www"."bug_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_www_contacts_email" ON "www"."contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_www_mailing_lists_slug" ON "www"."mailing_lists" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_www_subscriptions_contact" ON "www"."subscriptions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_www_subscriptions_list" ON "www"."subscriptions" USING btree ("mailing_list_id");