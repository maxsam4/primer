/**
 * Which version the document page shows — and therefore which version a new
 * thread or reply posts to.
 *
 * /d/:docId has no version in the URL, so it means "the latest version as of
 * when I opened this". The version list refreshes while the page is open
 * (a version.published event), and resolving "latest" on every refresh would
 * swap the iframe, the threads and the post target out from under a reader
 * mid-comment: a comment anchored on v4's text would be filed on v5. So the
 * page latches the version it resolved on first load and keeps it for that
 * navigation; only a new navigation (a new router location key — the
 * switcher, the "switch to latest" buttons, a link, or followNewVersion
 * below) re-resolves it.
 *
 * Pure so the policy is unit-testable without rendering the page.
 */

export interface VersionLatch {
  /** Router location key of the navigation this latch belongs to. */
  locationKey: string;
  versionNumber: number;
}

interface NumberedVersion {
  versionNumber: number;
}

/** The latch to hold after this render. Unchanged within one navigation;
 *  set from the newest version on the first render (of a new navigation)
 *  that has a loaded list. Not used when the URL names a version. */
export function nextLatch(params: {
  prev: VersionLatch | null;
  locationKey: string;
  requestedNumber: number | undefined;
  versions: readonly NumberedVersion[];
}): VersionLatch | null {
  const { prev, locationKey, requestedNumber, versions } = params;
  if (requestedNumber !== undefined) return null;
  if (prev && prev.locationKey === locationKey) return prev;
  const newest = versions[0];
  if (!newest) return null;
  return { locationKey, versionNumber: newest.versionNumber };
}

/** The version the page shows: the one named in the URL, else the latched
 *  one, else (latched version deleted, or list not loaded) the newest. */
export function resolveViewedVersion<V extends NumberedVersion>(params: {
  versions: readonly V[];
  requestedNumber: number | undefined;
  latch: VersionLatch | null;
}): V | undefined {
  const { versions, requestedNumber, latch } = params;
  if (requestedNumber !== undefined) {
    return versions.find((v) => v.versionNumber === requestedNumber);
  }
  if (latch) {
    const latched = versions.find((v) => v.versionNumber === latch.versionNumber);
    if (latched) return latched;
  }
  return versions[0];
}

/** The new-thread composer to show, from the page's pending anchor.
 *
 *  Deliberately NOT gated on whether the viewed version is still latest: a
 *  newer version published while composing must not unmount the composer
 *  and throw the draft away. The submit then hits the server's
 *  not_latest_version guard and the composer shows the error inline. New
 *  composers still can't open on a non-latest version, because the page
 *  only sets a pending anchor while the viewed version is latest. */
export function composerPendingFrom<A>(params: {
  pendingSelection: { anchor: A } | null;
  pendingPick: { anchor: A } | null;
}): { anchor: A; origin: 'selection' | 'pick' } | null {
  const { pendingSelection, pendingPick } = params;
  if (pendingSelection) return { anchor: pendingSelection.anchor, origin: 'selection' };
  if (pendingPick) return { anchor: pendingPick.anchor, origin: 'pick' };
  return null;
}

/** Whether a newly published version should replace the view in place.
 *  Only on /d/:docId (a URL naming a version is a deliberate pin), and only
 *  while the reader has no unsent comment, reply or edit: a draft keeps the
 *  page on its version and the "newer version" notice shows instead. */
export function followNewVersion(params: {
  requestedNumber: number | undefined;
  hasUnsentDraft: boolean;
}): boolean {
  return params.requestedNumber === undefined && !params.hasUnsentDraft;
}
