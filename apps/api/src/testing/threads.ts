import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { threadPlacements, threads, versions } from '../db/schema.ts';

/** Inserts a thread on `versionId` the way the API creates one: owned by the
 *  version's document, with its placement on that version. */
export async function insertThread(
  values: Omit<typeof threads.$inferInsert, 'documentId'>,
): Promise<void> {
  const [v] = await db
    .select({ documentId: versions.documentId })
    .from(versions)
    .where(eq(versions.id, values.versionId as string));
  await db.insert(threads).values({ ...values, documentId: v.documentId });
  await db.insert(threadPlacements).values({
    threadId: values.id as string,
    versionId: values.versionId as string,
    anchor: values.anchor as typeof threads.$inferInsert['anchor'],
  });
}
