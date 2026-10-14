// Diff Viewer：差异算法纯逻辑自测
const fs = require('fs');
const src = fs.readFileSync('app.js', 'utf8');

const start = src.indexOf('  /** 统一换行符并按行切分 */');
const end = src.indexOf('/* ---ENGINE-END--- */');
if (start < 0 || end < 0) { console.error('抽取失败', start, end); process.exit(1); }

// 顶部常量段（在引擎函数之前）
const constSeg = src.slice(src.indexOf('  var DP_LIMIT'), src.indexOf('  /* ====', src.indexOf('  var DP_LIMIT')));

const mod = new Function(constSeg + '\n' + src.slice(start, end) + '\nreturn {' +
  'toLines, normalizeLine, isBlank, prepare, makeIdMapper, lcsOps, greedyOps, buildBlocks,' +
  'diffTexts, countStats, inlineDiff, attachInline, buildPatch, withContext, splitChars,' +
  'escapeHtml, buildStandaloneHtml, DP_LIMIT, RENDER_LIMIT, CONTEXT' +
  '};')();
// 两侧共用映射表（与 diffTexts 内部一致），供单独测 lcsOps 用
const idsFor = (a, b) => {
  const mapper = mod.makeIdMapper();
  return { aId: mapper(a), bId: mapper(b) };
};

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '\n      → ' + extra : '')); }
}
const D = (a, b, opts) => mod.diffTexts(a, b, opts || {});
const kinds = (r) => r.blocks.map(x => x.kind).join(',');
const NOOPT = { ignoreCase: false, ignoreSpace: false, ignoreAllSpace: false, ignoreBlank: false };

console.log('\n[1] 基础工具');
t('toLines 统一 CRLF', JSON.stringify(mod.toLines('a\r\nb\rc')) === JSON.stringify(['a', 'b', 'c']));
t('toLines 空串', JSON.stringify(mod.toLines('')) === JSON.stringify(['']));
t('isBlank 判断', mod.isBlank('') && mod.isBlank('  \t') && !mod.isBlank('a'));
t('normalizeLine 默认原样', mod.normalizeLine('  A  ', {}) === '  A  ');
t('normalizeLine 去首尾空白', mod.normalizeLine('  A  ', { ignoreSpace: true }) === 'A');
t('normalizeLine 去所有空白', mod.normalizeLine(' a b ', { ignoreAllSpace: true }) === 'ab');
t('normalizeLine 忽略大小写', mod.normalizeLine('AbC', { ignoreCase: true }) === 'abc');
t('normalizeLine 组合选项', mod.normalizeLine(' A b ', { ignoreAllSpace: true, ignoreCase: true }) === 'ab');

console.log('\n[2] prepare 预处理');
const prep = mod.prepare('a\n\nb', { ignoreBlank: false });
t('不过滤空行时条目数', prep.length === 3, prep.length);
t('行号从 1 开始且连续', prep.map(e => e.no).join(',') === '1,2,3', prep.map(e => e.no).join(','));
const prep2 = mod.prepare('a\n\nb', { ignoreBlank: true });
t('过滤空行后条目数', prep2.length === 2, prep2.length);
t('过滤后行号保留原始位置', prep2.map(e => e.no).join(',') === '1,3', prep2.map(e => e.no).join(','));
t('prepare 空文本返回零行', mod.prepare('', {}).length === 0, mod.prepare('', {}).length);
t('prepare 单个换行视为两行空行', mod.prepare('\n', {}).length === 2, mod.prepare('\n', {}).length);
t('prepare 空文本 vs 空白文本区分', mod.prepare('', {}).length === 0 && mod.prepare(' ', {}).length === 1);
t('prepare 键值可归一化', mod.prepare('  A  ', { ignoreSpace: true })[0].key === 'A');

console.log('\n[3] 完全相同与完全不同');
let r = D('a\nb\nc', 'a\nb\nc', NOOPT);
t('完全相同 → 单个 equal 块', kinds(r) === 'equal', kinds(r));
t('完全相同 stats 正确', r.stats.added === 0 && r.stats.deleted === 0 && r.stats.same === 3 && r.stats.changeGroups === 0,
  JSON.stringify(r.stats));
