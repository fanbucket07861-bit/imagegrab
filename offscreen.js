/* 隐藏文档拥有完整 Blob API。关闭画廊不会撤销正在下载的 Blob URL。 */
(() => {
  'use strict';
  const MIN_SIZE = 100;
  const MAX_BYTES = 35 * 1024 * 1024;
  const MAX_PIXELS = 48_000_000;
  const runningJobs = new Set();
  const blobUrls = new Set();

  async function loadImage(url) {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(22000) });
    if (!response.ok) throw new Error(`图片服务器返回 HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('单张图片超过 35 MB');
    // 流式读取，阻止缺少 Content-Length 的超大响应耗尽内存。
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('单张图片超过 35 MB'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
    const bitmap = await createImageBitmap(blob).catch(() => { throw new Error('图片无法解码，可能需要登录或源链接已失效'); });
    if (bitmap.width * bitmap.height > MAX_PIXELS || bitmap.width > 32767 || bitmap.height > 32767) { bitmap.close(); throw new Error('图片尺寸过大，请使用原图链接单独保存'); }
    if (bitmap.width < MIN_SIZE || bitmap.height < MIN_SIZE) { bitmap.close(); throw new Error('SMALL_IMAGE'); }
    return bitmap;
  }

  async function render(url, thumbnail = false) {
    const bitmap = await loadImage(url);
    try {
      const { width, height } = bitmap;
      const ratio = thumbnail ? Math.min(1, 480 / width, 360 / height) : 1;
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建图片转换画布');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (thumbnail) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        return { data, width, height };
      }
      const blobUrl = URL.createObjectURL(blob);
      blobUrls.add(blobUrl);
      return { blobUrl, width, height };
    } finally { bitmap.close(); }
  }

  async function runJob(job) {
    if (runningJobs.has(job.id)) return;
    runningJobs.add(job.id);
    let cursor = 0;
    const pending = job.items.filter(item => item.status === 'pending');
    // 两路转码限制峰值内存；真正的下载完成由 downloads.onChanged 确认。
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        let result;
        try {
          await chrome.runtime.sendMessage({ type: 'ITEM_CONVERTING', jobId: job.id, index: item.index });
          result = await render(item.url);
          const reply = await chrome.runtime.sendMessage({ type: 'QUEUE_PNG', jobId: job.id, index: item.index, ...result });
          if (!reply?.ok) throw new Error(reply?.error || '创建下载失败');
        } catch (error) {
          if (result?.blobUrl) { URL.revokeObjectURL(result.blobUrl); blobUrls.delete(result.blobUrl); }
          await chrome.runtime.sendMessage({ type: 'ITEM_FAILED', jobId: job.id, index: item.index, error: error.message === 'SMALL_IMAGE' ? '图片小于 100 × 100，已过滤' : error.message }).catch(() => {});
        }
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally { runningJobs.delete(job.id); }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message.target !== 'offscreen') return;
    if (message.type === 'RENDER_PREVIEW') {
      render(message.url, true).then(value => sendResponse({ ok: true, ...value }), error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'RUN_JOB') { runJob(message.job); sendResponse({ ok: true }); }
    if (message.type === 'REVOKE_BLOB') { URL.revokeObjectURL(message.url); blobUrls.delete(message.url); sendResponse({ ok: true }); }
    if (message.type === 'PING') sendResponse({ ok: true, running: [...runningJobs] });
  });
})();
