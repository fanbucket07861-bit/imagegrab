/* 画廊只保存用户选择与预览；下载任务交给后台，离开页面后仍可继续。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { collection: null, images: new Map(), selected: new Set(), failures: new Map(), permissions: new Set(), checked: 0, small: 0, total: 0, busy: false, validating: false, job: null };
  const send = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '扩展暂时无法响应');
    return response;
  };
  function notice(text, error = false) {
    $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error);
  }
  function updateSelection() {
    const count = state.selected.size, total = state.images.size;
    $('selected-count').textContent = count;
    $('image-count').textContent = total;
    $('select-all').checked = total > 0 && count === total;
    $('select-all').indeterminate = count > 0 && count < total;
    $('download').disabled = !count || state.busy;
    for (const [id, image] of state.images) {
      image.card.classList.toggle('selected', state.selected.has(id));
      image.card.querySelector('input').checked = state.selected.has(id);
    }
  }
  function validationStatus() {
    $('validation-status').textContent = state.validating ? `核验图片 ${state.checked} / ${state.total}` : `已过滤 ${state.small} 张小图`;
    $('empty').hidden = state.images.size > 0 || state.validating;
    if (!state.validating && !state.images.size && state.collection?.images.length) $('empty-message').textContent = '未找到可读取且不小于 100 × 100 的图片。请查看下方失败原因、授权额外域名，或在商品详情充分加载后重新提取。';
    $('permission-panel').hidden = state.permissions.size === 0;
    renderFailures();
  }
  function renderFailures() {
    $('failures-panel').hidden = !state.failures.size;
    $('failures-summary').textContent = `${state.failures.size} 张图片无法读取 · 查看原因`;
    const list = document.createDocumentFragment();
    for (const { image, error } of state.failures.values()) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = image.url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = `图片 ${image.id} ↗`;
      item.append(link, document.createTextNode(error)); list.append(item);
    }
    $('failures-list').replaceChildren(list);
  }

  function addCard(image, preview) {
    if (state.images.has(image.id)) return;
    const card = document.createElement('article'); card.className = 'image-card selected';
    const label = document.createElement('label'); label.className = 'image-check';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.setAttribute('aria-label', `选择图片 ${image.id}`);
    label.append(check);
    const area = document.createElement('button'); area.className = 'image-area'; area.setAttribute('aria-label', `预览图片 ${image.id}`);
    const img = document.createElement('img'); img.src = preview.data; img.alt = image.alt || `商品图片 ${image.id}`; img.loading = 'lazy'; img.decoding = 'async';
    area.append(img);
    const meta = document.createElement('div'); meta.className = 'image-meta';
    const index = document.createElement('strong'); index.className = 'image-index'; index.textContent = `图 ${String(image.id).padStart(3, '0')}`;
    const dimensions = document.createElement('span'); dimensions.textContent = `${preview.width} × ${preview.height}`;
    meta.append(index, dimensions); card.append(label, area, meta);
    // 异步预览可以先完成后面的图片；按提取序号插入，保持编号顺序稳定。
    const next = [...$('gallery').children].find(node => Number(node.dataset.id) > Number(image.id));
    card.dataset.id = image.id; $('gallery').insertBefore(card, next || null);
    state.images.set(image.id, { ...image, ...preview, card }); state.selected.add(image.id);
    check.addEventListener('change', () => { check.checked ? state.selected.add(image.id) : state.selected.delete(image.id); updateSelection(); });
    area.addEventListener('click', () => {
      $('lightbox-image').src = preview.data;
      $('lightbox-image').alt = image.alt || `商品图片 ${image.id}`;
      $('lightbox-caption').textContent = `图片 ${image.id} · 原图 ${preview.width} × ${preview.height} · 此处为缩略预览`;
      $('original-link').href = image.url; $('lightbox').showModal();
    });
    updateSelection();
  }

  async function validateImages(images) {
    if (state.validating) return;
    state.validating = true; state.checked = 0; state.total = images.length;
    $('retry-preview').disabled = true; $('grant-permission').disabled = true;
    validationStatus();
    let cursor = 0;
    const worker = async () => {
      while (cursor < images.length) {
        const image = images[cursor++];
        try {
          const preview = await chrome.runtime.sendMessage({ type: 'PREVIEW', collectionId: state.collection.id, imageId: image.id });
          if (preview?.ok) { state.failures.delete(image.id); addCard(image, preview); }
          else if (preview?.error === 'SMALL_IMAGE') { state.small++; state.failures.delete(image.id); }
          else {
            if (preview?.error === 'PERMISSION_REQUIRED') state.permissions.add(`${preview.origin}/*`);
            state.failures.set(image.id, { image, error: preview?.error === 'PERMISSION_REQUIRED' ? `需要授权图片域名 ${preview.origin}` : preview?.error || '读取失败' });
          }
        } catch (error) { state.failures.set(image.id, { image, error: error.message }); }
        state.checked++; validationStatus();
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(4, images.length) }, worker)); }
    finally { state.validating = false; $('retry-preview').disabled = false; $('grant-permission').disabled = false; validationStatus(); }
  }

  function renderJob(job) {
    if (!job) return;
    state.job = job; state.busy = job.status === 'running';
    const complete = job.items.filter(item => item.status === 'complete').length;
    const failed = job.items.filter(item => item.status === 'error').length;
    const downloading = job.items.filter(item => item.status === 'downloading').length;
    $('progress-panel').hidden = false;
    $('download-progress').max = job.items.length; $('download-progress').value = complete + failed;
    $('progress-title').textContent = state.busy ? '正在处理你的图片' : failed ? '下载结束，部分图片需要重试' : '全部下载完成';
    $('progress-text').textContent = `${complete + failed} / ${job.items.length}`;
    $('progress-detail').textContent = state.busy ? `已保存 ${complete} 张 · 下载中 ${downloading} 张 · 失败 ${failed} 张。转换在后台继续，可关闭此页面。` : `成功保存 ${complete} 张 PNG，失败 ${failed} 张。${failed ? '可重新选择失败图片后再次下载。' : '文件已保存至浏览器设置的下载目录。'}`;
    $('retry-download').hidden = state.busy || failed === 0;
    if (!state.busy && failed) {
      const reasons = [...new Set(job.items.filter(item => item.status === 'error').map(item => item.error))];
      notice(`部分下载失败：${reasons.join('；')}`, true);
    }
    updateSelection();
  }

  $('select-all').addEventListener('change', event => { state.selected = event.target.checked ? new Set(state.images.keys()) : new Set(); updateSelection(); });
  $('invert').addEventListener('click', () => { state.selected = new Set([...state.images.keys()].filter(id => !state.selected.has(id))); updateSelection(); });
  $('download').addEventListener('click', async () => {
    if (state.busy || !state.selected.size) return;
    state.busy = true; updateSelection(); notice('');
    try { const { job } = await send({ type: 'START_DOWNLOAD', collectionId: state.collection.id, imageIds: [...state.selected] }); renderJob(job); }
    catch (error) { state.busy = false; updateSelection(); notice(error.message, true); }
  });
  $('retry-download').addEventListener('click', () => {
    state.selected = new Set(state.job.items.filter(item => item.status === 'error' && state.images.has(item.imageId)).map(item => item.imageId));
    updateSelection(); notice('已选中可重试的失败图片，点击「下载选中」继续。');
  });
  $('retry-preview').addEventListener('click', () => validateImages([...state.failures.values()].map(item => item.image)));
  $('grant-permission').addEventListener('click', async () => {
    // permissions.request 必须直接由用户点击触发，仅申请实际遇到的图片域名。
    const origins = [...state.permissions];
    if (!origins.length) return;
    try {
      const granted = await chrome.permissions.request({ origins });
      if (granted) { state.permissions.clear(); notice('图片域名已授权，正在重新核验。'); await validateImages([...state.failures.values()].map(item => item.image)); }
      else notice('尚未授权，可继续下载已显示的图片。');
    } catch (error) { notice(`授权失败：${error.message}`, true); }
  });
  $('close-lightbox').addEventListener('click', () => $('lightbox').close());
  $('lightbox').addEventListener('click', event => { if (event.target === $('lightbox')) { const rect = $('lightbox').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('lightbox').close(); } });

  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes['imagegrab-state-v1']?.newValue;
    if (area !== 'local' || !next || !state.collection) return;
    const latest = Object.values(next.jobs).filter(job => job.collectionId === state.collection.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) renderJob(latest);
  });

  async function init() {
    try {
      const requested = new URLSearchParams(location.search).get('collection');
      const { collection } = await send({ type: 'GET_COLLECTION', collectionId: requested });
      state.collection = collection;
      if (!collection) { $('empty').hidden = false; if (requested) notice('此图片会话已过期，请回到商品页重新提取。'); return; }
      document.title = `${collection.title} · 图提取`;
      $('source-title').textContent = collection.title;
      if (collection.sourceUrl) { $('source-link').href = collection.sourceUrl; $('source-link').hidden = false; }
      notice(`已收集 ${collection.images.length} 个候选地址。正在读取原图尺寸，排除小图与无效图片。`);
      const restored = await send({ type: 'RESTORE_JOBS', collectionId: collection.id });
      if (restored.jobs[0]) renderJob(restored.jobs[0]);
      await validateImages(collection.images);
      if (!state.job || state.job.status === 'running' || !state.job.items.some(item => item.status === 'error')) notice(`核验完成：${state.images.size} 张可用图片，过滤 ${state.small} 张小图${state.failures.size ? `，${state.failures.size} 张待处理` : ''}。`);
    } catch (error) { notice(error.message, true); $('empty').hidden = false; }
  }
  init();
})();
