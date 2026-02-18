/**
 * Quick smoke test for MemoryFileStore.
 * Run with: npx tsx server/src/filestore.test.ts
 */

import { MemoryFileStore } from './filestore.js';

async function test() {
  const store = new MemoryFileStore();

  // put and get
  await store.put('hello.txt', Buffer.from('world'), { contentType: 'text/plain' });
  const entry = await store.get('hello.txt');
  assert(entry !== null, 'get should return entry');
  assert(entry!.data.toString() === 'world', 'data should match');
  assert(entry!.metadata.contentType === 'text/plain', 'contentType should match');
  assert(entry!.metadata.size === 5, 'size should be 5');

  // exists
  assert(await store.exists('hello.txt'), 'should exist');
  assert(!(await store.exists('nope.txt')), 'should not exist');

  // head
  const meta = await store.head('hello.txt');
  assert(meta !== null, 'head should return metadata');
  assert(meta!.size === 5, 'head size should be 5');

  // list
  await store.put('tasks/a.json', Buffer.from('{}'));
  await store.put('tasks/b.json', Buffer.from('{}'));
  await store.put('other/c.json', Buffer.from('{}'));

  const all = await store.list();
  assert(all.length === 4, `list all should be 4, got ${all.length}`);

  const tasks = await store.list({ prefix: 'tasks/' });
  assert(tasks.length === 2, `list tasks/ should be 2, got ${tasks.length}`);
  assert(tasks[0] === 'tasks/a.json', 'should be sorted');

  const limited = await store.list({ prefix: 'tasks/', limit: 1 });
  assert(limited.length === 1, 'limit should work');

  const offset = await store.list({ prefix: 'tasks/', offset: 1 });
  assert(offset.length === 1, 'offset should work');
  assert(offset[0] === 'tasks/b.json', 'offset should skip first');

  // overwrite preserves createdAt
  const created = entry!.metadata.createdAt;
  await new Promise(r => setTimeout(r, 10));
  await store.put('hello.txt', Buffer.from('updated'));
  const updated = await store.get('hello.txt');
  assert(updated!.data.toString() === 'updated', 'data should be updated');
  assert(updated!.metadata.createdAt.getTime() === created.getTime(), 'createdAt should be preserved');
  assert(updated!.metadata.updatedAt.getTime() > created.getTime(), 'updatedAt should be newer');

  // delete
  await store.delete('hello.txt');
  assert(!(await store.exists('hello.txt')), 'should be deleted');
  assert((await store.get('hello.txt')) === null, 'get after delete should be null');

  // delete non-existent is no-op
  await store.delete('nonexistent');

  console.log('✓ All FileStore tests passed');
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

test().catch(err => {
  console.error('✗ Test failed:', err.message);
  process.exit(1);
});