t('完全相同相似度 100%', Math.abs(r.stats.similarity - 1) < 1e-6, r.stats.similarity);
t('完全相同无改动可跳转', r.stats.changeGroups === 0);

r = D('a\nb', 'x\ny', NOOPT);
t('完全不同 → modify 块', kinds(r) === 'modify', kinds(r));
t('modify 保留左右两侧行', r.blocks[0].aLines.length === 2 && r.blocks[0].bLines.length === 2);

r = D('a\nb', 'a\nb\nc\nd', NOOPT);
t('尾部新增 → insert 块', kinds(r) === 'equal,insert', kinds(r));
t('新增行数正确', r.stats.added === 2 && r.stats.deleted === 0, JSON.stringify(r.stats));

r = D('a\nb\nc\nd', 'a\nb', NOOPT);
t('尾部删除 → delete 块', kinds(r) === 'equal,delete', kinds(r));
t('删除行数正确', r.stats.added === 0 && r.stats.deleted === 2);

console.log('\n[4] LCS 最优性（关键）');
// 经典用例：两边都含 "abc"，中间有插入
r = D('x\na\nb\nc\ny', 'x\na\nz\nb\nc\ny', NOOPT);
t('中间插入一行被识别为 insert', kinds(r) === 'equal,insert,equal', kinds(r));
t('中间插入只算 1 行新增', r.stats.added === 1 && r.stats.deleted === 0, JSON.stringify(r.stats));

// 确保不是贪心的坏结果：LCS 应该最大化相同行
r = D('a\nb\nc\nd', 'b\nc', NOOPT);
t('子序列匹配利用 LCS（相同 2 行）', r.stats.same === 2, JSON.stringify(r.stats));
t('子序列匹配块类型', kinds(r) === 'delete,equal,delete', kinds(r));

r = D('', '', NOOPT);
t('两空文本不崩且无块', r.blocks.length === 0 && r.stats.changeGroups === 0, kinds(r) + ' | ' + JSON.stringify(r.stats));

r = D('a', '', NOOPT);
t('一边为空 → 全删除', r.stats.deleted === 1 && r.stats.added === 0, JSON.stringify(r.stats));
r = D('', 'a', NOOPT);
t('另一边为空 → 全新增', r.stats.added === 1 && r.stats.deleted === 0, JSON.stringify(r.stats));

console.log('\n[5] 操作序列完整性（不丢行）');
function coverage(a, b, opts) {
  const res = mod.diffTexts(a, b, opts);
  let aCount = 0, bCount = 0, aNos = [], bNos = [];
  res.blocks.forEach(blk => {
    blk.aLines.forEach(l => { aCount++; aNos.push(l.no); });
    blk.bLines.forEach(l => { bCount++; bNos.push(l.no); });
  });
  return { res, aCount, bCount, aNos, bNos };
}
const cov = coverage('l1\nl2\nl3\nl4\nl5', 'l1\nl3\nl4\nl5\nl6', NOOPT);
t('左侧行数守恒', cov.aCount === 5, cov.aCount);
t('右侧行数守恒', cov.bCount === 5, cov.bCount);
t('左侧行号无重复', new Set(cov.aNos).size === cov.aNos.length, cov.aNos.join(','));
t('右侧行号无重复', new Set(cov.bNos).size === cov.bNos.length, cov.bNos.join(','));

