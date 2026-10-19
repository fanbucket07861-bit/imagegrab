/* MV3 Service Worker：收集会话、权限校验、下载队列和实际下载结果。 */
'use strict';
const STATE_KEY = 'imagegrab-state-v1';
const MAX_IMAGES = 800;
let documentCreation;
let writeQueue = Promise.resolve();
const ownPage = name => chrome.runtime.getURL(name);
const emptyState = () => ({ collections: {}, jobs: {}, lastCollection: null });
const validUrl = raw => {
  try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && raw.length <= 4096 ? url.href : null; }
  catch { return null; }
};
const platformUrl = raw => { try { return /(^|\.)(taobao|tmall|jd|pinduoduo|yangkeduo)\.com$/.test(new URL(raw).hostname); } catch { return false; } };

async function readState() { return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || emptyState(); }
// 串行读写防止两个下载同时完成时覆盖进度。状态保存在 storage，worker 重启后仍可读取。
function transact(change) {
  const result = writeQueue.then(async () => {
    const state = await readState();
    const value = await change(state);
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return value;
  });
  writeQueue = result.catch(() => {});
  return result;
}

async function ensureOffscreen() {
  if (documentCreation) return documentCreation;
  documentCreation = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [ownPage('offscreen.html')] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: '后台读取跨域商品图、转换 PNG，并保持下载 Blob 有效直至下载完成。' });
  })();
  try { await documentCreation; } finally { documentCreation = null; }
}

async function offscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function hasAccess(url) {
  const target = new URL(url);
  return chrome.permissions.contains({ origins: [`${target.protocol}//${target.hostname}/*`] });
}

function finishJob(job) {
  const settled = job.items.every(item => ['complete', 'error'].includes(item.status));
  job.status = settled ? 'finished' : 'running';
  if (settled) job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

async function createCollection(message, sender) {
  if (!sender.tab || sender.frameId !== 0 || !platformUrl(sender.tab.url)) throw new Error('请从支持的平台商品详情页提取图片');
  const unique = new Map();
  for (const candidate of (Array.isArray(message.images) ? message.images : []).slice(0, MAX_IMAGES)) {
    const url = validUrl(candidate?.url);
    if (url) unique.set(url, { url, width: Number(candidate.width) || 0, height: Number(candidate.height) || 0, alt: String(candidate.alt || '').slice(0, 160), kind: candidate.kind === 'background' ? 'background' : 'image' });
  }
  // 提取可访问的跨域子框架；不访问未授权平台/第三方框架。
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: () => globalThis.__imageGrabCollect?.() || [] });
    for (const frame of frames) for (const image of (frame.result || [])) {
      const url = validUrl(image.url);
      if (url && unique.size < MAX_IMAGES && !unique.has(url)) unique.set(url, { ...image, url });
    }
  } catch { /* 部分受保护框架不可注入时，保留主页面扫描结果。 */ }
  const id = crypto.randomUUID();
  const collection = { id, createdAt: Date.now(), title: String(message.source?.title || sender.tab.title || '商品图片').slice(0, 240), sourceUrl: validUrl(sender.tab.url), images: [...unique.values()].map((item, index) => ({ ...item, id: String(index + 1) })) };
  await transact(state => {
    state.collections[id] = collection;
    state.lastCollection = id;
    const older = Object.values(state.collections).sort((a, b) => b.createdAt - a.createdAt).slice(2);
    for (const item of older) {
      const isDownloading = Object.values(state.jobs).some(job => job.collectionId === item.id && job.status === 'running');
      if (!isDownloading) delete state.collections[item.id];
    }
  });
  await chrome.tabs.create({ url: ownPage(`gallery.html?collection=${id}`) });
  return { ok: true, id, count: collection.images.length };
}

async function startJob(message) {
  const job = await transact(state => {
    const collection = state.collections[message.collectionId];
    if (!collection) throw new Error('图片会话已过期，请返回商品页重新提取');
    const existing = Object.values(state.jobs).find(job => job.status === 'running');
    if (existing) {
      if (existing.collectionId === collection.id) return existing;
      throw new Error('另一组图片仍在下载，请等当前任务完成后再继续');
    }
    const selected = new Set((message.imageIds || []).map(String));
    const images = collection.images.filter(image => selected.has(image.id));
    if (!images.length) throw new Error('请先选择图片');
    const id = crypto.randomUUID();
    const job = { id, collectionId: collection.id, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), items: images.map((image, index) => ({ imageId: image.id, index, filename: `商品图_${String(index + 1).padStart(3, '0')}.png`, status: 'pending' })) };
    state.jobs[id] = job;
    const finished = Object.values(state.jobs).filter(item => item.status === 'finished').sort((a, b) => b.createdAt - a.createdAt);
    for (const item of finished.slice(5)) delete state.jobs[item.id];
    return job;
  });
  const collection = (await readState()).collections[job.collectionId];
  const imageUrls = new Map(collection.images.map(image => [image.id, image.url]));
  const reply = await offscreen({ type: 'RUN_JOB', job: { ...job, items: job.items.map(item => ({ ...item, url: imageUrls.get(item.imageId) })) } });
  if (!reply?.ok) throw new Error('无法启动后台图片转换');
  return { ok: true, job };
}

