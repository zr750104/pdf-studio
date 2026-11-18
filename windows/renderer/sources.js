// ページにするファイルの形式を中身（先頭のバイト）で見分け、画像を PDF に取り込む。
// 拡張子と中身が違うファイル（中身が JPEG の .png など）があるため、拡張子では決めない。
import { canvasToBytes } from './util.js';

/** 中身から形式を見分ける：pdf / png / jpeg / tiff / image（その他の画像）/ docx / text / null（対応していない） */
export function sniffKind(name, bytes) {
  const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const b = all.subarray(0, 4096);
  const at = (sig, off = 0) => sig.every((v, i) => b[off + i] === v);
  const ascii = (str, off = 0) => at([...str].map((c) => c.charCodeAt(0)), off);
  const lower = name.toLowerCase();
  // 先頭の署名
  if (ascii('%PDF-')) return 'pdf';
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at([0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii('II*\0') || ascii('MM\0*')) return 'tiff';
  if (ascii('GIF87a') || ascii('GIF89a') || (ascii('RIFF') && ascii('WEBP', 8))) return 'image';
  // AVIF（主ブランドか互換ブランドに avif / avis がある）
  if (ascii('ftyp', 4)) {
    const size = Math.min(b.length, (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0);
    for (let i = 8; i + 4 <= size; i += 4) if (ascii('avif', i) || ascii('avis', i)) return 'image';
    return null;
  }
  // BMP は「BM」だけだと文章（BMI…）と区別できないので、ヘッダーの大きさも確かめる
  if (ascii('BM') && b.length > 18 && [12, 40, 56, 64, 108, 124].includes(b[14] | (b[15] << 8))) return 'image';
  // Word（.docx）は ZIP。同じ ZIP の Excel・PowerPoint などは対応していない
  if (ascii('PK\x03\x04')) return lower.endsWith('.docx') ? 'docx' : null;
  // 先頭に余分なものが付いた PDF（拡張子が .pdf のときだけ探す。PDF について書いた文章を取り違えないように）
  if (lower.endsWith('.pdf')) {
    for (let i = 1; i <= Math.min(b.length, 1024) - 5; i++) if (ascii('%PDF-', i)) return 'pdf';
    return null;
  }
  // RTF は文字だけに見えるが、そのまま PDF にすると書式の命令が並ぶだけなので対応しない
  if (ascii('{\\rtf')) return null;
  if (!all.length) return null;
  // BOM 付きの UTF-16（メモ帳の「Unicode」）のテキスト
  if (at([0xff, 0xfe]) || at([0xfe, 0xff])) return 'text';
  // 文字だけのファイル（NUL を含まない）はテキストとして PDF にする。古い Office 形式・プログラム・圧縮ファイルなどは NUL を含む
  if (b.includes(0)) return null;
  try {
    // 4096 バイトで切ったときの文字の途中は、続きがあるものとして読む
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: all.length > b.length });
    return 'text';
  } catch {
    // UTF-8 でない（Shift_JIS などの）テキストも、制御文字が少なければ文字として扱う（変換するときに文字コードを判定する）
    let ctrl = 0;
    for (const v of b) if (v < 9 || (v > 13 && v < 32 && v !== 27)) ctrl++;
    return ctrl < b.length * 0.01 ? 'text' : null;
  }
}

/** 画像を一度ブラウザで読み込んで PNG にする（pdf-lib が直接読めない画像用） */
export async function imageToPng(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  try { return await canvasToBytes(c, 'image/png'); } finally { c.width = 0; }
}

/** 画像（PNG・JPEG・その他）を pdf-lib に取り込む。pdf-lib が直接読めない形はブラウザで読み直す */
export async function embedImage(doc, kind, bytes) {
  if (kind === 'png' || kind === 'jpeg') {
    try {
      return kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch { /* 16 ビット・CMYK の JPEG など：下で読み直す */ }
  }
  return doc.embedPng(await imageToPng(bytes));
}

