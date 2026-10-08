import { readSessionCreate, type SessionCreate, type SessionResult } from '@picklyph/domain';
import type { AttemptStore } from '../rental/attempt';
import type { SessionOutcome } from './sessionClient';

/** One durable uncertain creation per backend/account. Never replace its key/body after dispatch. */
export function createSessionJournal(store: AttemptStore, namespace: string) {
  const key = `${namespace}.session-attempt`; let busy = false;
  const read = async (): Promise<SessionCreate | null> => {
    const raw = await store.get(key); return raw === null ? null : readSessionCreate(JSON.parse(raw));
  };
  return { read, async run(input: SessionCreate, send: (command: SessionCreate) => Promise<SessionOutcome<SessionResult>>) {
    if (busy) throw new Error('A session request is already running.');
    busy = true;
    try {
      const command = readSessionCreate(input); const saved = await read();
      if (saved && JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Resolve your original session before creating another.');
      if (!saved) await store.set(key, JSON.stringify(command));
      const outcome = await send(saved ?? command);
      if (outcome.ok || (outcome.failure.kind === 'rejected' && outcome.failure.reason !== 'request_reused')) await store.remove(key);
      return outcome;
    } finally { busy = false; }
  } };
}
