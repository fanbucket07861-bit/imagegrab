/* Node 原生测试：使用 Chrome API 替身验证真实 background.js，无网络/真实下载副作用。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function harness(saved = {}) {
  let messageListener, downloadListener, startupListener;
  const tabs = [], downloads = [], remote = [];
  const chrome = {
    runtime: {
      id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: async message => { remote.push(message); return message.type === 'PING' ? { ok: true, running: [] } : { ok: true }; },
      onMessage: { addListener: fn => { messageListener = fn; } }, onStartup: { addListener: fn => { startupListener = fn; } }
    },
    storage: { local: { get: async key => structuredClone({ [key]: saved[key] }), set: async update => { Object.assign(saved, structuredClone(update)); } } },
    tabs: { create: async input => { tabs.push(input); }, sendMessage: async () => ({ ok: true }) },
    scripting: { executeScript: async () => [{ frameId: 0, result: [] }] },
    permissions: { contains: async ({ origins }) => !origins.some(origin => origin.includes('extra.example')) },
    offscreen: { createDocument: async () => {} },
    downloads: { download: async input => { downloads.push(input); return downloads.length; }, search: async ({ id }) => [{ id, state: 'complete' }], onChanged: { addListener: fn => { downloadListener = fn; } } },
    action: { onClicked: { addListener: () => {} } }
  };
  vm.runInNewContext(code, { chrome, console, URL, crypto: webcrypto }, { filename: 'background.js' });
  const gallery = { id: 'fixture', url: 'chrome-extension://fixture/gallery.html?collection=x' };
  const hidden = { id: 'fixture', url: 'chrome-extension://fixture/offscreen.html' };
  const content = { id: 'fixture', frameId: 0, tab: { id: 1, url: 'https://item.taobao.com/item.htm?id=123', title: '测试商品' } };
  const send = (message, sender = gallery) => new Promise(resolve => messageListener(message, sender, resolve));
  return { chrome, tabs, downloads, remote, saved, send, gallery, hidden, content, change: event => downloadListener(event), startup: () => startupListener() };
}
async function collection(h, images = [{ url: 'https://img.alicdn.com/photo.jpg' }, { url: 'https://img.alicdn.com/photo.webp' }]) {
  const created = await h.send({ type: 'CREATE_COLLECTION', images, source: { title: '测试商品' } }, h.content);
  assert.equal(created.ok, true); return created;
}

test('拒绝第三方调用和非平台页面；URL 去重并排除无效协议', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'GET_COLLECTION' }, { id: 'other' })).ok, false);
  assert.equal((await h.send({ type: 'CREATE_COLLECTION', images: [] }, { ...h.content, tab: { url: 'https://example.com/' } })).ok, false);
  const result = await collection(h, [{ url: 'https://img.alicdn.com/a.jpg' }, { url: 'https://img.alicdn.com/a.jpg' }, { url: 'javascript:alert(1)' }, { url: 'file:///secret' }]);
  assert.equal(result.count, 1); assert.equal(h.tabs.length, 1);
  const data = await h.send({ type: 'GET_COLLECTION', collectionId: result.id });
  assert.equal(data.collection.images[0].id, '1');
});

test('额外图片域名先报告待授权，不能由内容脚本调用预览', async () => {
  const h = harness(), result = await collection(h, [{ url: 'https://extra.example/a.jpg' }]);
  const preview = await h.send({ type: 'PREVIEW', collectionId: result.id, imageId: '1' });
  assert.equal(preview.error, 'PERMISSION_REQUIRED'); assert.equal(preview.origin, 'https://extra.example');
  assert.equal((await h.send({ type: 'PREVIEW', collectionId: result.id, imageId: '1' }, h.content)).ok, false);
});

test('编号补零、原图任务、后台 PNG 下载；重复请求不建立重复队列', async () => {
  const h = harness(), result = await collection(h);
  const first = await h.send({ type: 'START_DOWNLOAD', collectionId: result.id, imageIds: ['1', '2'] });
  const repeated = await h.send({ type: 'START_DOWNLOAD', collectionId: result.id, imageIds: ['1'] });
  assert.equal(first.job.id, repeated.job.id);
  assert.equal(first.job.items[0].filename, '商品图_001.png'); assert.equal(first.job.items[1].filename, '商品图_002.png');
  const queue = { type: 'QUEUE_PNG', jobId: first.job.id, index: 0, blobUrl: 'blob:chrome-extension://fixture/abc', width: 300, height: 200 };
  assert.equal((await h.send(queue, h.content)).ok, false);
  assert.equal((await h.send({ ...queue, blobUrl: 'blob:https://evil.example/x' }, h.hidden)).ok, false);
  assert.equal((await h.send(queue, h.hidden)).ok, true);
  assert.equal((await h.send(queue, h.hidden)).ok, true);
  assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].saveAs, false); assert.equal(h.downloads[0].conflictAction, 'uniquify');
  let snapshot = await h.send({ type: 'GET_JOB', jobId: first.job.id });
  assert.equal(snapshot.job.items[0].status, 'downloading'); assert.equal(snapshot.job.status, 'running');
});

test('下载任务不重复保存原图 URL，并且不同会话不能同时启动下载', async () => {
  const h = harness(), first = await collection(h);
  const { job } = await h.send({ type: 'START_DOWNLOAD', collectionId: first.id, imageIds: ['1'] });
  assert.equal(Object.hasOwn(job.items[0], 'url'), false);
  const stored = (await h.send({ type: 'GET_JOB', jobId: job.id })).job;
  assert.equal(Object.hasOwn(stored.items[0], 'url'), false);
  const second = await collection(h);
  const competing = await h.send({ type: 'START_DOWNLOAD', collectionId: second.id, imageIds: ['1'] });
  assert.match(competing.error, /仍在下载/);
});

test('并发完成/中断不会覆盖状态；只有真实下载完成才计为成功', async () => {
  const h = harness(), result = await collection(h);
  const { job } = await h.send({ type: 'START_DOWNLOAD', collectionId: result.id, imageIds: ['1', '2'] });
  for (let index = 0; index < 2; index++) await h.send({ type: 'QUEUE_PNG', jobId: job.id, index, blobUrl: `blob:chrome-extension://fixture/${index}` }, h.hidden);
  h.change({ id: 1, state: { current: 'complete' } }); h.change({ id: 2, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  await delay(20);
  const current = (await h.send({ type: 'GET_JOB', jobId: job.id })).job;
  assert.equal(current.status, 'finished'); assert.equal(current.items[0].status, 'complete'); assert.equal(current.items[1].status, 'error'); assert.equal(current.items[1].error, 'NETWORK_FAILED');
  assert.equal(h.remote.filter(message => message.type === 'REVOKE_BLOB').length, 2);
  const retry = await h.send({ type: 'START_DOWNLOAD', collectionId: result.id, imageIds: ['2'] });
  assert.notEqual(retry.job.id, job.id); assert.equal(retry.job.items.length, 1);
});

test('worker 重建后恢复转换项，查询已完成下载，不重复下载', async () => {
  const h = harness(), result = await collection(h);
  const { job } = await h.send({ type: 'START_DOWNLOAD', collectionId: result.id, imageIds: ['1', '2'] });
  await h.send({ type: 'QUEUE_PNG', jobId: job.id, index: 0, blobUrl: 'blob:chrome-extension://fixture/a' }, h.hidden);
  await h.send({ type: 'ITEM_CONVERTING', jobId: job.id, index: 1 }, h.hidden);
  const restarted = harness(h.saved);
  const restore = await restarted.send({ type: 'RESTORE_JOBS', collectionId: result.id });
  assert.equal(restore.jobs[0].items[0].status, 'complete'); assert.equal(restore.jobs[0].items[1].status, 'pending'); assert.equal(restarted.downloads.length, 0);
  const resumed = restarted.remote.find(message => message.type === 'RUN_JOB');
  assert.equal(resumed.job.items[1].url, 'https://img.alicdn.com/photo.webp');
});

test('保留最近两个会话，空选择和过期会话给出明确错误', async () => {
  const h = harness(); let old;
  for (let n = 0; n < 8; n++) { const result = await collection(h); old ||= result.id; await delay(2); }
  const current = await h.send({ type: 'GET_COLLECTION' });
  assert.equal((await h.send({ type: 'GET_COLLECTION', collectionId: old })).collection, null);
  assert.equal((await h.send({ type: 'START_DOWNLOAD', collectionId: current.collection.id, imageIds: [] })).ok, false);
  assert.equal((await h.send({ type: 'START_DOWNLOAD', collectionId: old, imageIds: ['1'] })).ok, false);
});
