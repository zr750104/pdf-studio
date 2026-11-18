#!/usr/bin/env python3
# Swift のソースにある日本語の文字列が、すべて訳せるか調べる（I18n.swift の tr と同じ手順）
# 使い方: python3 scripts/check_i18n.py [en|th] [--list]
import re, glob, json, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'Sources', 'PDFStudio')
# 調べなくてよいもの：ツール名に付け足すキー表示（前の文字と合わせて訳す）、比較結果のユーザーの文字
IGNORE = {'（7）', '＋ 7\n', '・7: 7'}
# 日本語と英語を併記している文（不具合の報告の本文）
IGNORE_PREFIX = ('## 状況 / What happened', '- 言語 / Language')
JP = re.compile(r'[぀-ヿ㐀-鿿！-～]')

def load(l):
    strings, patterns = {}, []
    for f in ['mac-' + l, l]:
        p = os.path.join(SRC, 'Resources', 'i18n', f + '.json')
        if not os.path.exists(p): continue
        d = json.load(open(p))
        for k, v in d.get('strings', {}).items(): strings.setdefault(k, v)
        for a, b in d.get('patterns', []): patterns.append((re.compile(a, re.S), b))
    return strings, patterns

def tr(s, d):
    strings, patterns = d
    if not JP.search(s): return s, True
    if s in strings: return strings[s], True
    t = s.strip()
    if t != s and t in strings: return s.replace(t, strings[t]), True
    if '\t' in s:
        a, b = s.split('\t', 1)
        r, ok = tr(a, d); return r + '\t' + b, ok
    for re_, rep in patterns:
        m = re_.search(s)
        if m:
            ok = True
            def sub(mm):
                nonlocal ok
                k = int(mm.group(1))
                r, o = tr(m.group(k) or '', d); ok = ok and o; return r
            return re.sub(r'\$(\d)', sub, rep), ok
    if '\n' in s:
        parts = [tr(x, d) for x in s.split('\n')]
        return '\n'.join(p[0] for p in parts), all(p[1] for p in parts)
    return s, False

def literals():
    out = set()
    for f in sorted(glob.glob(os.path.join(SRC, '*.swift'))):
        if f.endswith('SelfTest.swift'): continue
        s = open(f).read()
        s = re.sub(r'(?m)^\s*//[^\n]*', '', s)
        s = re.sub(r'(?<=[\s;{}])//[^\n"]*$', '', s, flags=re.M)
        for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', s):
            t = m.group(1)
            if not JP.search(t): continue
            # 文字列の中の \( … ) は値が入るところ。数字を入れて調べる
            t = re.sub(r'\\\((?:[^()]|\([^()]*\))*\)', '7', t)
            t = t.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\\\\', '\\')
            if t not in IGNORE and not t.startswith(IGNORE_PREFIX): out.add(t)
    return out

if __name__ == '__main__':
    langs = [a for a in sys.argv[1:] if not a.startswith('--')] or ['en', 'th']
    bad = 0
    for l in langs:
        d = load(l)
        miss = sorted(x for x in literals() if not tr(x, d)[1])
        bad += len(miss)
        print(f'{l}: 訳がない {len(miss)} 件')
        if '--list' in sys.argv:
            for x in miss: print(json.dumps(x, ensure_ascii=False))
    sys.exit(1 if bad else 0)
