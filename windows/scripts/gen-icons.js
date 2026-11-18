// lucide-static から使用するアイコンだけを抜き出して renderer/icons.js を生成する
const fs = require('fs');
const path = require('path');
const names = ['mouse-pointer-2', 'hand', 'highlighter', 'underline', 'strikethrough', 'sticky-note', 'type',
  'text-cursor-input', 'pencil', 'square', 'circle', 'minus', 'move-up-right', 'image', 'pen-tool', 'stamp',
  'ruler', 'spline', 'pentagon', 'languages', 'eraser', 'crop', 'link', 'text-cursor', 'square-check-big', 'list', 'rectangle-horizontal', 'panel-left',
  'panel-right', 'zoom-in', 'zoom-out', 'maximize', 'chevron-up', 'chevron-down', 'undo-2', 'redo-2', 'save',
  'folder-open', 'printer', 'search', 'rotate-cw', 'rotate-ccw', 'trash-2', 'copy', 'file-plus', 'x'];
const dir = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const out = {};
for (const n of names) {
  out[n] = fs.readFileSync(path.join(dir, n + '.svg'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\s*class="[^"]*"/, '').replace(/\n\s*/g, ' ').trim();
}
fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'),
  '// 自動生成（scripts/gen-icons.js）。Lucide Icons — ISC License\nexport const ICONS = ' + JSON.stringify(out, null, 1) + ';\n');
console.log('icons:', names.length);
