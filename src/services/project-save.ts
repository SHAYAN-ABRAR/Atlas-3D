import { putProject } from './db';
import type { ProjectRecord } from '@/types/project';

/** A failed write must not block later saves; pending writes retain their order. */
export function createSaveQueue(write: (record: ProjectRecord) => Promise<unknown>) {
  let pending = Promise.resolve();
  return (record: ProjectRecord) => {
    const result = pending.then(() => write(record));
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// Shared across workspace mounts so navigation cannot reverse in-flight writes.
export const saveProjectSnapshot = createSaveQueue(putProject);
