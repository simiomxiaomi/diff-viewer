// 静态交叉自检：HTML / CSS / JS 三边引用一致性
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('style.css', 'utf8');
const js = fs.readFileSync('app.js', 'utf8');

let problems = [], checks = 0;
const ok = (m) => { checks++; console.log('  ✓ ' + m); };
const bad = (m) => { problems.push(m); console.log('  ✗ ' + m); };

function uniq(a) { return Array.from(new Set(a)); }
function grab(re, s, g = 1) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(s)) !== null) { out.push(m[g]); if (m.index === r.lastIndex) r.lastIndex++; }
  return uniq(out);
}
const hasClass = (c) => new RegExp('\\.' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s,{:#.\\[]').test(css);
const NON_CLASS = new Set(['data-change', 'data-opt', 'data-view', 'aria-pressed', 'aria-selected', 'aria-label']);

console.log('\n[A] JS 里的 #id 选择器能否在 HTML 找到');
const jsSelectors = uniq([
  ...grab(/\$\('#([\w-]+)'\)/g, js),
  ...grab(/getElementById\('([\w-]+)'\)/g, js)
]);
const htmlIds = new Set(grab(/id="([\w-]+)"/g, html));
jsSelectors.forEach(id => {
  if (htmlIds.has(id)) ok('# ' + id);
  else bad('JS 引用了不存在的 #' + id);
});

console.log('\n[B] JS 里的类选择器能否在 HTML 找到');
const JS_MADE = new Set(['diff-row', 'diff-cell', 'collapse-note', 'empty-note', 'unified-row']);
uniq([
  ...grab(/querySelector(?:All)?\('\.([\w-]+)'\)/g, js),
  ...grab(/closest\('\.([\w-]+)'\)/g, js)
]).forEach(c => {
  if (new RegExp('class="' + c + '[ "]').test(html) || html.includes(' ' + c + '"')) ok('.' + c);
  else if (JS_MADE.has(c)) ok('.' + c + '（元素由 JS 动态创建）');
  else bad('JS 引用了 HTML 中不存在的类 .' + c);
});

console.log('\n[C] HTML class 是否都在 CSS 有定义');
const RUNTIME = new Set(['is-active', 'is-show', 'is-change', 'is-target', 'is-empty']);
uniq(grab(/class="([^"]+)"/g, html).flatMap(s => s.split(/\s+/))).forEach(c => {
  if (!c) return;
  if (hasClass(c)) ok('.' + c);
  else if (RUNTIME.has(c)) ok('.' + c + '（运行时状态类）');
  else bad('HTML 用了 CSS 未定义的类 .' + c);
});

console.log('\n[D] JS 动态生成的类是否在 CSS 有定义');
const DYN_OK = new Set(['empty-note', 'row-empty', 'u-add', 'u-del', 'collapse-note']);
// 导出报告函数内部自带一套独立 CSS（.head/.wrap/.r 等），不属于主页面样式，需排除
const exportFnStart = js.indexOf('function buildStandaloneHtml');
const exportFnEnd = js.indexOf('/* ---ENGINE-END--- */', exportFnStart);
const appJs = (exportFnStart > 0 && exportFnEnd > exportFnStart)
  ? js.slice(0, exportFnStart) + js.slice(exportFnEnd)
  : js;
