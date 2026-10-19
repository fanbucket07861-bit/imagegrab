/* 原生 JS：菜单、滚动进入、导航高亮、复制地址及图片库演示。 */
(() => {
  'use strict';
  const header = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-toggle');
  const links = document.querySelector('.nav-links');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const toast = document.getElementById('toast');
  let toastTimer;
  function notify(message) {
    clearTimeout(toastTimer); toast.textContent = message; toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
  }
  function closeMenu() { links.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', '打开导航菜单'); }
  menu.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; links.classList.toggle('open', open); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单'); });
  links.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('click', event => { if (!header.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
  window.matchMedia('(min-width: 768px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  // 使用 scroll + requestAnimationFrame 高亮当前区块，避免每个滚动事件重复读取布局。
  const sectionLinks = [...links.querySelectorAll('a[href^="#"]')];
  const sections = sectionLinks.map(link => ({ link, section: document.querySelector(link.hash) })).filter(item => item.section);
  let scheduled = false;
  function updateScroll() {
    header.classList.toggle('scrolled', window.scrollY > 10);
    let current = null;
    for (const item of sections) if (item.section.getBoundingClientRect().top <= 160) current = item;
    for (const item of sections) {
      item.link.classList.toggle('active', item === current);
      if (item === current) item.link.setAttribute('aria-current', 'location'); else item.link.removeAttribute('aria-current');
    }
    scheduled = false;
  }
  window.addEventListener('scroll', () => { if (!scheduled) { requestAnimationFrame(updateScroll); scheduled = true; } }, { passive: true });
  updateScroll();
  // 不隐藏初始 HTML；只有支持观察器且 JS 已运行时才启用入场动画。
  if ('IntersectionObserver' in window && !reducedMotion) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); }
    }, { threshold: .08 });
    document.querySelectorAll('[data-reveal]').forEach(element => { element.classList.add('reveal-ready'); observer.observe(element); });
  }

  async function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch { /* file:// 等环境采用本地兼容方法。 */ }
    }
    const field = document.createElement('textarea'); field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select();
    const copied = document.execCommand('copy'); field.remove();
    if (!copied) throw new Error('请手动复制：chrome://extensions');
  }
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try { await copy(button.dataset.copy); notify('地址已复制，粘贴到 Chrome 地址栏即可打开。'); }
    catch (error) { notify(error.message); }
  }));

  // 首屏是明确标注的交互示意，不请求电商页面、不模拟真正下载成功。
  const cards = [...document.querySelectorAll('.demo-card')];
  const selected = () => cards.filter(card => card.querySelector('input').checked);
  function updateDemo() { document.getElementById('demo-count').textContent = selected().length; }
  document.getElementById('demo-gallery').addEventListener('change', updateDemo);
  document.getElementById('demo-all').addEventListener('click', () => { const value = selected().length !== cards.length; cards.forEach(card => { card.querySelector('input').checked = value; }); updateDemo(); });
  document.getElementById('demo-invert').addEventListener('click', () => { cards.forEach(card => { const input = card.querySelector('input'); input.checked = !input.checked; }); updateDemo(); });
  document.getElementById('demo-extract').addEventListener('click', () => { cards.forEach(card => { card.querySelector('input').checked = true; }); updateDemo(); notify('已选中 6 张示意图片。点击「预览所选」，体验集中选图。'); });
  const dialog = document.getElementById('demo-dialog');
  document.getElementById('demo-preview').addEventListener('click', () => {
    if (!selected().length) { notify('先选几张喜欢的图片吧。'); return; }
    document.getElementById('demo-selected').replaceChildren(...selected().map(card => { const img = card.querySelector('img').cloneNode(); img.removeAttribute('width'); img.removeAttribute('height'); return img; }));
    dialog.showModal();
  });
  document.getElementById('dialog-close').addEventListener('click', () => dialog.close());
  document.getElementById('dialog-install').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  updateDemo(); document.getElementById('year').textContent = new Date().getFullYear();
})();