// 画廊重新打开时恢复未执行项；已交给 downloads API 的项目先查询实际状态，避免重复保存。
async function recoverJobs() {
  const { running = [] } = await offscreen({ type: 'PING' }) || {};
  const jobs = await transact(async state => {
    const resume = [];
    for (const job of Object.values(state.jobs).filter(item => item.status === 'running')) {
      if (running.includes(job.id)) continue;
      for (const item of job.items) {
        if (item.downloadId !== undefined && item.status === 'downloading') {
          const [download] = await chrome.downloads.search({ id: item.downloadId });
          if (download?.state === 'complete') item.status = 'complete';
          else if (!download || download.state === 'interrupted') { item.status = 'error'; item.error = download?.error || '下载已中断'; }
        } else if (item.status === 'converting') item.status = 'pending';
      }
      finishJob(job);
      if (job.status === 'running') {
        const collection = state.collections[job.collectionId];
        if (!collection) {
          for (const item of job.items) { item.status = 'error'; item.error = '图片会话已过期，请重新提取'; }
          finishJob(job);
        } else resume.push({ ...job, items: job.items.map(item => ({ ...item, url: collection.images.find(image => image.id === item.imageId)?.url })) });
      }
    }
    return resume;
  });
  for (const job of jobs) await offscreen({ type: 'RUN_JOB', job });
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('无效的扩展来源');
  if (message.type === 'CREATE_COLLECTION') return createCollection(message, sender);
  const fromGallery = sender.url?.startsWith(ownPage('gallery.html'));
  const fromOffscreen = sender.url === ownPage('offscreen.html');
  if (['GET_COLLECTION', 'PREVIEW', 'START_DOWNLOAD', 'GET_JOB', 'RESTORE_JOBS'].includes(message.type) && !fromGallery) throw new Error('仅图片库可执行此操作');
  if (['QUEUE_PNG', 'ITEM_CONVERTING', 'ITEM_FAILED'].includes(message.type) && !fromOffscreen) throw new Error('无效的图片处理来源');
  if (message.type === 'GET_COLLECTION') {
    const state = await readState();
    const collection = state.collections[message.collectionId || state.lastCollection];
    return { ok: true, collection: collection || null };
  }
  if (message.type === 'PREVIEW') {
    const state = await readState();
    const image = state.collections[message.collectionId]?.images.find(image => image.id === message.imageId);
    if (!image) throw new Error('找不到这张图片');
    if (!await hasAccess(image.url)) return { ok: false, error: 'PERMISSION_REQUIRED', origin: new URL(image.url).origin };
    return offscreen({ type: 'RENDER_PREVIEW', url: image.url });
  }
  if (message.type === 'START_DOWNLOAD') return startJob(message);
  if (message.type === 'GET_JOB') return { ok: true, job: (await readState()).jobs[message.jobId] || null };
  if (message.type === 'RESTORE_JOBS') { await recoverJobs(); return { ok: true, jobs: Object.values((await readState()).jobs).filter(job => job.collectionId === message.collectionId).sort((a, b) => b.createdAt - a.createdAt) }; }
  if (message.type === 'ITEM_CONVERTING' || message.type === 'ITEM_FAILED') {
    await transact(state => {
      const job = state.jobs[message.jobId];
      const item = job?.items.find(item => item.index === message.index);
      if (!item || ['complete', 'downloading'].includes(item.status)) return;
      item.status = message.type === 'ITEM_CONVERTING' ? 'converting' : 'error';
      if (item.status === 'error') item.error = String(message.error || '图片处理失败').slice(0, 200);
      finishJob(job);
    });
    return { ok: true };
  }
  if (message.type === 'QUEUE_PNG') {
    if (!String(message.blobUrl).startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error('无效的 PNG 下载地址');
    return transact(async state => {
      const job = state.jobs[message.jobId];
      const item = job?.items.find(item => item.index === message.index);
      if (!item) throw new Error('下载任务不存在');
      if (item.downloadId !== undefined) return { ok: true, downloadId: item.downloadId };
      item.downloadId = await chrome.downloads.download({ url: message.blobUrl, filename: item.filename, conflictAction: 'uniquify', saveAs: false });
      item.blobUrl = message.blobUrl;
      item.status = 'downloading';
      item.width = message.width; item.height = message.height;
      job.updatedAt = Date.now();
      return { ok: true, downloadId: item.downloadId };
    });
  }
  throw new Error('未知操作');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return;
  handle(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
  transact(state => {
    for (const job of Object.values(state.jobs)) {
      const item = job.items.find(item => item.downloadId === delta.id);
      if (!item) continue;
      item.status = delta.state.current === 'complete' ? 'complete' : 'error';
      if (item.status === 'error') item.error = delta.error?.current || '下载中断，请重试';
      const blobUrl = item.blobUrl;
      delete item.blobUrl;
      finishJob(job);
      return blobUrl;
    }
  }).then(url => { if (url) offscreen({ type: 'REVOKE_BLOB', url }).catch(() => {}); }).catch(console.error);
});

chrome.action.onClicked.addListener(async tab => {
  if (platformUrl(tab.url)) {
    try {
      const [{ result: isProduct }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__imageGrabIsProductPage?.() || false });
      if (isProduct) { await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' }, { frameId: 0 }); return; }
    } catch { /* 安装扩展之前已打开的页面需先刷新；仍可通过工具栏打开已有图片库。 */ }
  }
  await chrome.tabs.create({ url: ownPage('gallery.html') });
});

chrome.runtime.onStartup.addListener(() => recoverJobs().catch(console.error));
