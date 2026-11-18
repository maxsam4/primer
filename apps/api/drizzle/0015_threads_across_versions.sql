CREATE TABLE "thread_placements" (
	"thread_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"anchor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_placements_thread_id_version_id_pk" PRIMARY KEY("thread_id","version_id")
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "document_id" uuid;--> statement-breakpoint
UPDATE "threads" t SET "document_id" = v."document_id" FROM "versions" v WHERE v."id" = t."version_id";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "document_id" SET NOT NULL;--> statement-breakpoint
INSERT INTO "thread_placements" ("thread_id", "version_id", "anchor", "created_at") SELECT "id", "version_id", "anchor", "created_at" FROM "threads";--> statement-breakpoint
ALTER TABLE "thread_placements" ADD CONSTRAINT "thread_placements_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_placements" ADD CONSTRAINT "thread_placements_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_placements_version_idx" ON "thread_placements" USING btree ("version_id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;