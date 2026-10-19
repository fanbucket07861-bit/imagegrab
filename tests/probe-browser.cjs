const { chromium } = require('playwright');
const fs = require('node:fs');
(async () => {
  const chrome = process.env.IMAGEGRAB_CHROME || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox']
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4173/docs/index.html', { waitUntil: 'networkidle' });
    const initial = await page.evaluate(() => ({ title: document.title, width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, images: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length }));
    if (initial.overflow > 0) throw new Error(`桌面端存在 ${initial.overflow}px 横向溢出`);
    await page.getByRole('button', { name: '反选' }).click();
    if (await page.locator('#demo-count').innerText() !== '2') throw new Error('首屏反选操作失败');
    await page.getByRole('button', { name: '预览所选' }).click();
    if (!(await page.locator('#demo-dialog').evaluate(element => element.open))) throw new Error('首屏图片预览弹窗未打开');
    await page.getByRole('button', { name: '关闭预览' }).click();
    for (const viewport of [{ width: 1024, height: 768 }, { width: 375, height: 812 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      const size = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollX, scrollY, menu: { display: getComputedStyle(document.querySelector('.nav-links')).display, className: document.querySelector('.nav-links').className, expanded: document.querySelector('.menu-toggle').getAttribute('aria-expanded') }, offenders: [...document.querySelectorAll('body *')].map(element => ({ tag: element.tagName, className: String(element.className?.baseVal ?? element.className ?? '').slice(0, 45), parent: String(element.parentElement?.className?.baseVal ?? element.parentElement?.className ?? '').slice(0, 60), left: Math.round(element.getBoundingClientRect().left), right: Math.round(element.getBoundingClientRect().right) })).filter(item => item.right > innerWidth + 1 || item.left < -1).sort((a, b) => b.right - a.right).slice(0, 12) }));
      if (size.documentWidth > size.width) throw new Error(`${viewport.width}px 宽度下页面溢出 ${size.documentWidth - size.width}px: ${JSON.stringify(size)}`);
      if (viewport.width < 768) {
        await page.getByRole('button', { name: '打开导航菜单' }).click();
        if (!(await page.getByRole('button', { name: '关闭导航菜单' }).isVisible())) throw new Error(`${viewport.width}px 移动导航未展开`);
        await page.getByRole('link', { name: '核心功能' }).click();
        if (await page.getByRole('button', { name: '打开导航菜单' }).getAttribute('aria-expanded') !== 'false') throw new Error('导航跳转后菜单未关闭');
      }
      console.log(`PASS: Chrome ${viewport.width} × ${viewport.height}, 无横向溢出`);
    }
    // 让实际滚动触发 IntersectionObserver，再截取完整页面与首屏视口。
    await page.evaluate(async () => {
      document.documentElement.style.scrollBehavior = 'auto';
      for (let top = 0; top < document.documentElement.scrollHeight; top += 700) {
        window.scrollTo({ top, behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const hiddenSections = await page.locator('[data-reveal]:not(.revealed)').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, className: String(element.className), height: Math.round(element.getBoundingClientRect().height), top: Math.round(window.scrollY + element.getBoundingClientRect().top) })));
    if (hiddenSections.length) throw new Error(`滚动后仍有 ${hiddenSections.length} 个内容区块未显示：${JSON.stringify(hiddenSections)}`);
    fs.mkdirSync('tests/artifacts/screenshots', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'tests/artifacts/screenshots/chrome-desktop.png' });
    await page.screenshot({ path: 'tests/artifacts/screenshots/chrome-desktop-full.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'tests/artifacts/screenshots/chrome-mobile.png' });
    if (errors.length) throw new Error(`页面报错：${errors.join('; ')}`);
    console.log(`PASS: Google Chrome ${await browser.version()}`);
    console.log(`PASS: ${initial.title}, ${initial.images} 张本地 SVG 正常渲染, 首屏选择/反选/预览均通过`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
