CREATE TABLE "connections"."connections" (
	"did_a" text NOT NULL,
	"did_b" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "connections_did_a_did_b_pk" PRIMARY KEY("did_a","did_b")
);
--> statement-breakpoint
CREATE INDEX "connections_did_a_idx" ON "connections"."connections" USING btree ("did_a");
--> statement-breakpoint
CREATE INDEX "connections_did_b_idx" ON "connections"."connections" USING btree ("did_b");
--> statement-breakpoint
INSERT INTO connections.connections (did_a, did_b, connected_at)
SELECT
  LEAST(pm1.did, pm2.did) as did_a,
  GREATEST(pm1.did, pm2.did) as did_b,
  LEAST(pm1.joined_at, pm2.joined_at) as connected_at
FROM connections.pod_members pm1
JOIN connections.pod_members pm2 ON pm1.pod_id = pm2.pod_id AND pm1.did < pm2.did
WHERE pm1.removed_at IS NULL AND pm2.removed_at IS NULL
AND pm1.pod_id IN (
  SELECT pod_id FROM connections.pod_members WHERE removed_at IS NULL GROUP BY pod_id HAVING count(*) = 2
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "connections"."nicknames" (
	"did" text NOT NULL,
	"target" text NOT NULL,
	"nickname" text NOT NULL,
	CONSTRAINT "nicknames_did_target_pk" PRIMARY KEY("did","target")
);