// 随机对拍：行数守恒 + 相同行数 = LCS 长度
function lcsLength(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}
let worst = null;
let cases = 0;
for (let seed = 0; seed < 120; seed++) {
  const rand = (n) => Math.floor(Math.abs(Math.sin(seed * 7.13 + n * 3.71)) * 1000) % 4;
  const mk = (len) => Array.from({ length: len }, (_, i) => 'w' + rand(i)).join('\n');
  const a = mk(1 + seed % 9), b = mk(1 + (seed * 3) % 9);
  const res = mod.diffTexts(a, b, NOOPT);
  const same = res.stats.same;
  const expected = lcsLength(a.split('\n'), b.split('\n'));
  const aTotal = res.blocks.reduce((s, x) => s + x.aLines.length, 0);
  const bTotal = res.blocks.reduce((s, x) => s + x.bLines.length, 0);
  cases++;
  if (same !== expected || aTotal !== a.split('\n').length || bTotal !== b.split('\n').length) {
    worst = 'a=' + JSON.stringify(a) + ' b=' + JSON.stringify(b) + ' same=' + same + '/' + expected +
      ' totals=' + aTotal + '/' + bTotal;
    break;
  }
}
t('120 组随机对拍：相同行数 = LCS 长度且行数守恒', worst === null, worst || ('通过 ' + cases + ' 组'));

console.log('\n[6] 忽略选项生效');
r = D('Hello\nWorld', 'hello\nworld', NOOPT);
t('默认区分大小写 → 有改动', r.stats.changeGroups > 0, JSON.stringify(r.stats));
r = D('Hello\nWorld', 'hello\nworld', { ignoreCase: true });
t('忽略大小写 → 完全一致', r.stats.changeGroups === 0, kinds(r));

r = D('  a  \nb', 'a\nb', NOOPT);
t('默认空白敏感 → 有改动', r.stats.changeGroups > 0);
r = D('  a  \nb', 'a\nb', { ignoreSpace: true });
t('忽略首尾空白 → 一致', r.stats.changeGroups === 0, kinds(r));

r = D('a b\nc', 'ab\nc', { ignoreAllSpace: true });
t('忽略所有空白 → 一致', r.stats.changeGroups === 0, kinds(r));

r = D('a\n\n\nb', 'a\nb', NOOPT);
t('默认空行参与对比', r.stats.changeGroups > 0, kinds(r));
r = D('a\n\n\nb', 'a\nb', { ignoreBlank: true });
t('忽略空行 → 一致', r.stats.changeGroups === 0, kinds(r));
t('忽略空行后行号仍指向原文', (function () {
  const res = mod.diffTexts('a\n\n\nb', 'a\nb', { ignoreBlank: true });
  const first = res.blocks[0].aLines[0];
  const last = res.blocks[res.blocks.length - 1].aLines.slice(-1)[0];
  return first.no === 1 && last.no === 4;
})(), JSON.stringify(mod.diffTexts('a\n\n\nb', 'a\nb', { ignoreBlank: true }).blocks.map(b => b.aLines.map(l => l.no))));

console.log('\n[7] 字符级内联对比');
let seg = mod.inlineDiff('hello world', 'hello there');
t('两侧分段可还原原文', seg.left.map(s => s.text).join('') === 'hello world' &&
  seg.right.map(s => s.text).join('') === 'hello there',
  JSON.stringify([seg.left.map(s => s.text).join(''), seg.right.map(s => s.text).join('')]));
t('相同前缀不标记', seg.left[0].text === 'hello ' && seg.left[0].marked === false, JSON.stringify(seg.left));
t('左侧独有字符被标记', seg.left.filter(s => s.marked).map(s => s.text).join('') === 'wold',
  JSON.stringify(seg.left.filter(s => s.marked).map(s => s.text).join('')));
t('右侧独有字符被标记', seg.right.filter(s => s.marked).map(s => s.text).join('') === 'thee',
  JSON.stringify(seg.right.filter(s => s.marked).map(s => s.text).join('')));
t('公共字符 r 未被标记', seg.left.some(s => s.text === 'r' && !s.marked), JSON.stringify(seg.left));
t('标记字数 = 总字数 − LCS 长度', (function () {
  const a = 'hello world', b = 'hello there';
  const lcs = (function (x, y) {
    const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    return dp[0][0];
  })(a.split(''), b.split(''));
  const markedL = seg.left.filter(s => s.marked).reduce((n, s) => n + s.text.length, 0);
  const markedR = seg.right.filter(s => s.marked).reduce((n, s) => n + s.text.length, 0);
  return markedL === a.length - lcs && markedR === b.length - lcs;
})(), JSON.stringify([seg.left, seg.right]));

