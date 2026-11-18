/**
 * True exactly when a visibility/focus event marks the tab BECOMING visible
 * again — the moment to catch up on anything missed while it was hidden
 * (see queries/versions.ts). Live changes arrive over the document's event
 * stream (lib/eventsFeed.ts); this is only the catch-up.
 *
 * Kept pure and DOM-free so the policy is unit-testable.
 */
export function becameVisible(wasHidden: boolean, isHiddenNow: boolean): boolean {
  return wasHidden && !isHiddenNow;
}
