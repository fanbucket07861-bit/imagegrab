# 图提取 / ImageGrab

Chrome Manifest V3 电商商品图片提取插件，以及纯静态宣传官网。无需构建、无需后端。

## 文件结构与实现思路

```text
manifest.json                 MV3 配置、平台与常用图片 CDN 权限
content.js / content.css      详情页识别、浮动按钮、懒加载扫描和 URL 去重
background.js                 会话存储、消息转发、下载队列与真实下载结果
offscreen.html / offscreen.js 后台读取图片、尺寸核验、Canvas 转 PNG、Blob 管理
gallery.html / .js / .css      图片库、选择工具、尺寸显示、授权与下载进度
docs/
  index.html                  产品介绍、六项功能、四步安装、下载入口
  css/style.css               响应式样式与设计变量
  js/main.js                  菜单、滚动高亮、进入动画、复制及交互示意
  assets/                     本地 SVG 素材与可下载的插件 ZIP
tools/                        预览与打包工具
tests/                        后台自动测试、浏览器测试页面和验证报告
```

内容脚本读取当前 DOM 的图片地址，通过 `runtime.sendMessage` 建立独立会话，并打开扩展图片库。后台会补充扫描已有权限的子框架。图片库请求隐藏文档读取真实图片，生成小预览并过滤尺寸。批量下载时，隐藏文档重新读取原图，以 `createImageBitmap + OffscreenCanvas` 保持原始尺寸转换为 PNG，Service Worker 使用 `chrome.downloads.download` 保存。Blob 在下载实际完成或中断后才回收；关闭图片库不影响已经启动的任务。

## 安装与使用

1. 下载官网的 `ImageGrab-v1.0.0.zip` 并解压，或直接使用项目根目录。
2. Chrome 地址栏输入 `chrome://extensions`，打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹。要求 Chrome 116 或更高版本。
4. 刷新已经打开的商品详情页，在右下角点击「获取图片」。也可点击扩展工具栏按钮扫描当前商品页。
5. 等待图片库核验图片，使用全选、反选或单独勾选，点击「下载选中」。默认文件名为 `商品图_001.png`、`商品图_002.png`……。

文件保存到浏览器配置的下载目录，存在重名时 Chrome 自动添加后缀。若 Chrome 设置了「下载前询问每个文件的保存位置」，浏览器可能仍显示保存对话框。进度条按实际保存成功或失败计数，失败项可重新选择后下载。浏览器自己的多文件下载提示需要按需允许。

浮动按钮可通过左侧手柄拖动，右侧 × 可隐藏至下次切换商品页。扫描会有限度地滚动页面加载懒加载图片；滚轮、触屏、Esc 或再次点击按钮可提前结束自动滚动，当前已收集的图片仍会打开。

## 平台识别与提取范围

- 淘宝 / 天猫：常见 `item.htm?id=...`、`/item/商品ID` 详情页。
- 京东：`item.jd.com/商品ID.html`、移动版 `/product/商品ID.html`、`ware/view.action?wareId=...`。
- 拼多多（含商家版）：`goods.html`、`goods_detail`、`goods/goods_detail`、`goods/detail` 等详情路由，支持 hash 路由。

首页、搜索、列表页不显示按钮；SPA 切换地址后会自动重新判断。`src`、`currentSrc`、`srcset`、picture/source、常见 `data-*` 懒加载属性、CSS 背景图、开放 Shadow DOM 和可访问 iframe 均会扫描。普通相对路径与 `//` 协议相对路径会补全；相同绝对 URL 去重，保留查询参数以免破坏签名和尺寸链接。

默认要求宽高都不小于 100 像素，按 URL 和页面区域排除常见 Logo、头像、导航及推荐区。这是启发式过滤，画廊仍提供人工勾选。不同尺寸或不同查询参数的同一图片可能保留为多个候选。需要页面后续接口才创建的内容，需先展开相应详情或加载完整，再重新提取；扫描不会访问平台私有接口。

每次最多收集 800 个 URL，自动滚动最多 12 秒 / 42000 像素；原图最大 35 MB / 4800 万像素，超出时显示原因。保持最近 2 次提取会话与最近 5 个已完成下载任务；本地下载任务引用会话中的图片地址，避免多份保存图片链接。后台同一时间处理一组批量下载，以控制内存用量。数据仅保存在本机。登录验证、反盗链、跨域 iframe 权限、平台改版或失效地址可能阻止读取，插件会显示失败原因，不宣称能绕过平台限制。页面内的 `blob:`、`data:` 临时图片不作为可下载远程原图。

## 权限与跨域

- `activeTab`、`scripting`：工具栏触发和有权限的子框架提取。
- `downloads`：保存 PNG 并读取下载完成 / 中断事件。
- `storage`：本机图片会话和下载进度，支持刷新后恢复查看。
- `offscreen`：后台 Canvas 转码与 Blob URL 生命周期管理。
- 固定站点权限仅覆盖指定平台与常见图片 CDN（alicdn、360buyimg、pddpic 等）。遇到额外图片域名，图片库提供显式授权按钮，按需申请该来源；`optional_host_permissions` 不会在安装时授予所有网站权限。

图片请求省略凭据并使用 `no-referrer`。扩展不会上传图片到额外服务器，不使用统计、CDN 脚本或外部字体。

## 官网预览与修改

直接双击 `docs/index.html` 即可浏览，也可运行 `node tools/serve.cjs`，打开 <http://127.0.0.1:4173/docs/index.html>。

- 主色：修改 `docs/css/style.css` 顶部的 `--primary`、`--primary-hover`、`--primary-light`。
- 文案与导航：修改 `docs/index.html` 对应的语义区块。
- 图片：替换 `docs/assets/product-*.svg`；首屏明确标为商品示意图。
- GitHub：将页脚的占位地址 `https://github.com/` 改为实际项目仓库地址，并去掉「仓库待配置」。
- 重新生成官网 ZIP：运行 `python tools/package_extension.py`。压缩包仅含扩展运行所需文件与使用说明，不包含官网、测试和浏览器配置。

官网为移动优先适配，断点为 768px、1024px；支持 320px 窄屏、键盘操作、减少动态效果设置，所有图片及脚本本地加载。首屏示意支持全选、反选、逐张选择和所选预览；实际 PNG 下载需安装扩展。

## 开发验证

```sh
node tests/background.test.cjs
node tools/serve.cjs
# 打开 http://127.0.0.1:4173/tests/browser.html 查看浏览器用例结果
node tests/probe-browser.cjs
python tools/package_extension.py
```

Chrome 官网与断点自动化使用 Playwright；如环境未将 Playwright 加入 Node 搜索路径，设置 `NODE_PATH` 为你安装的 Playwright `node_modules` 路径后再运行。自动测试和真实平台验收的范围见 `tests/验证报告.md`。真实平台需要在用户已登录的 Chrome 中按报告清单复测。
