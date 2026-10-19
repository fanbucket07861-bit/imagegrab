/* 内容脚本运行在隔离环境：只读图片 DOM，只在商品详情页创建浮动按钮。 */
(() => {
  'use strict';
  if (globalThis.__imageGrabLoaded) return;
  globalThis.__imageGrabLoaded = true;
  const MIN_SIZE = 100;
  const MAX_IMAGES = 800;
  const LAZY_ATTRIBUTES = ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload', 'data-lazyload', 'data-url', 'data-img', 'data-image', 'data-echo', 'data-lazy-img', 'data-original-src'];
  const IGNORE_URL = /(?:^|[/_.-])(?:logo|icon|avatar|sprite|spacer|placeholder|loading|blank|transparent|qrcode|qr-code)(?:[/_.?\d-]|$)/i;
  const EXCLUDED_REGION = 'header,nav,footer,[role="navigation"],[class*="recommend"],[class*="Recommend"],[class*="related-goods"],[class*="shop-logo"],[class*="avatar"],[class*="qrcode"]';
  let scanning = false;
  let stopScroll = false;
  let route = '';
  let dismissed = false;
  let toastTimer;

  function isProductPage(href = location.href) {
    const url = new URL(href);
    const host = url.hostname;
    const hashRoute = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : null;
    const productPaths = [url.pathname, hashRoute?.pathname || ''];
    const hasProductId = url.searchParams.has('goods_id') || Boolean(hashRoute?.searchParams.has('goods_id'));
    if (/(^|\.)(taobao|tmall)\.com$/.test(host)) {
      return /\/(?:item|detail)\.htm[l]?$/i.test(url.pathname) && url.searchParams.has('id') || productPaths.some(path => /\/item\/\d+(?:\.htm[l]?)?\/?$/i.test(path));
    }
    if (/(^|\.)jd\.com$/.test(host)) {
      return /(?:^|\.)item\.jd\.com$/.test(host) && /^\/\d+\.html$/i.test(url.pathname) || productPaths.some(path => /\/(?:product|ware|item)\/\d+(?:\.html)?\/?$/i.test(path)) || /\/ware\/view\.action$/i.test(url.pathname) && url.searchParams.has('wareId');
    }
    if (/(^|\.)(pinduoduo|yangkeduo)\.com$/.test(host)) {
      return productPaths.some(path => /\/goods\.html?$/i.test(path) && hasProductId || /\/(?:goods_detail|goodsDetail|goods-detail|goods\/detail|goods\/goods_detail)(?:\.html?)?\/?$/i.test(path));
    }
    return false;
  }

  function normalizeUrl(raw, base) {
    if (!raw || typeof raw !== 'string') return null;
    raw = raw.trim().replace(/&amp;/g, '&');
    // 页面 Blob 无法被扩展重新获取；普通 HTTP(S) 原图可由后台跨域读取。
    try {
      const url = new URL(raw, base);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || IGNORE_URL.test(url.pathname)) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  function srcsetUrls(value) {
    // 按 URL / 描述符分别读取，兼容「a.jpg 1x,b.jpg 2x」以及 URL 中的逗号。
    const input = value || '', urls = [];
    let cursor = 0;
    while (cursor < input.length) {
      while (/[\s,]/.test(input[cursor] || '') && cursor < input.length) cursor++;
      const start = cursor;
      while (cursor < input.length && !/\s/.test(input[cursor])) cursor++;
      const token = input.slice(start, cursor);
      if (!token) break;
      urls.push(token.replace(/,+$/, ''));
      if (token.endsWith(',')) continue;
      // 描述符可相邻于下一个候选地址，例如 `a.jpg 1x,b.jpg 2x`。
      let brackets = 0, ended = false;
      while (cursor < input.length && !ended) {
        const char = input[cursor];
        if (/\s/.test(char)) { cursor++; continue; }
        if (char === '(') brackets++;
        else if (char === ')') brackets--;
        else if (char === ',' && brackets === 0) { cursor++; ended = true; continue; }
        cursor++;
      }
    }
    return urls;
  }

  function collectImages() {
    const found = new Map();
    const seenRoots = new Set();
    function add(raw, element, doc, measured = false, kind = 'image') {
      if (found.size >= MAX_IMAGES || element.closest?.(EXCLUDED_REGION)) return;
      const url = normalizeUrl(raw, doc.baseURI);
      if (!url) return;
      const width = measured ? element.naturalWidth || 0 : 0;
      const height = measured ? element.naturalHeight || 0 : 0;
      if (width && height && (width < MIN_SIZE || height < MIN_SIZE)) return;
      const existing = found.get(url);
      if (!existing || width > existing.width) found.set(url, { url, width, height, kind, alt: (element.alt || '').slice(0, 160) });
    }
    function walk(root, doc) {
      if (seenRoots.has(root)) return;
      seenRoots.add(root);
      const elements = root.querySelectorAll('*');
      for (const element of elements) {
        if (element.id?.startsWith('imagegrab-')) continue;
        if (element.tagName === 'IMG') {
          add(element.currentSrc, element, doc, true);
          for (const attribute of LAZY_ATTRIBUTES) {
            const value = element.getAttribute(attribute);
            add(value, element, doc, value === element.currentSrc);
          }
          for (const attribute of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
            for (const value of srcsetUrls(element.getAttribute(attribute))) add(value, element, doc);
          }
        } else if (element.tagName === 'SOURCE' && element.parentElement?.tagName === 'PICTURE') {
          for (const value of srcsetUrls(element.getAttribute('srcset') || element.getAttribute('data-srcset'))) add(value, element, doc);
        }
        if (element.tagName === 'IFRAME') {
          try { if (element.contentDocument) walk(element.contentDocument, element.contentDocument); } catch { /* 跨域 iframe 由后台在有权限的子框架中扫描。 */ }
        }
        if (element.shadowRoot) walk(element.shadowRoot, doc);
        if (element.closest?.(EXCLUDED_REGION)) continue;
        // getComputedStyle 兼容 class 样式、内联样式及多层 background-image。
        const background = doc.defaultView?.getComputedStyle(element).backgroundImage || '';
        for (const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
          add(match[1] || match[2] || match[3], element, doc, false, 'background');
        }
      }
    }
    walk(document, document);
    return [...found.values()];
  }
  // 允许后台在已有权限的子框架中调用同一个提取器。
  globalThis.__imageGrabCollect = collectImages;
  globalThis.__imageGrabIsProductPage = isProductPage;

  function toast(message) {
    clearTimeout(toastTimer);
    let node = document.getElementById('imagegrab-toast');
    if (!node) { node = document.createElement('div'); node.id = 'imagegrab-toast'; node.setAttribute('role', 'status'); document.documentElement.append(node); }
    node.textContent = message;
    toastTimer = setTimeout(() => node.remove(), 6500);
  }

  async function scan() {
    if (scanning) { stopScroll = true; return; }
    if (!isProductPage()) return;
    scanning = true;
    stopScroll = false;
    const scanRoute = location.href;
    const label = document.querySelector('#imagegrab-float .ig-label');
    if (label) label.textContent = '扫描中 · 停止';
    toast('正在加载详情图片，约需数秒。滚动、按 Esc 或再次点击可结束自动扫描。');
    const found = new Map();
    const merge = () => collectImages().forEach(item => { if (found.size < MAX_IMAGES) found.set(item.url, item); });
    const startX = scrollX, startY = scrollY;
    const interrupt = event => { if (event.type !== 'keydown' || ['Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes(event.key)) stopScroll = true; };
    for (const type of ['wheel', 'touchstart', 'keydown']) addEventListener(type, interrupt, { passive: true });
    try {
      merge();
      // 先覆盖全页懒加载；对无限滚动设上限，避免进入推荐流或长时间阻塞。
      const started = Date.now();
      let y = 0;
      while (!stopScroll && location.href === scanRoute && Date.now() - started < 12000 && y < 42000) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 260));
        merge();
        if (y >= document.documentElement.scrollHeight - innerHeight) break;
        y = Math.min(y + Math.max(innerHeight * .82, 450), document.documentElement.scrollHeight - innerHeight);
      }
      if (location.href !== scanRoute) throw new Error('页面已切换，请在当前商品页重新扫描。');
      merge();
      const response = await chrome.runtime.sendMessage({ type: 'CREATE_COLLECTION', images: [...found.values()], source: { url: location.href, title: document.title } });
      if (!response?.ok) throw new Error(response?.error || '无法打开图片库');
      toast(`已收集 ${response.count} 个图片地址，正在图片库核验尺寸。`);
    } catch (error) {
      toast(error.message.includes('Extension context') ? '扩展已更新，请刷新商品页后重试。' : `提取失败：${error.message}`);
    } finally {
      for (const type of ['wheel', 'touchstart', 'keydown']) removeEventListener(type, interrupt);
      if (!stopScroll && location.href === scanRoute) window.scrollTo({ left: startX, top: startY, behavior: 'instant' });
      scanning = false;
      if (label) label.textContent = '获取图片';
    }
  }

  function mount() {
    if (window.top !== window) return;
    if (route !== location.href) { route = location.href; dismissed = false; }
    const current = document.getElementById('imagegrab-float');
    if (!isProductPage() || dismissed) { current?.remove(); return; }
    if (current) return;
    const root = document.createElement('div');
    root.id = 'imagegrab-float';
    root.innerHTML = '<button class="ig-drag" aria-label="拖动调整按钮位置" title="拖动调整位置">⠿</button><button class="ig-get" title="提取当前商品页图片"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m3 16 5-5 5 5 4-4 4 4"/><circle cx="15.5" cy="7.5" r="1.3"/></svg><span class="ig-label">获取图片</span></button><button class="ig-close" aria-label="隐藏获取图片按钮" title="隐藏至下次打开商品页">×</button>';
    root.querySelector('.ig-get').addEventListener('click', scan);
    root.querySelector('.ig-close').addEventListener('click', () => { dismissed = true; stopScroll = true; root.remove(); });
    const handle = root.querySelector('.ig-drag');
    handle.addEventListener('pointerdown', event => {
      const rect = root.getBoundingClientRect();
      const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      const move = e => {
        root.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, e.clientX - dx))}px`;
        root.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, e.clientY - dy))}px`;
        root.style.right = 'auto'; root.style.bottom = 'auto';
      };
      const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    });
    document.documentElement.append(root);
  }

  if (window.top === window) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'SCAN_PAGE' && isProductPage()) { scan(); sendResponse({ ok: true }); return false; }
    });
    mount();
    addEventListener('popstate', mount); addEventListener('hashchange', mount);
    // SPA 的 pushState 不会触发 popstate；轻量地址检查不会持续遍历 DOM。
    setInterval(mount, 1000);
  }
})();
