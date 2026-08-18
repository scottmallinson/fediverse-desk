/**
 * Spawned by the store tests as a genuinely separate process, so the lock is
 * exercised across processes rather than across promises in one of them.
 */
import { Queue } from '../../src/scheduler/queue.js';

const [, , dataDir, label, countRaw] = process.argv;
const count = Number(countRaw ?? 5);
const queue = Queue.open(dataDir as string);

for (let index = 0; index < count; index += 1) {
  await queue.add({ content: `${label}-${index}`, publishAt: new Date('2099-01-01') });
}
