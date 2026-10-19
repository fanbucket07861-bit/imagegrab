"""生成官网可直接下载的扩展 ZIP；白名单防止打入测试数据或个人浏览器配置。"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

ROOT = Path(__file__).resolve().parent.parent
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
FILES = ['manifest.json', 'content.js', 'content.css', 'background.js',
         'offscreen.html', 'offscreen.js', 'gallery.html', 'gallery.js', 'gallery.css']
output = ROOT / 'docs' / 'assets' / f'imagegrab-v{version}.zip'
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for name in FILES:
        archive.write(ROOT / name, name)
    archive.writestr('安装说明.txt', '图提取 ImageGrab\n\n1. 解压本压缩包到固定文件夹。\n2. Chrome 打开 chrome://extensions 并启用开发者模式。\n3. 加载已解压的扩展程序，选择本文件夹。\n4. 刷新商品详情页，点击「获取图片」。\n5. 在图片库中勾选并下载 PNG。\n\n要求 Chrome 116+。浏览器下载设置可能提示保存位置。额外图片域名可在图片库中按需授权。\n')
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert set(FILES).issubset(archive.namelist())
    assert json.loads(archive.read('manifest.json'))['manifest_version'] == 3
print(f'OK: {output.name} ({output.stat().st_size:,} bytes, {len(FILES) + 1} files)')