seg = mod.inlineDiff('abc', 'abc');
t('完全相同无标记', seg.left.every(s => !s.marked) && seg.right.every(s => !s.marked));
seg = mod.inlineDiff('', 'abc');
t('左侧为空时不崩', seg.left.length === 0 || seg.left.every(s => s.text === ''));
seg = mod.inlineDiff('中文测试', '中文测验');
t('中文按字对比', seg.left.map(s => s.text).join('') === '中文测试' && seg.right.map(s => s.text).join('') === '中文测验');
t('中文差异定位正确', seg.left.some(s => s.marked && s.text === '试') && seg.right.some(s => s.marked && s.text === '验'),
  JSON.stringify([seg.left, seg.right]));

console.log('\n[8] attachInline 附加分段');
r = D('hello world', 'hello there', NOOPT);
mod.attachInline(r.blocks, { inlineDiff: true });
t('modify 块被附加 segments', (function () {
  const blk = r.blocks.find(b => b.kind === 'modify');
  return blk && blk.aLines[0].segments && blk.aLines[0].segments.length > 0;
})(), JSON.stringify(r.blocks.map(b => b.kind)));
r = D('hello world', 'hello there', NOOPT);
mod.attachInline(r.blocks, { inlineDiff: false });
t('inlineDiff=false 时不附加', (function () {
  const blk = r.blocks.find(b => b.kind === 'modify');
  return blk && !blk.aLines[0].segments;
})());
t('equal 块不附加', (function () {
  const res = D('same\nx', 'same\ny', NOOPT);
  mod.attachInline(res.blocks, {});
  const eq = res.blocks.find(b => b.kind === 'equal');
  return eq && !eq.aLines[0].segments;
})());

console.log('\n[9] 上下文折叠');
const big = Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n');
const bigMod = big.replace('line15', 'LINE15');
r = D(big, bigMod, NOOPT);
const ctx = mod.withContext(r.blocks, 3);
t('折叠后有 gap 产生', ctx.some(x => x.type === 'gap'), JSON.stringify(ctx));
t('折叠后保留改动块', ctx.some(x => x.type === 'block' && r.blocks[x.index].kind !== 'equal'), JSON.stringify(ctx));
t('gap 行数合理（总展开行数远小于原文）', (function () {
  let shown = 0;
  ctx.forEach(x => {
    if (x.type === 'block') shown += mod.diffTexts(big, bigMod, NOOPT).blocks[x.index].aLines.length;
    else if (x.type === 'head' || x.type === 'tail') shown += x.count;
  });
  return shown < 30;
})(), JSON.stringify(ctx.map(x => x.type)));
const ctxAll = mod.withContext(D('a\nb', 'a\nb', NOOPT).blocks, 3);
t('全等值且无改动时不产生 gap', !ctxAll.some(x => x.type === 'gap'), JSON.stringify(ctxAll));

console.log('\n[10] 补丁生成');
r = D('a\nb\nc', 'a\nB\nc', NOOPT);
const patch = mod.buildPatch(r.blocks, 'old.txt', 'new.txt');
t('补丁含文件头', patch.indexOf('--- old.txt') === 0 && patch.indexOf('+++ new.txt') !== -1, patch);
t('补丁含 @@ 块头', /@@ -\d+,\d+ \+\d+,\d+ @@/.test(patch), patch);
t('补丁含删除行前缀', patch.indexOf('\nb\n') === -1 && patch.indexOf('-b') !== -1, patch);
t('补丁含新增行前缀', patch.indexOf('+B') !== -1, patch);
t('补丁以换行结尾', patch.charAt(patch.length - 1) === '\n');
t('无差异时补丁只有头', (function () {
  const p = mod.buildPatch(D('a', 'a', NOOPT).blocks, 'x', 'y');
  return p.split('\n').filter(Boolean).length === 2;
})());

