/* ==========================================================================
   Diff Viewer · app.js
   纯原生实现：LCS/Myers 差异算法 + 字符级内联对比
   零依赖、零构建。两侧文本与选项保存在 localStorage。
   ========================================================================== */
(function () {
  'use strict';

  var DP_LIMIT = 4e6;        // DP 表单元上限（约 2000×2000 行仍可算）
  var RENDER_LIMIT = 3000;   // 最多渲染多少行，防止 DOM 爆炸
  var INLINE_TEXT_LIMIT = 200000;   // 参与字符级对比的总字符上限
  var INLINE_LINE_LIMIT = 5000;     // 单行参与字符级对比的长度上限
  var CONTEXT = 3;           // 仅显示改动时的上下文行数

  /* =======================================================================
     一、差异引擎（纯函数）
     ======================================================================= */

  /** 统一换行符并按行切分 */
  function toLines(text) {
    return String(text).replace(/\r\n?/g, '\n').split('\n');
  }

  /** 按选项归一化一行，用于「忽略」类比较 */
  function normalizeLine(line, options) {
    var s = String(line);
    var opt = options || {};
    if (opt.ignoreAllSpace) s = s.replace(/\s+/g, '');
    else if (opt.ignoreSpace) s = s.replace(/^\s+|\s+$/g, '');
    if (opt.ignoreCase) s = s.toLowerCase();
    return s;
  }

  function isBlank(line) {
    return /^\s*$/.test(String(line));
  }

  /** 按选项过滤掉空行（行号保留，供补丁使用） */
  function prepare(text, options) {
    var opt = options || {};
    // 空文本视为「零行」，而不是「一行空行」，否则空文件会被当成含一个空行
    if (text === '' || text == null) return [];
    var lines = toLines(text);
    var entries = [];
    for (var i = 0; i < lines.length; i++) {
      if (opt.ignoreBlank && isBlank(lines[i])) continue;
      entries.push({ no: i + 1, text: lines[i], key: normalizeLine(lines[i], opt) });
    }
    return entries;
  }

  /** 把行的 key 映射为整数 id（两侧必须共用同一张表，否则不同内容会撞号） */
  function makeIdMapper() {
    var map = {};
    var next = 0;
    return function (entries) {
      var ids = [];
      for (var i = 0; i < entries.length; i++) {
        var key = entries[i].key;
        if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = next++;
        ids.push(map[key]);
      }
      return ids;
    };
  }

  /** 经典 DP+LCS 回溯，返回 {a, b} 顺序对（type 0 相同 / 1 仅左 / 2 仅右） */
  function lcsOps(a, b, aId, bId) {
    var n = a.length, m = b.length;
    var width = m + 1;
    var dp = new Int32Array((n + 1) * width);
    var i, j;
    for (i = n - 1; i >= 0; i--) {
      var row = i * width, nextRow = (i + 1) * width;
      for (j = m - 1; j >= 0; j--) {
        dp[row + j] = aId[i] === bId[j]
          ? dp[nextRow + j + 1] + 1
          : Math.max(dp[nextRow + j], dp[row + j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (aId[i] === bId[j]) { ops.push({ type: 0, ai: i, bi: j }); i++; j++; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: 1, ai: i, bi: -1 }); i++; }
      else { ops.push({ type: 2, ai: -1, bi: j }); j++; }
    }
    while (i < n) { ops.push({ type: 1, ai: i, bi: -1 }); i++; }
    while (j < m) { ops.push({ type: 2, ai: -1, bi: j }); j++; }
    return ops;
  }

  /** 降级方案：按 key 出现次数贪心配对，避免大文件爆内存 */
  function greedyOps(a, b) {
    var pool = {};
    for (var j = 0; j < b.length; j++) {
      var key = b[j].key;
      if (!pool[key]) pool[key] = [];
      pool[key].push(j);
    }
    var ops = [];
    var usedB = {};
    for (var i = 0; i < a.length; i++) {
      var list = pool[a[i].key];
      var picked = -1;
      if (list) {
        for (var k = 0; k < list.length; k++) {
          if (!usedB[list[k]]) { picked = list[k]; break; }
        }
      }
      if (picked >= 0) {
        usedB[picked] = 1;
        ops.push({ type: 0, ai: i, bi: picked });
      } else {
        ops.push({ type: 1, ai: i, bi: -1 });
      }
    }
    for (var j2 = 0; j2 < b.length; j2++) {
      if (!usedB[j2]) ops.push({ type: 2, ai: -1, bi: j2 });
    }
    return ops;
  }

  /** 把原始操作序列合并成带类型的差异块 */
  function buildBlocks(entriesA, entriesB, ops) {
    var blocks = [];
    var i = 0;

    function push(kind, aLines, bLines) {
      blocks.push({
        kind: kind,
        aLines: aLines,
        bLines: bLines,
        aStart: aLines.length ? aLines[0].no : 0,
        bStart: bLines.length ? bLines[0].no : 0,
        startIndex: blocks.length
      });
    }

    while (i < ops.length) {
      var op = ops[i];

      if (op.type === 0) {
        var eqA = [entriesA[op.ai]], eqB = [entriesB[op.bi]];
        i++;
        while (i < ops.length && ops[i].type === 0) {
          eqA.push(entriesA[ops[i].ai]);
          eqB.push(entriesB[ops[i].bi]);
          i++;
          // 相邻的相同行拆成独立块没意义，但为了后续按上下文合并，这里先整体收集
        }
        push('equal', eqA, eqB);
        continue;
      }

      var delA = [], addB = [];
      while (i < ops.length && ops[i].type !== 0) {
        if (ops[i].type === 1) delA.push(entriesA[ops[i].ai]);
        else addB.push(entriesB[ops[i].bi]);
        i++;
      }
      if (delA.length && addB.length) push('modify', delA, addB);
      else if (delA.length) push('delete', delA, []);
      else push('insert', [], addB);
    }
    return blocks;
  }

  /** 主入口：对比两段文本 */
  function diffTexts(textA, textB, options) {
    var opt = options || {};
    var t0 = now();
    var entriesA = prepare(textA, opt);
    var entriesB = prepare(textB, opt);
    var ops;

    var mapper = makeIdMapper();
    var aId = mapper(entriesA);
    var bId = mapper(entriesB);

    if (entriesA.length * entriesB.length <= DP_LIMIT) {
      ops = lcsOps(entriesA, entriesB, aId, bId);
    } else {
      ops = greedyOps(entriesA, entriesB);
    }

    var blocks = buildBlocks(entriesA, entriesB, ops);
    var stats = countStats(blocks);
    var t1 = now();

    return {
      blocks: blocks,
      stats: stats,
      elapsed: t1 - t0,
      truncated: false
    };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function countStats(blocks) {
    var added = 0, deleted = 0, modified = 0, same = 0, changeGroups = 0;
    blocks.forEach(function (b) {
      if (b.kind === 'equal') same += b.aLines.length;
      else if (b.kind === 'insert') { added += b.bLines.length; changeGroups++; }
      else if (b.kind === 'delete') { deleted += b.aLines.length; changeGroups++; }
      else {
        modified += Math.max(b.aLines.length, b.bLines.length);
        added += b.bLines.length;
        deleted += b.aLines.length;
        changeGroups++;
      }
    });
    var total = same + added + deleted;
    return {
      added: added,
      deleted: deleted,
      modified: modified,
      same: same,
      changeGroups: changeGroups,
      changes: added + deleted,
      total: total,
      similarity: total ? same / Math.max(same + Math.max(added, deleted), 1) : 1
    };
  }

  /* =======================================================================
     二、字符级内联对比
     ======================================================================= */

  /** 字符级 LCS，返回左/右两侧的分段（{text, marked}） */
  function inlineDiff(left, right) {
    var a = splitChars(left);
    var b = splitChars(right);
    var n = a.length, m = b.length;

    if (n * m > 200000) {
      return {
        left: [{ text: left, marked: n > 0 }],
        right: [{ text: right, marked: m > 0 }]
      };
    }

    var width = m + 1;
    var dp = new Int32Array((n + 1) * width);
    var i, j;
    for (i = n - 1; i >= 0; i--) {
      var row = i * width, nextRow = (i + 1) * width;
      for (j = m - 1; j >= 0; j--) {
        dp[row + j] = a[i] === b[j]
          ? dp[nextRow + j + 1] + 1
          : Math.max(dp[nextRow + j], dp[row + j + 1]);
      }
    }

    var leftParts = [], rightParts = [];
    function push(parts, text, marked) {
      if (!text) return;
      var last = parts[parts.length - 1];
      if (last && last.marked === marked) last.text += text;
      else parts.push({ text: text, marked: marked });
    }

    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push(leftParts, a[i], false); push(rightParts, b[j], false); i++; j++; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { push(leftParts, a[i], true); i++; }
      else { push(rightParts, b[j], true); j++; }
    }
    while (i < n) { push(leftParts, a[i], true); i++; }
    while (j < m) { push(rightParts, b[j], true); j++; }

    return { left: leftParts, right: rightParts };
  }

  function splitChars(text) {
    if (Array.from) return Array.from(String(text));
    return String(text).split('');
  }

  /** 为整个 diff 结果附加字符级分段（按块批量计算） */
  function attachInline(blocks, options) {
    var opt = options || {};
    if (opt.inlineDiff === false) return blocks;
    var totalChars = 0;
    blocks.forEach(function (b) {
      if (b.kind === 'modify') {
        b.aLines.forEach(function (l) { totalChars += l.text.length; });
        b.bLines.forEach(function (l) { totalChars += l.text.length; });
      }
    });
    if (totalChars > INLINE_TEXT_LIMIT) return blocks;

    blocks.forEach(function (b) {
      if (b.kind !== 'modify') return;
      var count = Math.min(b.aLines.length, b.bLines.length);
      for (var k = 0; k < count; k++) {
        var la = b.aLines[k], lb = b.bLines[k];
        if (la.text.length > INLINE_LINE_LIMIT || lb.text.length > INLINE_LINE_LIMIT) continue;
        var segments = inlineDiff(la.text, lb.text);
        la.segments = segments.left;
        lb.segments = segments.right;
      }
    });
    return blocks;
  }

  /* =======================================================================
     三、统一格式补丁
     ======================================================================= */
  function buildPatch(blocks, leftName, rightName) {
    var lines = ['--- ' + leftName, '+++ ' + rightName];

    blocks.forEach(function (b) {
      if (b.kind === 'equal') return;
      var aCount = b.aLines.length;
      var bCount = b.bLines.length;
      var aStart = aCount ? b.aLines[0].no : (b.aStart || 1);
      var bStart = bCount ? b.bLines[0].no : (b.bStart || 1);
      lines.push('@@ -' + (aCount ? aStart : Math.max(1, aStart)) + ',' + aCount +
        ' +' + (bCount ? bStart : Math.max(1, bStart)) + ',' + bCount + ' @@');
      b.aLines.forEach(function (l) { lines.push('-' + l.text); });
      b.bLines.forEach(function (l) { lines.push('+' + l.text); });
      if (aCount && bCount) {
        // 修改块在补丁里表现为「先删后增」，已是上述形式
      }
    });
    return lines.join('\n') + '\n';
  }

  /** 只保留改动附近的上下文（用于「仅显示改动」），返回渲染指令序列 */
  function withContext(blocks, context) {
    var ctx = context === undefined ? CONTEXT : context;
    var out = [];
    var n = blocks.length;

    for (var i = 0; i < n; i++) {
      var b = blocks[i];
      if (b.kind !== 'equal') {
        out.push({ type: 'block', index: i });
        continue;
      }
      var prevChange = i > 0 && blocks[i - 1].kind !== 'equal';
      var nextChange = i < n - 1 && blocks[i + 1].kind !== 'equal';
      if (!prevChange && !nextChange) {
        if (out.length) out.push({ type: 'gap', count: b.aLines.length });
        continue;
      }
      if (b.aLines.length <= ctx * 2) {
        out.push({ type: 'block', index: i });
        continue;
      }
      if (prevChange && nextChange) {
        out.push({ type: 'head', index: i, count: ctx });
        out.push({ type: 'gap', count: b.aLines.length - ctx * 2 });
        out.push({ type: 'tail', index: i, count: ctx });
      } else if (prevChange) {
        out.push({ type: 'head', index: i, count: ctx });
        out.push({ type: 'gap', count: b.aLines.length - ctx });
      } else {
        out.push({ type: 'gap', count: b.aLines.length - ctx });
        out.push({ type: 'tail', index: i, count: ctx });
      }
    }
    return out;
  }

  /* =======================================================================
     四、HTML 导出
     ======================================================================= */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 生成自包含的对比报告 HTML */
  function buildStandaloneHtml(blocks, stats, leftName, rightName) {
    var rows = blocks.map(function (b) {
      if (b.kind === 'equal') {
        return b.aLines.map(function (l, i) {
          var r = b.bLines[i] || { no: '', text: '' };
          return row('', l.no, escapeHtml(l.text), r.no, escapeHtml(r.text));
        }).join('');
      }
      if (b.kind === 'insert') {
        return b.bLines.map(function (l) {
          return row(' add', '', '', l.no, escapeHtml(l.text));
        }).join('');
      }
      if (b.kind === 'delete') {
        return b.aLines.map(function (l) {
          return row(' del', l.no, escapeHtml(l.text), '', '');
        }).join('');
      }
      return b.aLines.map(function (l, i) {
        var r = b.bLines[i];
        return row(' mod', l.no, escapeHtml(l.text), r ? r.no : '', r ? escapeHtml(r.text) : '');
      }).join('');
    }).join('');

    function row(cls, lno, ltext, rno, rtext) {
      return '<div class="r' + cls + '">' +
        '<span class="n">' + (lno === 0 ? '' : lno) + '</span><span class="c">' + ltext + '</span>' +
        '<span class="n">' + (rno === 0 ? '' : rno) + '</span><span class="c">' + rtext + '</span>' +
        '</div>';
    }

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<title>文本对比报告</title>\n<style>\n' +
      ':root{color-scheme:dark}\n' +
      'body{margin:0;background:#0b1020;color:#e8ecf7;font:13px/1.6 ui-monospace,Consolas,Menlo,monospace}\n' +
      '.head{padding:20px 24px;border-bottom:1px solid rgba(255,255,255,.12);font-family:system-ui,sans-serif}\n' +
      '.head h1{margin:0 0 8px;font-size:16px;letter-spacing:.5px}\n' +
      '.head span{display:inline-block;margin-right:14px;font-size:12px;color:rgba(232,236,247,.6)}\n' +
      '.wrap{display:grid;grid-template-columns:34px 1fr 34px 1fr}\n' +
      '.r{display:contents}\n' +
      '.r .n{padding:2px 8px 2px 0;text-align:right;color:rgba(232,236,247,.4);' +
      'background:rgba(0,0,0,.22);user-select:none}\n' +
      '.r .c{padding:2px 12px;white-space:pre-wrap;word-break:break-word}\n' +
      '.r.add .n,.r.add .c:nth-of-type(2){background:rgba(110,231,183,.13)}\n' +
      '.r.del .n,.r.del .c:nth-of-type(2){background:rgba(251,113,133,.13)}\n' +
      '.r.mod .c{background:rgba(251,191,36,.12)}\n' +
      '</style>\n</head>\n<body>\n' +
      '<div class="head"><h1>文本对比报告</h1>' +
      '<span>' + escapeHtml(leftName) + ' → ' + escapeHtml(rightName) + '</span>' +
      '<span>+' + stats.added + '</span><span>−' + stats.deleted + '</span>' +
      '<span>相同 ' + stats.same + ' 行</span><span>相似度 ' + (stats.similarity * 100).toFixed(1) + '%</span>' +
      '</div>\n<div class="wrap">\n' + rows + '\n</div>\n</body>\n</html>\n';
  }

  /* ---ENGINE-END--- */

  /* =======================================================================
     五、DOM 层
     ======================================================================= */
  var $ = function (sel) { return document.querySelector(sel); };

  var els = {
    viewTabs: $('#viewTabs'),
    workspace: $('#workspace'),
    leftText: $('#leftText'),
    rightText: $('#rightText'),
    leftStat: $('#leftStat'),
    rightStat: $('#rightStat'),
    diffScroll: $('#diffScroll'),
    diffBody: $('#diffBody'),
    statAdd: $('#statAdd'),
    statDel: $('#statDel'),
    statMod: $('#statMod'),
    statSame: $('#statSame'),
    statTime: $('#statTime'),
    statusSummary: $('#statusSummary'),
    statusSimilarity: $('#statusSimilarity'),
    optbar: document.querySelector('.optbar'),
    navPos: $('#navPos'),
    prevBtn: $('#prevBtn'),
    nextBtn: $('#nextBtn'),
    swapBtn: $('#swapBtn'),
    sampleBtn: $('#sampleBtn'),
    exportHtmlBtn: $('#exportHtmlBtn'),
    copyPatchBtn: $('#copyPatchBtn'),
    clearBtn: $('#clearBtn'),
    leftPasteBtn: $('#leftPasteBtn'),
    rightPasteBtn: $('#rightPasteBtn'),
    leftClearBtn: $('#leftClearBtn'),
    rightClearBtn: $('#rightClearBtn'),
    patchOverlay: $('#patchOverlay'),
    patchClose: $('#patchClose'),
    patchPre: $('#patchPre'),
    patchLeft: $('#patchLeft'),
    patchRight: $('#patchRight'),
    patchCopyBtn: $('#patchCopyBtn'),
    patchDownloadBtn: $('#patchDownloadBtn'),
    toast: $('#toast')
  };

  var KEYS = {
    left: 'diff-viewer:left',
    right: 'diff-viewer:right',
    opts: 'diff-viewer:opts',
    view: 'diff-viewer:view'
  };

  var state = {
    view: 'split',
    opts: {
      ignoreCase: false,
      ignoreSpace: true,
      ignoreAllSpace: false,
      ignoreBlank: true,
      showLineNo: true,
      inlineDiff: true,
      contextOnly: false
    },
    result: null,
    changeIndex: 0,
    toastTimer: 0,
    renderToken: 0
  };

  var SAMPLE_LEFT = [
    'function greet(name) {',
    '  const msg = "Hello, " + name;',
    '  console.log(msg);',
    '  return msg;',
    '}',
    '',
    'const users = ["Alice", "Bob", "Carol"];',
    'users.forEach(function (u) {',
    '  greet(u);',
    '});',
    '',
    '# 配置',
    'host=127.0.0.1',
    'port=8080',
    'debug=false',
    ''
  ].join('\n');

  var SAMPLE_RIGHT = [
    'function greet(name, greeting) {',
    '  const msg = `${greeting}, ${name}!`;',
    '  console.log(msg);',
    '  return msg;',
    '}',
    '',
    'const users = ["Alice", "Bob", "Dave", "Eve"];',
    'users.forEach(function (user) {',
    '  greet(user, "Hi");',
    '});',
    '',
    '# 配置',
    'host=0.0.0.0',
    'port=9090',
    'debug=true',
    'timeout=30',
    ''
  ].join('\n');

  /* ---------- 存储 ---------- */
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
  }
  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      els.toast.classList.remove('is-show');
    }, 1600);
  }

  function copyText(text, okMsg) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg || '已复制');
      }, function () { fallbackCopy(text, okMsg); });
    } else {
      fallbackCopy(text, okMsg);
    }
  }
  function fallbackCopy(text, okMsg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    toast(ok ? (okMsg || '已复制') : '复制失败，请手动选择');
  }

  /* =======================================================================
     六、渲染
     ======================================================================= */
  function runDiff() {
    var token = ++state.renderToken;
    var result = diffTexts(els.leftText.value, els.rightText.value, state.opts);
    attachInline(result.blocks, state.opts);
    state.result = result;
    state.changeIndex = 0;
    updateStats(result);
    renderDiff(result);
    if (token !== state.renderToken) return;
    updateNav();
  }

  function updateStats(result) {
    var s = result.stats;
    els.statAdd.textContent = '+' + s.added;
    els.statDel.textContent = '−' + s.deleted;
    els.statMod.textContent = '~' + s.modified;
    els.statSame.textContent = s.same + ' 行相同';
    els.statTime.textContent = result.elapsed.toFixed(1) + ' ms';
    els.statusSummary.textContent = s.changeGroups
      ? s.changeGroups + ' 处改动 · 新增 ' + s.added + ' 行 · 删除 ' + s.deleted + ' 行'
      : '两边完全一致';
    els.statusSimilarity.textContent = '相似度 ' + (s.similarity * 100).toFixed(1) + '%';
  }

  function scheduleDiff() {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      save(KEYS.left, els.leftText.value);
      save(KEYS.right, els.rightText.value);
      updateSideStats();
      runDiff();
    }, 220);
  }

  function updateSideStats() {
    var l = els.leftText.value, r = els.rightText.value;
    els.leftStat.textContent = (l ? toLines(l).length : 0) + ' 行 · ' + l.length + ' 字符';
    els.rightStat.textContent = (r ? toLines(r).length : 0) + ' 行 · ' + r.length + ' 字符';
  }

  function renderDiff(result) {
    var body = els.diffBody;
    body.textContent = '';

    if (!result.blocks.length) {
      var note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = '两边都还没有内容。\n把原始文本和修改后的文本分别粘到上面两个框里，差异会自动显示在这里。';
      body.appendChild(note);
      return;
    }

    var frag = document.createDocumentFragment();
    var items = state.opts.contextOnly ? withContext(result.blocks) : null;

    if (items) {
      items.forEach(function (item) {
        if (item.type === 'gap') {
          var g = document.createElement('div');
          g.className = 'collapse-note';
          g.textContent = '⋯ 折叠 ' + item.count + ' 行完全相同的内容（点击展开）⋯';
          g.addEventListener('click', function () {
            state.opts.contextOnly = false;
            syncOptButtons();
            save(KEYS.opts, JSON.stringify(state.opts));
            runDiff();
          });
          frag.appendChild(g);
          return;
        }
        var block = result.blocks[item.index];
        if (item.type === 'block') {
          appendBlock(frag, block);
        } else if (item.type === 'head') {
          appendBlock(frag, {
            kind: 'equal',
            aLines: block.aLines.slice(0, item.count),
            bLines: block.bLines.slice(0, item.count)
          });
        } else {
          appendBlock(frag, {
            kind: 'equal',
            aLines: block.aLines.slice(-item.count),
            bLines: block.bLines.slice(-item.count)
          });
        }
      });
    } else {
      var drawn = 0;
      for (var i = 0; i < result.blocks.length; i++) {
        if (drawn >= RENDER_LIMIT) {
          var more = document.createElement('div');
          more.className = 'empty-note';
          more.textContent = '内容较长，仅显示前 ' + RENDER_LIMIT + ' 行（导出 HTML 可查看完整差异）';
          frag.appendChild(more);
          break;
        }
        drawn += appendBlock(frag, result.blocks[i], RENDER_LIMIT - drawn);
      }
    }

    body.appendChild(frag);
  }

  /** 把差异块追加到容器；cap 控制本次最多追加多少行 */
  function appendBlock(frag, block, capLimit) {
    var drawn = 0;
    var cap = capLimit === undefined ? Infinity : capLimit;

    if (state.view === 'unified') {
      if (block.kind === 'equal') {
        for (var i = 0; i < block.aLines.length && drawn < cap; i++) {
          frag.appendChild(unifiedRow('', block.aLines[i].no, block.bLines[i] ? block.bLines[i].no : '', block.aLines[i].text, false, false));
          drawn++;
        }
      } else if (block.kind === 'insert') {
        block.bLines.forEach(function (l) {
          if (drawn >= cap) return;
          frag.appendChild(unifiedRow('u-add', '', l.no, l.text, false, false));
          drawn++;
        });
      } else if (block.kind === 'delete') {
        block.aLines.forEach(function (l) {
          if (drawn >= cap) return;
          frag.appendChild(unifiedRow('u-del', l.no, '', l.text, false, false));
          drawn++;
        });
      } else {
        block.aLines.forEach(function (l) {
          if (drawn >= cap) return;
          frag.appendChild(unifiedRow('u-del', l.no, '', l.text, true, false));
          drawn++;
        });
        block.bLines.forEach(function (l) {
          if (drawn >= cap) return;
          frag.appendChild(unifiedRow('u-add', '', l.no, l.text, false, true));
          drawn++;
        });
      }
      return drawn;
    }

    /* 并排视图 */
    var max = Math.max(block.aLines.length, block.bLines.length);
    for (var k = 0; k < max && drawn < cap; k++) {
      var la = block.aLines[k] || null;
      var lb = block.bLines[k] || null;
      frag.appendChild(splitRow(block, la, lb));
      drawn++;
    }
    return drawn;
  }

  function diffRowClass(block) {
    if (block.kind === 'insert') return 'row-add';
    if (block.kind === 'delete') return 'row-del';
    if (block.kind === 'modify') return 'row-mod';
    return '';
  }

  function splitRow(block, la, lb) {
    var row = document.createElement('div');
    row.className = 'diff-row ' + diffRowClass(block) + (block.kind !== 'equal' ? ' is-change' : '');
    if (block.kind !== 'equal') row.setAttribute('data-change', '1');

    row.appendChild(splitCell('left', la, block.kind === 'modify' || block.kind === 'delete'));
    row.appendChild(splitCell('right', lb, block.kind === 'modify' || block.kind === 'insert'));
    return row;
  }

  function splitCell(side, line, isChanged) {
    var cell = document.createElement('div');
    cell.className = 'diff-cell ' + side + (line ? '' : ' empty');
    if (!line) { cell.classList.add('row-empty'); }

    var no = document.createElement('span');
    no.className = 'cell-no';
    no.textContent = line ? String(line.no) : '';
    if (!state.opts.showLineNo) no.style.visibility = 'hidden';

    var sign = document.createElement('span');
    sign.className = 'cell-sign';
    sign.textContent = line ? ((side === 'left') ? '−' : '+') : '';

    var code = document.createElement('span');
    code.className = 'cell-code';
    if (line) fillCode(code, line.text, line.segments, side === 'left' ? 'del' : 'ins');
    else code.textContent = '';

    cell.appendChild(no);
    cell.appendChild(sign);
    cell.appendChild(code);
    return cell;
  }

  /** 把文本（可选带字符级分段）写入元素 */
  function fillCode(target, text, segments, markClass) {
    if (!segments || !segments.length) {
      target.textContent = text;
      return;
    }
    segments.forEach(function (seg) {
      if (seg.marked) {
        var mark = document.createElement('mark');
        mark.className = markClass;
        mark.textContent = seg.text;
        target.appendChild(mark);
      } else {
        target.appendChild(document.createTextNode(seg.text));
      }
    });
  }

  function unifiedRow(cls, aNo, bNo, text, markDel, markIns) {
    var row = document.createElement('div');
    row.className = 'unified-row ' + (cls || '') + (cls ? ' is-change' : '');
    if (cls) row.setAttribute('data-change', '1');

    var no1 = document.createElement('span');
    no1.className = 'u-no';
    no1.textContent = aNo === '' || !state.opts.showLineNo ? '' : String(aNo);

    var no2 = document.createElement('span');
    no2.className = 'u-no second';
    no2.textContent = bNo === '' || !state.opts.showLineNo ? '' : String(bNo);

    var sign = document.createElement('span');
    sign.className = 'u-sign';
    sign.textContent = cls === 'u-add' ? '+' : (cls === 'u-del' ? '−' : ' ');

    var code = document.createElement('span');
    code.className = 'u-code';
    code.textContent = text;

    row.appendChild(no1);
    row.appendChild(no2);
    row.appendChild(sign);
    row.appendChild(code);
    return row;
  }

  /* ---------- 导航 ---------- */
  function changeRows() {
    return els.diffBody.querySelectorAll('[data-change]');
  }

  function updateNav() {
    var rows = changeRows();
    if (!rows.length) {
      els.navPos.textContent = '—';
      return;
    }
    if (state.changeIndex >= rows.length) state.changeIndex = 0;
    els.navPos.textContent = (state.changeIndex + 1) + ' / ' + rows.length;
  }

  function gotoChange(delta) {
    var rows = changeRows();
    if (!rows.length) { toast('没有改动可以跳转'); return; }
    state.changeIndex = (state.changeIndex + delta + rows.length) % rows.length;
    rows.forEach(function (r) { r.classList.remove('is-target'); });
    var target = rows[state.changeIndex];
    target.classList.add('is-target');
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateNav();
  }

  /* =======================================================================
     七、导出
     ======================================================================= */
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  function currentPatch() {
    var result = state.result;
    if (!result || !result.stats.changeGroups) return '';
    return buildPatch(result.blocks, els.patchLeft.value || '原版本.txt', els.patchRight.value || '新版本.txt');
  }

  /* =======================================================================
     八、选项与事件
     ======================================================================= */
  function syncOptButtons() {
    Array.prototype.forEach.call(els.optbar.querySelectorAll('[data-opt]'), function (btn) {
      var key = btn.getAttribute('data-opt');
      btn.setAttribute('aria-pressed', String(!!state.opts[key]));
    });
  }

  function setView(view) {
    state.view = view;
    save(KEYS.view, view);
    els.workspace.setAttribute('data-view', view);
    Array.prototype.forEach.call(els.viewTabs.querySelectorAll('.tab'), function (t) {
      var on = t.getAttribute('data-view') === view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (state.result) {
      renderDiff(state.result);
      state.changeIndex = 0;
      updateNav();
    }
  }

  function bind() {
    els.viewTabs.addEventListener('click', function (ev) {
      var tab = ev.target.closest('.tab');
      if (tab) setView(tab.getAttribute('data-view'));
    });

    els.optbar.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-opt]');
      if (!btn) return;
      var key = btn.getAttribute('data-opt');
      state.opts[key] = !state.opts[key];

      // 「忽略所有空白」与「忽略首尾空白」互斥
      if (key === 'ignoreAllSpace' && state.opts.ignoreAllSpace) state.opts.ignoreSpace = false;
      if (key === 'ignoreSpace' && state.opts.ignoreSpace) state.opts.ignoreAllSpace = false;

      syncOptButtons();
      save(KEYS.opts, JSON.stringify(state.opts));
      runDiff();
    });

    els.leftText.addEventListener('input', scheduleDiff);
    els.rightText.addEventListener('input', scheduleDiff);

    [els.leftText, els.rightText].forEach(function (ta) {
      ta.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Tab') return;
        ev.preventDefault();
        var s = ta.selectionStart, e = ta.selectionEnd;
        ta.setRangeText('  ', s, e, 'end');
        scheduleDiff();
      });
    });

    els.prevBtn.addEventListener('click', function () { gotoChange(-1); });
    els.nextBtn.addEventListener('click', function () { gotoChange(1); });

    els.swapBtn.addEventListener('click', function () {
      var l = els.leftText.value;
      els.leftText.value = els.rightText.value;
      els.rightText.value = l;
      scheduleDiff();
      toast('已交换左右内容');
    });

    els.sampleBtn.addEventListener('click', function () {
      els.leftText.value = SAMPLE_LEFT;
      els.rightText.value = SAMPLE_RIGHT;
      scheduleDiff();
      toast('已载入示例对比');
    });

    els.exportHtmlBtn.addEventListener('click', function () {
      var r = state.result;
      if (!r || !r.blocks.length) { toast('还没有可导出的对比结果'); return; }
      download('diff-report-' + stamp() + '.html',
        buildStandaloneHtml(r.blocks, r.stats, '原文', '新文'), 'text/html');
      toast('已导出对比报告');
    });

    els.copyPatchBtn.addEventListener('click', function () {
      var patch = currentPatch();
      if (!patch) { toast('没有差异，无需生成补丁'); return; }
      els.patchPre.textContent = patch;
      els.patchOverlay.hidden = false;
    });

    els.patchClose.addEventListener('click', function () { els.patchOverlay.hidden = true; });
    els.patchOverlay.addEventListener('click', function (ev) {
      if (ev.target === els.patchOverlay) els.patchOverlay.hidden = true;
    });
    els.patchCopyBtn.addEventListener('click', function () {
      copyText(currentPatch() || els.patchPre.textContent, '补丁已复制');
    });
    els.patchDownloadBtn.addEventListener('click', function () {
      var patch = currentPatch();
      if (!patch) { toast('没有差异'); return; }
      download('changes-' + stamp() + '.patch', patch, 'text/plain');
      toast('已下载 .patch');
    });
    [els.patchLeft, els.patchRight].forEach(function (input) {
      input.addEventListener('input', function () {
        if (!els.patchOverlay.hidden) els.patchPre.textContent = currentPatch();
      });
    });

    els.clearBtn.addEventListener('click', function () {
      if (!els.leftText.value && !els.rightText.value) { toast('已经是空的啦'); return; }
      if (!window.confirm('确定清空左右两侧内容吗？')) return;
      els.leftText.value = '';
      els.rightText.value = '';
      save(KEYS.left, '');
      save(KEYS.right, '');
      updateSideStats();
      runDiff();
      toast('已清空');
    });

    /* 粘贴 / 清空 单侧 */
    function pasteInto(ta) {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (text) {
          if (!text) { toast('剪贴板是空的'); return; }
          ta.value = text;
          scheduleDiff();
          toast('已粘贴 ' + text.length + ' 字符');
        }, function () {
          ta.focus();
          toast('无法读取剪贴板，请手动粘贴');
        });
      } else {
        ta.focus();
        toast('请手动粘贴（Ctrl/⌘+V）');
      }
    }
    els.leftPasteBtn.addEventListener('click', function () { pasteInto(els.leftText); });
    els.rightPasteBtn.addEventListener('click', function () { pasteInto(els.rightText); });
    els.leftClearBtn.addEventListener('click', function () {
      els.leftText.value = '';
      scheduleDiff();
      toast('已清空左侧');
    });
    els.rightClearBtn.addEventListener('click', function () {
      els.rightText.value = '';
      scheduleDiff();
      toast('已清空右侧');
    });

    /* 拖放：给哪一侧？按鼠标位置判断 */
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!f) return;
      ev.preventDefault();
      var rect = els.leftText.getBoundingClientRect();
      var toLeft = ev.clientX < (rect.left + rect.width);
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        if (toLeft) els.leftText.value = text;
        else els.rightText.value = text;
        scheduleDiff();
        toast('已载入 ' + f.name + ' → ' + (toLeft ? '原文' : '新文'));
      };
      reader.onerror = function () { toast('文件读取失败'); };
      reader.readAsText(f, 'utf-8');
    });

    /* 快捷键 */
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') els.patchOverlay.hidden = true;
      if (ev.altKey && ev.key === 'ArrowDown') { ev.preventDefault(); gotoChange(1); }
      if (ev.altKey && ev.key === 'ArrowUp') { ev.preventDefault(); gotoChange(-1); }
    });
    els.diffScroll.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); gotoChange(1); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); gotoChange(-1); }
    });
  }

  /* =======================================================================
     九、启动
     ======================================================================= */
  function init() {
    // 恢复选项
    var savedOpts = null;
    try { savedOpts = JSON.parse(load(KEYS.opts) || 'null'); } catch (e) { savedOpts = null; }
    if (savedOpts && typeof savedOpts === 'object') {
      Object.keys(state.opts).forEach(function (k) {
        if (typeof savedOpts[k] === 'boolean') state.opts[k] = savedOpts[k];
      });
    }
    syncOptButtons();

    // 恢复内容
    var savedLeft = load(KEYS.left);
    var savedRight = load(KEYS.right);
    if (savedLeft === null && savedRight === null) {
      els.leftText.value = SAMPLE_LEFT;
      els.rightText.value = SAMPLE_RIGHT;
    } else {
      els.leftText.value = savedLeft || '';
      els.rightText.value = savedRight || '';
    }
    save(KEYS.left, els.leftText.value);
    save(KEYS.right, els.rightText.value);

    setView(load(KEYS.view) === 'unified' ? 'unified' : 'split');
    bind();
    updateSideStats();
    runDiff();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