// 只从「确定是类名的位置」提取：className 赋值、class 属性、classList 调用
const classFromAssign = uniq(grab(/\.className\s*=\s*'([^']*)'/g, appJs));
const classFromAttr = uniq(grab(/class="([\w-]+)/g, appJs));
const classFromList = uniq([
  ...grab(/classList\.add\('([\w-]+)'/g, appJs),
  ...grab(/classList\.remove\('([\w-]+)'/g, appJs)
]);
uniq(classFromAssign.concat(classFromAttr).concat(classFromList)).forEach(raw => {
  raw.split(/\s+/).forEach(c => {
    if (!c || c.length < 2) return;
    if (c.indexOf('$') !== -1) return;            // 含模板变量的拼接片段
    if (NON_CLASS.has(c) || /^(data|aria)-/.test(c)) return;
    if (hasClass(c) || DYN_OK.has(c) || RUNTIME.has(c)) ok('.' + c);
    else bad('JS 生成但 CSS 未定义 .' + c);
  });
});

console.log('\n[E] id 唯一性与资源引用');
const allIds = grab(/id="([\w-]+)"/g, html);
const dup = allIds.filter((v, i) => allIds.indexOf(v) !== i);
dup.length ? bad('HTML 有重复 id: ' + uniq(dup).join(', ')) : ok('所有 id 唯一');
uniq([...grab(/href="([^"#][^"]*\.css)"/g, html), ...grab(/src="([^"]+\.js)"/g, html)])
  .forEach(a => fs.existsSync(a) ? ok('资源存在 ' + a) : bad('资源缺失 ' + a));

console.log('\n[F] HTML 标签配对');
const stack = [];
const voids = ['br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'source'];
const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
let m, broken = 0;
const body = html.replace(/<!--[\s\S]*?-->/g, '');
while ((m = tagRe.exec(body)) !== null) {
  const name = m[1].toLowerCase();
  if (voids.includes(name) || /\/$/.test(m[2])) continue;
  if (m[0].charAt(1) === '/') {
    const top = stack.pop();
    if (top !== name) { broken++; bad('标签配对错误：</' + name + '> 对应 <' + top + '>'); }
  } else stack.push(name);
}
if (!broken) ok('标签配对检查通过');
if (stack.length) bad('未闭合的标签: ' + stack.join(', ')); else ok('没有残留未闭合标签');

console.log('\n[G] 可访问性与元信息');
['aria-label', 'aria-selected', 'aria-modal', 'role', 'aria-live'].forEach(a => {
  if (new RegExp(a + '=').test(html)) ok('使用 ' + a);
});
if (!/<html lang="zh-CN">/.test(html)) bad('缺少 html lang'); else ok('html lang 已设置');
if (!/<meta charset="UTF-8">/.test(html)) bad('缺少 charset'); else ok('charset 已设置');
if (!/<meta name="viewport"/.test(html)) bad('缺少 viewport'); else ok('viewport 已设置');
if (!/<meta name="description"/.test(html)) bad('缺少 description'); else ok('description 已设置');

console.log('\n[G2] JS 规范与安全');
['document.readyState', "'use strict'"].forEach(k => js.includes(k) ? ok('包含 ' + k) : bad('缺少 ' + k));
const engineEnd = js.indexOf('/* ---ENGINE-END--- */');
if (engineEnd < 0) bad('缺少引擎段结束标记');
// 示例文本里含有被对比的 JS 代码（含 console.log），属数据不是执行代码，需剔除
const domCode = js.slice(engineEnd)
  .replace(/var SAMPLE_LEFT = \[[\s\S]*?\.join\('\\n'\);/, '')
  .replace(/var SAMPLE_RIGHT = \[[\s\S]*?\.join\('\\n'\);/, '');
if (/console\.log/.test(domCode)) bad('DOM 段残留 console.log');
else ok('DOM 段无 console.log（示例数据中的演示代码不计）');
if (/innerHTML\s*=/.test(js)) bad('发现 innerHTML 赋值');
else ok('未使用 innerHTML 拼接');
if (/URL\.revokeObjectURL/.test(js)) ok('ObjectURL 有回收');
else bad('缺少 URL.revokeObjectURL');
if (/function escapeHtml/.test(js)) ok('导出 HTML 有转义函数');
else bad('缺少 escapeHtml');
if (/try\s*\{[\s\S]{0,160}JSON\.parse/.test(js)) ok('JSON.parse 有异常处理');
else bad('JSON.parse 缺少异常处理');

console.log('\n[G3] 差异算法约束');
['prepare', 'makeIdMapper', 'lcsOps', 'greedyOps', 'buildBlocks', 'diffTexts', 'inlineDiff', 'buildPatch', 'withContext']
  .forEach(k => new RegExp('function ' + k).test(js) ? ok('存在 ' + k) : bad('缺少 ' + k));
if (/Int32Array/.test(js)) ok('DP 使用定长整型数组（省内存）');
else bad('DP 未使用 Int32Array');
if (/makeIdMapper/.test(js) && !/function toIds/.test(js)) ok('两侧共用 id 映射（避免撞号）');
else bad('id 映射实现有隐患');
const mapperCalls = (js.match(/mapper\(entriesA\)/) || []).length + (js.match(/mapper\(entriesB\)/) || []).length;
if (mapperCalls === 2) ok('diffTexts 中两侧均经同一 mapper');
else bad('diffTexts 未共用 mapper');

console.log('\n[G4] 选项按钮与状态键对应');
const optKeys = new Set(grab(/data-opt="([\w]+)"/g, html));
const stateKeys = uniq(grab(/\n      (ignoreCase|ignoreSpace|ignoreAllSpace|ignoreBlank|showLineNo|inlineDiff|contextOnly):/g, js));
if (optKeys.size >= 6) ok('选项按钮 ' + optKeys.size + ' 个');
else bad('选项按钮数量异常：' + optKeys.size);
const missing = Array.from(optKeys).filter(k => stateKeys.indexOf(k) === -1);
missing.length ? bad('按钮 data-opt 与 state.opts 键不匹配: ' + missing.join(','))
  : ok('全部选项按钮都有对应的 state 键');
const viewTabs = grab(/data-view="([\w]+)"/g, html);
if (viewTabs.indexOf('split') !== -1 && viewTabs.indexOf('unified') !== -1) ok('视图切换含 split/unified');
else bad('视图切换缺失：' + viewTabs.join(','));

console.log('\n──────────────');
console.log('检查项 ' + checks + '，问题 ' + problems.length);
if (problems.length) { console.log('\n问题清单：'); problems.forEach(p => console.log(' - ' + p)); process.exit(1); }
