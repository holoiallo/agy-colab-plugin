import json, glob, os, sys
ok = True
for f in sorted(glob.glob('notebooks/*.ipynb')):
    nb = json.load(open(f, encoding='utf-8'))
    cells = nb['cells']
    kinds = {}
    for c in cells:
        kinds[c['cell_type']] = kinds.get(c['cell_type'], 0) + 1
    src_lines = sum(len(c['source']) for c in cells)
    print(f"{os.path.basename(f):24} nbformat={nb['nbformat']}.{nb['nbformat_minor']} cells={len(cells)} {kinds} src_lines={src_lines}")
    if len(cells) < 2 or 'metadata' not in nb:
        ok = False
print("json ok" if ok else "json 有问题")
sys.exit(0 if ok else 1)
