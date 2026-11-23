// 図面の重ね合わせ比較の重い計算（位置合わせ・色分け・画像の圧縮）を、画面とは別のスレッドで行う。
// 計算の間も画面の進み具合と「中止」が動くように（overlay.js の analyzeFull をそのまま使う）
import { analyzeFull } from './overlay.js';

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    const r = await analyzeFull(job);
    self.postMessage({ id, r }, r.rgbz ? [r.rgbz.buffer] : []);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
