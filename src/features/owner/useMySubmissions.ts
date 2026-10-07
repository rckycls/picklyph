import type { OwnerSubmission } from '@picklyph/domain';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { loadMySubmissions } from './liveOwner';
import { ownerFailureMessage } from './ownerClient';

export type Submissions = { status: 'loading' } | { status: 'ready'; items: OwnerSubmission[] } | { status: 'error'; message: string };

/** The signed-in user's venue submissions and claims, refreshed whenever the screen regains focus. */
export function useMySubmissions(identity: string | null) {
  const [submissions, setSubmissions] = useState<Submissions>({ status: 'loading' });
  const load = useCallback(() => {
    let active = true;
    // Keep showing the last list while refreshing, e.g. after returning from a submission.
    setSubmissions((previous) => previous.status === 'ready' ? previous : { status: 'loading' });
    void loadMySubmissions().then((outcome) => {
      if (!active) return;
      setSubmissions(outcome.ok ? { status: 'ready', items: outcome.value } : { status: 'error', message: ownerFailureMessage(outcome.failure) });
    });
    return () => { active = false; };
  }, []);
  useFocusEffect(useCallback(() => (identity ? load() : undefined), [identity, load]));
  return { submissions, reload: () => { load(); } };
}
