# -*- coding: utf-8 -*-
import os, json, csv, io
ROOT = r'D:\Projects\creator-canvas-studio'
OUT = os.path.join(ROOT, 'docs', 'copyright')
EXCLUDE_DIRS = {'node_modules','dist','build','release-desktop','data','.git','.github','.tmp-canvas','.tmp-drill','.tmp-ident','.tmp-ops','.tmp-qa','.tmp-smtp'}
CODE_EXT = {'.ts', '.tsx', '.mjs', '.js', '.cjs'}
TOPS = ['src', 'server', 'electron', 'worker']

def is_test(rel):
    p = rel.replace(os.sep, '/')
    return p.startswith('test/') or '.test.' in p

def walk(base):
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in CODE_EXT:
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace(os.sep, '/')
                if not is_test(rel):
                    out.append(rel)
    return out

files = []
for top in TOPS:
    files += walk(os.path.join(ROOT, top))
files = sorted(set(files))

def lines_of(rel):
    with io.open(os.path.join(ROOT, rel.replace('/', os.sep)), 'r', encoding='utf-8', errors='replace') as f:
        return f.read().splitlines()

stats = []
for rel in files:
    ls = lines_of(rel)
    stats.append([rel, len(ls), sum(1 for l in ls if l.strip())])
total = sum(s[1] for s in stats)
nonblank = sum(s[2] for s in stats)
print('files', len(stats), 'lines', total, 'non-blank', nonblank)
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'code-stats.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['file', 'lines', 'non_blank_lines'])
    for s in stats:
        w.writerow(s)
json.dump({'files': len(stats), 'lines': total, 'non_blank': nonblank, 'items': stats},
          open(os.path.join(OUT, 'code-stats.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
areas = {}
for s in stats:
    parts = s[0].split('/')
    key = '/'.join(parts[:2]) if len(parts) > 2 else parts[0]
    a = areas.setdefault(key, [0, 0])
    a[0] += 1; a[1] += s[1]
for k, v in sorted(areas.items(), key=lambda kv: -kv[1][1]):
    print(k, v[0], v[1])