console.log('\n[11] 统计与相似度');
r = D('a\nb\nc\nd', 'a\nb\nc\nX', NOOPT);
t('modify 计入 modified', r.stats.modified > 0, JSON.stringify(r.stats));
t('stats 各字段为数字', ['added', 'deleted', 'modified', 'same', 'changeGroups', 'similarity']
  .every(k => typeof r.stats[k] === 'number'), JSON.stringify(r.stats));
t('相似度在 0–1 之间', r.stats.similarity >= 0 && r.stats.similarity <= 1, r.stats.similarity);
t('改动组数统计', r.stats.changeGroups === 1, r.stats.changeGroups);

console.log('\n[12] 大文本降级路径');
const hugeA = Array.from({ length: 2100 }, (_, i) => 'row' + i).join('\n');
const hugeB = hugeA.replace('row1000', 'ROW1000');
const t0 = Date.now();
const huge = mod.diffTexts(hugeA, hugeB, NOOPT);
const cost = Date.now() - t0;
t('2000+ 行仍能给出结果', huge.blocks.length > 0);
t('2000+ 行耗时 < 3000ms', cost < 3000, cost + 'ms');
t('大文本行数守恒', huge.blocks.reduce((s, b) => s + b.aLines.length, 0) === 2100,
  huge.blocks.reduce((s, b) => s + b.aLines.length, 0));

const overLimit = mod.diffTexts(
  Array.from({ length: 2100 }, (_, i) => 'a' + i).join('\n'),
  Array.from({ length: 2100 }, (_, i) => 'a' + (i + 1)).join('\n'),
  NOOPT
);
t('超 DP 上限走贪心仍守恒', overLimit.blocks.reduce((s, b) => s + b.aLines.length, 0) === 2100,
  overLimit.blocks.reduce((s, b) => s + b.aLines.length, 0));

console.log('\n[13] 导出 HTML');
r = D('a\nb\nc', 'a\nB\nc', NOOPT);
const html = mod.buildStandaloneHtml(r.blocks, r.stats, '原文', '新文');
t('含 DOCTYPE', html.indexOf('<!DOCTYPE html>') === 0);
t('含统计信息', html.indexOf('文本对比报告') !== -1 && html.indexOf('相似度') !== -1);
t('HTML 转义生效', (function () {
  const res = D('<script>alert(1)</script>', '<b>x</b>', NOOPT);
  const h = mod.buildStandaloneHtml(res.blocks, res.stats, 'a', 'b');
  return h.indexOf('<script>alert(1)</script>') === -1 && h.indexOf('&lt;script&gt;') !== -1;
})(), (function () {
  const res = D('<script>alert(1)</script>', '<b>x</b>', NOOPT);
  return mod.buildStandaloneHtml(res.blocks, res.stats, 'a', 'b').slice(0, 400);
})());
t('escapeHtml 处理引号', mod.escapeHtml('"a"&\'b\'') === '&quot;a&quot;&amp;&#39;b&#39;', mod.escapeHtml('"a"&\'b\''));

console.log('\n[14] 边界与健壮性');
t('null 输入不崩', (function () { try { mod.diffTexts(null, null, {}); return true; } catch (e) { return false; } })());
t('超长单行不崩', (function () {
  const long1 = 'x'.repeat(20000), long2 = 'y'.repeat(20000);
  const res = mod.diffTexts(long1, long2, NOOPT);
  return res.blocks.length > 0;
})());
t('全是空行', (function () {
  const res = mod.diffTexts('\n\n\n', '\n\n', NOOPT);
  return res.blocks.length > 0;
})());
t('只有换行差异', (function () {
  const res = mod.diffTexts('a', 'a\n', NOOPT);
  return typeof res.stats.changeGroups === 'number';
})());
t('常量合理', mod.DP_LIMIT >= 1e6 && mod.RENDER_LIMIT >= 500 && mod.CONTEXT >= 1,
  [mod.DP_LIMIT, mod.RENDER_LIMIT, mod.CONTEXT].join(','));
t('emoji 行正常对比', (function () {
  const res = mod.diffTexts('😀 a', '😀 b', NOOPT);
  return res.stats.changeGroups === 1;
})());

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
