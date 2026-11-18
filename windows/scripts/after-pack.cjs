// electron-builder の afterPack フック。
// Mac 上でビルドすると Windows 用 exe のアイコンや説明文（タスクマネージャーに出る名前）が
// Electron のままになるため、resedit で書き換える。
const fs = require('fs');
const path = require('path');

/**
 * 配布物に、起動に必要なファイルがすべて入っているか確かめる（足りなければビルドを止め、公開させない）。
 * メインプロセスの require('./…') と、画面側の import … from './…' をたどって調べる。
 */
// 自動テスト用で、わざと配布物に入れないもの
const OPTIONAL = new Set(['renderer/selftest.js', 'renderer/perftest.js']);

function checkBundle(appOutDir) {
  const asar = require('@electron/asar');
  const archive = path.join(appOutDir, 'resources', 'app.asar');
  const files = new Set(asar.listPackage(archive).map((f) => f.replace(/\\/g, '/').replace(/^\//, '')));
  const read = (f) => asar.extractFile(archive, f).toString('utf8');
  const missing = [];
  const seen = new Set();
  const visit = (file, re) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!files.has(file)) { missing.push(file); return; }
    for (const m of read(file).matchAll(re)) {
      let dep = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
      if (OPTIONAL.has(dep)) continue;
      if (!/\.(c?js|mjs|json)$/.test(dep)) dep = files.has(`${dep}.js`) || !files.has(`${dep}/index.js`) ? `${dep}.js` : `${dep}/index.js`;
      if (OPTIONAL.has(dep)) continue;
      if (dep.startsWith('renderer/vendor/')) { if (!files.has(dep)) missing.push(dep); continue; }
      visit(dep, re);
    }
  };
  for (const f of ['main.js', 'preload.js']) visit(f, /require\(['"](\.{1,2}\/[^'"]+)['"]\)/g);
  for (const f of ['renderer/app.js']) visit(f, /(?:import|from)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g);
  for (const f of ['renderer/index.html', 'i18n/en.json', 'i18n/th.json', 'assets/fonts/NotoSansThai-Regular.ttf', 'assets/fonts/NotoSansThai-Bold.ttf', 'renderer/vendor/utif/UTIF.js', 'renderer/vendor/fontkit.umd.min.js', 'renderer/tiff-worker.js', 'renderer/tiff-g4.js', 'renderer/vendor/ccitt/ccitt.js', 'renderer/scan-worker.js', 'renderer/scanpages.js', 'tabs-preload.js', 'renderer/tabs.html', 'renderer/tabs.js', 'renderer/tabs.css']) if (!files.has(f)) missing.push(f);
  // native-reg（TIFF の既定のアプリを調べる）の Windows 用本体は asar の外に置かれる必要がある
  const native = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'native-reg', 'prebuilds', 'win32-x64', 'node.napi.node');
  if (!fs.existsSync(native)) missing.push('app.asar.unpacked/node_modules/native-reg/prebuilds/win32-x64/node.napi.node');
  if (missing.length) throw new Error(`配布物に必要なファイルが入っていません: ${[...new Set(missing)].join(', ')}（package.json の build.files を確認）`);
  console.log(`  • 配布物のファイルを確認しました（${seen.size} ファイル）`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  checkBundle(context.appOutDir);
  const ResEdit = await import('resedit');
  const PELibrary = await import('pe-library');
  const { productName, version } = { productName: context.packager.appInfo.productName, version: context.packager.appInfo.version };
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(exe);

  // アイコンを差し替え（既存のアイコングループ ID を使う）
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));

  // 説明文・製品名など（タスクマネージャーの「プロセス」タブにはファイルの説明が表示される）
  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = infos[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map((n) => parseInt(n, 10) || 0);
  vi.setFileVersion(a, b, c, 0, 1041);
  vi.setProductVersion(a, b, c, 0, 1041);
  const langs = vi.getAllLanguagesForStringValues();
  const targets = langs.length ? langs : [{ lang: 1033, codepage: 1200 }];
  for (const t of targets) {
    vi.setStringValues(t, {
      FileDescription: productName,
      ProductName: productName,
      CompanyName: productName,
      InternalName: productName,
      OriginalFilename: `${productName}.exe`,
      FileVersion: version,
      ProductVersion: version,
      LegalCopyright: ''
    });
  }
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • exe のアイコンと説明文を設定しました  file=${path.basename(exePath)}`);
};
