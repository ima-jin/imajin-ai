-- Add conversation_reads table for tracking unread messages
CREATE TABLE IF NOT EXISTS "conversation_reads" (
	"conversation_id" text NOT NULL,
	"did" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "conversation_reads_conversation_id_did_pk" PRIMARY KEY("conversation_id","did")
);

-- Add foreign key constraint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE cascade ON UPDATE no action;
