-- Message reactions table
CREATE TABLE IF NOT EXISTS "chat_message_reactions" (
	"message_id" text NOT NULL,
	"did" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "chat_message_reactions_message_id_did_emoji_pk" PRIMARY KEY("message_id","did","emoji")
);

-- Add foreign key constraint
ALTER TABLE "chat_message_reactions" ADD CONSTRAINT "chat_message_reactions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE cascade ON UPDATE no action;

-- Create index on message_id
CREATE INDEX IF NOT EXISTS "idx_chat_message_reactions_message" ON "chat_message_reactions" ("message_id");
