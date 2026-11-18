// 実行時に必要なライブラリのファイルだけを renderer/vendor にコピーする。
// （node_modules を丸ごと同梱しないことで、配布サイズと起動時のファイル読み込みを減らす）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'renderer', 'vendor');

const files = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['pdfjs-dist/LICENSE', 'LICENSES/pdfjs.txt'],
  ['@cantoo/pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js'],
  ['@cantoo/pdf-lib/LICENSE.md', 'LICENSES/pdf-lib.txt'],
  ['@cantoo/fontkit/dist/fontkit.umd.min.js', 'fontkit.umd.min.js'],
  ['@cantoo/fontkit/LICENSE', 'LICENSES/fontkit.txt'],
  ['tesseract.js/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js/LICENSE.md', 'LICENSES/tesseract.js.txt'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/LICENSE', 'LICENSES/tesseract-core.txt'],
  ['utif/UTIF.js', 'utif/UTIF.js'],
  ['utif/LICENSE', 'LICENSES/utif.txt'],
  ['pako/dist/pako_inflate.min.js', 'utif/pako_inflate.min.js'],
  ['pako/LICENSE', 'LICENSES/pako.txt']
];

fs.rmSync(OUT, { recursive: true, force: true });
let total = 0;
for (const [from, to] of files) {
  const src = path.join(NM, from);
  const dst = path.join(OUT, to);
  if (!fs.existsSync(src)) {
    // ライセンスファイル名の揺れに対応
    const alt = fs.readdirSync(path.dirname(src)).find((f) => /^licen[cs]e/i.test(f));
    if (to.startsWith('LICENSES/') && alt) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(path.dirname(src), alt), dst);
      continue;
    }
    throw new Error(`見つかりません: ${from}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
// G4（ファクス形式）の TIFF を速く展開するため、pdf.js の CCITT デコーダだけを取り出してワーカー用のスクリプトにする
{
  const src = fs.readFileSync(path.join(NM, 'pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
  const a = src.indexOf(';// ./src/core/ccitt.js'), b = src.indexOf(';// ./src/core/ccitt_stream.js');
  if (a < 0 || b < a) throw new Error('pdf.js の CCITT デコーダが見つかりません');
  const body = src.slice(a, b).replace(';// ./src/core/ccitt.js', '');
  if (!body.includes('class CCITTFaxDecoder')) throw new Error('pdf.js の CCITT デコーダが見つかりません');
  const ver = require(path.join(NM, 'pdfjs-dist/package.json')).version;
  const head = `/* CCITT（G3/G4 ファクス形式）の展開。pdf.js ${ver} の src/core/ccitt.js を取り出したもの（scripts/vendor.js が作る）。
 * Copyright 2012 Mozilla Foundation. Licensed under the Apache License, Version 2.0（LICENSES/pdfjs.txt）
 */
function info() {}
class FormatError extends Error {}
`;
  fs.mkdirSync(path.join(OUT, 'ccitt'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'ccitt', 'ccitt.js'), head + body + '\nself.CCITTFaxDecoder = CCITTFaxDecoder;\n');
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? walk(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
total = walk(OUT);
console.log(`vendor: ${(total / 1024 / 1024).toFixed(1)} MB`);
