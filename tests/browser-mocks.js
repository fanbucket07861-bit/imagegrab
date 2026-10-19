/* 仅供 tests/browser.html 加载，不属于扩展发行包。 */
(() => {
  const role = window.TEST_ROLE;
  const listeners = [];
  window.testChromeMessages = [];
  window.testRuntimeListeners = listeners;
  if (role === 'offscreen') {
    window.chrome = { runtime: { id: 'fixture', onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async message => { window.testChromeMessages.push(message); return { ok: true }; } } };
    return;
  }
  const storageListeners = [];
  const origin = location.origin === 'null' ? 'http://127.0.0.1:4173' : location.origin;
  const collection = { id: 'fixture', title: '日常好物 · 浏览器验证会话', sourceUrl: 'https://item.taobao.com/item.htm?id=123', images: [
    { id: '1', url: origin + '/tests/assets/photo.jpg', alt: 'JPG 商品测试图' },
    { id: '2', url: origin + '/tests/assets/photo.webp', alt: 'WebP 商品测试图' },
    { id: '3', url: origin + '/tests/assets/tiny.png', alt: '1 像素占位图' },
    { id: '4', url: 'https://extra.example/image.jpg', alt: '额外图片域名' }
  ] };
  let job;
  const publish = () => storageListeners.forEach(fn => fn({ 'imagegrab-state-v1': { newValue: { jobs: { [job.id]: structuredClone(job) } } } }, 'local'));
  window.chrome = {
    permissions: { request: async () => true },
    runtime: { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async message => {
      if (message.type === 'GET_COLLECTION') return { ok: true, collection };
      if (message.type === 'RESTORE_JOBS') return { ok: true, jobs: [] };
      if (message.type === 'PREVIEW') {
        if (message.imageId === '3') return { ok: false, error: 'SMALL_IMAGE' };
        if (message.imageId === '4') return { ok: false, error: 'PERMISSION_REQUIRED', origin: 'https://extra.example' };
        const response = await fetch(origin + '/tests/assets/photo.png');
        const blob = await response.blob();
        const preview = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
        return { ok: true, data: preview, width: 320, height: 240 };
      }
      if (message.type === 'START_DOWNLOAD') {
        job = { id: String(Date.now()), collectionId: collection.id, status: 'running', createdAt: Date.now(), items: message.imageIds.map((imageId, index) => ({ imageId, index, filename: `商品图_${String(index + 1).padStart(3, '0')}.png`, status: 'converting' })) };
        setTimeout(() => { job.items.forEach((item, index) => { item.status = index === 0 ? 'complete' : 'error'; if (index) item.error = '测试下载中断'; }); job.status = 'finished'; publish(); }, 200);
        return { ok: true, job: structuredClone(job) };
      }
      return { ok: true };
    } },
    storage: { onChanged: { addListener: fn => storageListeners.push(fn) } }
  };
})();
