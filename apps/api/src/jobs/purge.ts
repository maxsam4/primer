import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { docFiles, documents, versions } from '../db/schema.ts';
import { bundleStorageKeys } from '../live/bundle.ts';
import { sourceKeyOf } from '../page/publish.ts';
import { logger } from '../logger.ts';
import type { Storage } from '../storage/types.ts';

export const RESTORE_WINDOW_DAYS = 30;

export interface PurgeReport {
  purgedDocumentIds: string[];
  purgedStorageKeys: string[];
  failedStorageKeys: { key: string; error: string }[];
  durationMs: number;
}

export async function purgeExpiredDocuments(deps: { storage: Storage }): Promise<PurgeReport> {
  const startedAt = Date.now();
  const report: PurgeReport = {
    purgedDocumentIds: [],
    purgedStorageKeys: [],
    failedStorageKeys: [],
    durationMs: 0,
  };

  const candidates = (await db.execute(sql`
    SELECT id FROM documents
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - make_interval(days => ${RESTORE_WINDOW_DAYS})
    ORDER BY deleted_at ASC
  `)) as unknown as { id: string }[];

  for (const { id: docId } of candidates) {
    const versionRows = await db
      .select({ id: versions.id, storageKey: versions.storageKey, originalKey: versions.originalKey, bundleKey: versions.bundleKey, sourceFormat: versions.sourceFormat })
      .from(versions)
      .where(eq(versions.documentId, docId));
    // A checkpoint's bundle holds its storage key (static.html) among its files.
    const versionKeys: string[] = [];
    for (const v of versionRows) {
      versionKeys.push(
        ...(v.bundleKey ? await bundleStorageKeys(deps.storage, v.bundleKey) : [v.storageKey]),
        ...(v.originalKey ? [v.originalKey] : []),
        // A live page's stamped source, published (or copied) with its checkpoint;
        // deleting a key that was never written is a no-op.
        ...(v.bundleKey ? [sourceKeyOf(docId, v.id)] : []),
      );
    }
    const fileRows = await db.select({ storageKey: docFiles.storageKey }).from(docFiles).where(eq(docFiles.documentId, docId));
    const keys = [...versionKeys, ...fileRows.map((f) => f.storageKey)];

    // Delete storage files first.
    for (const key of keys) {
      try {
        await deps.storage.delete(key);
        report.purgedStorageKeys.push(key);
      } catch (err) {
        report.failedStorageKeys.push({
          key,
          error: (err as Error).message,
        });
        logger.warn({ docId, storageKey: key, err }, 'purge: storage delete failed');
      }
    }

    // Delete the doc row; FK cascade removes versions / threads / comments / document_views.
    await db.delete(documents).where(eq(documents.id, docId));
    report.purgedDocumentIds.push(docId);
    logger.info({ docId }, 'purge: document hard-deleted');
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}

export interface SessionPurgeReport {
  deletedCount: number;
  durationMs: number;
}

const SESSION_GRACE_DAYS = 7;
const DEVICE_AUTH_GRACE_DAYS = 1;
const REVOKED_TOKEN_GRACE_DAYS = 30;

function extractDeletedCount(result: unknown): number {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.count === 'number') return obj.count;
    if (typeof obj.rowCount === 'number') return obj.rowCount;
  }
  return 0;
}

export async function purgeExpiredSessions(): Promise<SessionPurgeReport> {
  const startedAt = Date.now();
  const result = (await db.execute(sql`
    DELETE FROM sessions
    WHERE expires_at < now() - make_interval(days => ${SESSION_GRACE_DAYS})
  `)) as unknown;
  // Drizzle's underlying driver may surface rowCount via different keys.
  const deletedCount = extractDeletedCount(result);
  return { deletedCount, durationMs: Date.now() - startedAt };
}

export interface DeviceAuthPurgeReport {
  deletedCount: number;
  durationMs: number;
}

export async function purgeStaleDeviceAuthorizations(): Promise<DeviceAuthPurgeReport> {
  const startedAt = Date.now();
  const result = (await db.execute(sql`
    DELETE FROM device_authorizations
    WHERE expires_at < now() - make_interval(days => ${DEVICE_AUTH_GRACE_DAYS})
  `)) as unknown;
  const deletedCount = extractDeletedCount(result);
  return { deletedCount, durationMs: Date.now() - startedAt };
}

export interface RevokedTokenPurgeReport {
  deletedCount: number;
  durationMs: number;
}

export async function purgeRevokedTokens(): Promise<RevokedTokenPurgeReport> {
  const startedAt = Date.now();
  const result = (await db.execute(sql`
    DELETE FROM api_tokens
    WHERE revoked_at IS NOT NULL
      AND revoked_at < now() - make_interval(days => ${REVOKED_TOKEN_GRACE_DAYS})
  `)) as unknown;
  const deletedCount = extractDeletedCount(result);
  return { deletedCount, durationMs: Date.now() - startedAt };
}

export function startPurgeInterval(deps: {
  storage: Storage;
  intervalMs?: number;
}): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    if (stopped) return;
    inFlight = (async () => {
      // Run each step independently so one failure doesn't block the others.
      let docReport: PurgeReport | null = null;
      let sessionReport: SessionPurgeReport | null = null;
      let deviceAuthReport: DeviceAuthPurgeReport | null = null;
      let revokedTokenReport: RevokedTokenPurgeReport | null = null;
      try {
        docReport = await purgeExpiredDocuments({ storage: deps.storage });
      } catch (err) {
        logger.error({ err }, 'purge interval: purgeExpiredDocuments failed');
      }
      try {
        sessionReport = await purgeExpiredSessions();
      } catch (err) {
        logger.error({ err }, 'purge interval: purgeExpiredSessions failed');
      }
      try {
        deviceAuthReport = await purgeStaleDeviceAuthorizations();
      } catch (err) {
        logger.error({ err }, 'purge interval: purgeStaleDeviceAuthorizations failed');
      }
      try {
        revokedTokenReport = await purgeRevokedTokens();
      } catch (err) {
        logger.error({ err }, 'purge interval: purgeRevokedTokens failed');
      }
      if (
        (docReport && (docReport.purgedDocumentIds.length > 0 || docReport.failedStorageKeys.length > 0)) ||
        (sessionReport && sessionReport.deletedCount > 0) ||
        (deviceAuthReport && deviceAuthReport.deletedCount > 0) ||
        (revokedTokenReport && revokedTokenReport.deletedCount > 0)
      ) {
        logger.info(
          { docReport, sessionReport, deviceAuthReport, revokedTokenReport },
          'purge interval: complete',
        );
      }
      inFlight = null;
    })();
    await inFlight;
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight;
  };
}
