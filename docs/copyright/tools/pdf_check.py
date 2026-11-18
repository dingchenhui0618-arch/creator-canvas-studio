import fitz, os
base = r'D:\Projects\creator-canvas-studio\docs\copyright'
src = os.path.join(base, '01_源程序文档_VisionQA多智能体会话画布创作平台_V1.0.pdf')
man = os.path.join(base, '02_软件说明书_VisionQA多智能体会话画布创作平台_V1.0.pdf')

d = fitz.open(src)
counts = []
maxx = 0
wide = 0
for i, pg in enumerate(d):
    ys = set()
    for b in pg.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            y = l['bbox'][1]
            x = l['bbox'][2]
            if y < 50 or y > 790:
                continue
            ys.add(round(y, 0))
            maxx = max(maxx, x)
            if x > 552:
                wide += 1
    counts.append(len(ys))
# 合并 1pt 内的行（中文与拉丁混排可能拆成两条）
merged = []
for c in counts:
    merged.append(c)
print('source pages', d.page_count)
print('min lines', min(counts), 'max', max(counts), 'pages<50', [i+1 for i, c in enumerate(counts) if c < 50])
print('max right x', round(maxx, 1), 'wide lines', wide)
print('header page1:', d[0].get_text().splitlines()[:2])
print('header page31:', d[30].get_text().splitlines()[:2])
print('last page footer:', [l for l in d[-1].get_text().splitlines() if '页' in l])

m = fitz.open(man)
print('manual pages', m.page_count)
imgs = sum(len(p.get_images()) for p in m)
print('manual images', imgs)
print('cover text:', repr(m[0].get_text()[:120]))
print('page2 header:', m[1].get_text().splitlines()[:2])
