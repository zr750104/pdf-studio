#!/usr/bin/env python3
# Mac 版だけの訳を追加する: python3 scripts/add_tr.py '{"日本語": ["English", "ไทย"]}'
import json, sys, os
SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'Sources', 'PDFStudio', 'Resources', 'i18n')
add = json.loads(sys.argv[1])
for i, l in enumerate(['en', 'th']):
    p = os.path.join(SRC, f'mac-{l}.json'); d = json.load(open(p))
    for k, v in add.items(): d['strings'][k] = v[i]
    open(p, 'w').write(json.dumps(d, ensure_ascii=False, indent=1) + '\n')
