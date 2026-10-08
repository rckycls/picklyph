import { readSessionBookingCommand, type SessionBookingRequest, type SessionBookingResult } from '@picklyph/domain';
import type { AttemptStore } from '../rental/attempt';
import type { GroupOutcome } from './client';
import { canForgetGroupAttempt } from './model';

/** One durable uncertain group request per backend/account. Holds participant names on this device only; never replace its key/body after dispatch. */
export function createGroupJournal(store: AttemptStore, namespace: string) {
  const key = `${namespace}.group-attempt`; let busy = false;
  const read = async (): Promise<SessionBookingRequest | null> => {
    const raw = await store.get(key); if (raw === null) return null;
    const command = readSessionBookingCommand(JSON.parse(raw));
    if (command.kind !== 'request') throw new Error('Unreadable group recovery.');
    return command;
  };
  return { read, async run(input: SessionBookingRequest, send: (command: SessionBookingRequest) => Promise<GroupOutcome<SessionBookingResult>>) {
    if (busy) throw new Error('A group request is already running.');
    busy = true;
    try {
      const command = readSessionBookingCommand(input) as SessionBookingRequest; const saved = await read();
      if (saved && JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Resolve your original group request before starting another.');
      // Durability BEFORE dispatch; a storage failure must not create an untraceable hold.
      if (!saved) await store.set(key, JSON.stringify(command));
      const outcome = await send(saved ?? command);
      if (outcome.ok || canForgetGroupAttempt(outcome.failure)) await store.remove(key);
      return outcome;
    } finally { busy = false; }
  } };
}
