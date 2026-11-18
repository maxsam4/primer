import { createContext, useContext, useEffect, useId } from 'react';

/**
 * Lets comment inputs deep in the sidebar (a reply or an edit in a
 * ThreadCard) tell the document page they hold unsent text, so a newly
 * published version never replaces the view under a half-typed comment
 * (lib/viewedVersion.ts followNewVersion). The page provides the reporter
 * and keeps the set of dirty inputs.
 */
export const DraftReporterContext = createContext<(key: string, dirty: boolean) => void>(() => {});

/** Reports this input's draft state while it is mounted. */
export function useReportDraft(dirty: boolean): void {
  const report = useContext(DraftReporterContext);
  const key = useId();
  useEffect(() => {
    report(key, dirty);
    return () => report(key, false);
  }, [report, key, dirty]);
}
