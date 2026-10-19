(async () => {
  'use strict';
  const results = document.getElementById('results');
  let passed = 0, failed = 0;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(test, timeout = 8000) { const start = Date.now(); while (!test()) { if (Date.now() - start > timeout) throw new Error('等待测试状态超时'); await delay(30); } }
  async function test(name, run) {
    const li = document.createElement('li');
    try { await run(); passed++; li.textContent = `PASS · ${name}`; }
    catch (error) { failed++; li.className = 'fail'; li.textContent = `FAIL · ${name}：${error.message}`; console.error(error); }
    results.append(li);
  }
  async function frame(html, visible = false) {
    const node = document.createElement('iframe');
    const ready = new Promise(resolve => node.onload = resolve);
    node.srcdoc = `<base href="${location.origin}/">${html}`;
    document.getElementById(visible ? 'gallery-frame' : 'fixtures').append(node);
    await ready; return node;
  }
  const collector = await frame(`<img src="tests/assets/photo.jpg"><img data-src="/tests/assets/photo.webp"><img srcset="/tests/assets/photo.jpg 1x,/tests/assets/photo.png 2x"><img data-lazy-src="//${location.host}/tests/assets/other.png"><img data-original="tests/assets/photo.jpg"><div style="background-image:url('tests/assets/background.png');width:300px;height:300px"></div><nav><img src="tests/assets/nav.png"></nav><img src="tests/assets/logo.png"><div id="shadow"></div><script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<img data-src="tests/assets/shadow.png">';<\/script><script src="content.js"><\/script>`);
  await test('四个平台详情页显示规则与列表页排除', () => {
    const isPage = collector.contentWindow.__imageGrabIsProductPage;
    for (const url of ['https://item.taobao.com/item.htm?id=123', 'https://detail.tmall.com/item.htm?id=123', 'https://item.jd.com/123.html', 'https://item.m.jd.com/product/123.html', 'https://mms.pinduoduo.com/goods/goods_detail?goods_id=123', 'https://mobile.yangkeduo.com/goods.html?goods_id=123', 'https://mms.pinduoduo.com/#/goods/goods_detail?goods_id=123']) assert(isPage(url), url);
    for (const url of ['https://www.taobao.com/', 'https://s.taobao.com/search?q=test', 'https://www.jd.com/', 'https://mms.pinduoduo.com/goods/goods_list', 'https://mms.pinduoduo.com/goods', 'https://example.com/item.htm?id=123']) assert(!isPage(url), url);
  });
  await test('img、无空格 srcset、懒加载、背景图、相对路径、Shadow DOM 与去重', () => {
    const images = collector.contentWindow.__imageGrabCollect();
    const urls = images.map(image => image.url);
    for (const name of ['photo.jpg', 'photo.webp', 'photo.png', 'other.png', 'background.png', 'shadow.png']) assert(urls.includes(`${location.origin}/tests/assets/${name}`), `缺少 ${name}`);
    assert(urls.length === new Set(urls).size, '未去重');
    assert(!urls.some(url => /logo|nav\.png/.test(url)), '未过滤图标或导航');
  });
  const processor = await frame('<script>window.TEST_ROLE="offscreen";<\/script><script src="tests/browser-mocks.js"><\/script><script src="offscreen.js"><\/script>');
  const request = message => new Promise(resolve => processor.contentWindow.testRuntimeListeners[0]({ ...message, target: 'offscreen' }, { id: 'fixture' }, resolve));
  await test('JPG / WebP 图片真实解码、原始尺寸和 PNG 缩略预览', async () => {
    for (const format of ['jpg', 'webp', 'png']) {
      const result = await request({ type: 'RENDER_PREVIEW', url: `${location.origin}/tests/assets/photo.${format}` });
      assert(result.ok, result.error); assert(result.width === 320 && result.height === 240, '尺寸错误'); assert(result.data.startsWith('data:image/png;base64,'), '未输出 PNG');
    }
  });
  await test('1 × 1 像素与无效图片实际过滤', async () => {
    const small = await request({ type: 'RENDER_PREVIEW', url: `${location.origin}/tests/assets/tiny.png` });
    assert(!small.ok && small.error === 'SMALL_IMAGE', '小图未过滤');
    const broken = await request({ type: 'RENDER_PREVIEW', url: `${location.origin}/tests/assets/broken.jpg` }); assert(!broken.ok && broken.error.includes('解码'), '解码失败未报告');
  });
  await test('批量原图转 PNG、原始尺寸不变、Blob 到完成后才回收', async () => {
    await request({ type: 'RUN_JOB', job: { id: 'conversion', items: ['jpg', 'webp'].map((format, index) => ({ index, url: `${location.origin}/tests/assets/photo.${format}`, status: 'pending' })) } });
    await waitFor(() => processor.contentWindow.testChromeMessages.filter(message => message.type === 'QUEUE_PNG').length === 2);
    const messages = processor.contentWindow.testChromeMessages.filter(message => message.type === 'QUEUE_PNG');
    for (const message of messages) {
      const blob = await (await fetch(message.blobUrl)).blob(); const bytes = new Uint8Array(await blob.arrayBuffer());
      assert(bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10', 'PNG 签名错误');
      const bitmap = await createImageBitmap(blob); assert(bitmap.width === 320 && bitmap.height === 240, '原图被缩放'); bitmap.close();
      await request({ type: 'REVOKE_BLOB', url: message.blobUrl });
    }
  });
  const galleryHtml = await (await fetch('/gallery.html')).text();
  const gallery = await frame(galleryHtml.replace('<script src="gallery.js" defer>', '<script>window.TEST_ROLE="gallery";<\/script><script src="tests/browser-mocks.js"><\/script><script src="gallery.js" defer>'), true);
  const doc = gallery.contentDocument;
  await test('真实画廊核验、尺寸、排除小图和额外域名提示', async () => {
    await waitFor(() => doc.getElementById('validation-status').textContent.includes('已过滤'));
    assert(doc.querySelectorAll('.image-card').length === 2, '有效图片数量错误'); assert(doc.getElementById('selected-count').textContent === '2', '默认选择数量错误');
    assert(doc.getElementById('validation-status').textContent.includes('1'), '未标记小图'); assert(!doc.getElementById('permission-panel').hidden, '缺少授权提示');
  });
  await test('全选、取消全选、反选与下载按钮禁用状态', () => {
    doc.getElementById('select-all').click(); assert(doc.getElementById('selected-count').textContent === '0', '取消全选失败'); assert(doc.getElementById('download').disabled, '未禁用空选择');
    doc.getElementById('invert').click(); assert(doc.getElementById('selected-count').textContent === '2', '反选失败'); assert(!doc.getElementById('download').disabled, '按钮未启用');
  });
  await test('图片预览弹窗与关闭', () => {
    doc.querySelector('.image-area').click(); assert(doc.getElementById('lightbox').open, '弹窗未打开'); doc.getElementById('close-lightbox').click(); assert(!doc.getElementById('lightbox').open, '弹窗未关闭');
  });
  await test('下载完成/失败反馈以及失败图片重选', async () => {
    doc.getElementById('download').click();
    await waitFor(() => doc.getElementById('progress-title').textContent.includes('下载结束'));
    assert(doc.getElementById('download-progress').value === 2, '进度计数错误'); assert(!doc.getElementById('retry-download').hidden, '缺少失败重试');
    doc.getElementById('retry-download').click(); assert(doc.getElementById('selected-count').textContent === '1', '未重新选择失败项');
  });
  document.getElementById('status').textContent = `${passed} 项通过，${failed} 项失败。${failed ? '请修复后重新运行。' : '浏览器测试完成。'}`;
  document.body.dataset.testResult = failed ? 'fail' : 'pass';
})();
