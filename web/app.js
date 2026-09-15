/* ==========================================================================
 * 深信服案例库导出工具 · 前端逻辑
 *
 * 与原 userscript 版本相比：
 *   - 网络层改为调用本地服务的 /api/proxy 转发，绕开目标站点的跨域限制；
 *     因此不再需要浏览器登录态，也不需要任何脚本管理器。
 *   - 界面从「页面浮动面板」改为独立的一整页。
 *   - 解析 / 排版 / 导出逻辑（SFCaseFmt）与原实现完全一致，保证既有行为不走样。
 * ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
   * 0. 常量与配置
   * 接口来源：对 support.sangfor.com.cn 案例列表页 / 详情页的抓包分析
   * ========================================================================== */

  const ORIGIN = 'https://support.sangfor.com.cn';
  const API_BASE = ORIGIN + '/spt/openapi';

  const API = {
    productList: API_BASE + '/product/getProductList',
    moduleTree: (pid) => API_BASE + '/case/es/getCaseModuleList/' + pid,
    versionList: (pid) => API_BASE + '/case/es/getProductVersionList/' + pid,
    search: API_BASE + '/case/es/search',
    detail: (id) => API_BASE + '/case/es/getDetailById/' + id,
  };

  const DETAIL_URL = (pid, sourceId) =>
    ORIGIN + '/cases/list?product_id=' + pid + '&type=1&category_id=' + sourceId + '&isOpen=true';

  // 断点缓存的命名空间。结构变化时改版本号，避免读到旧格式的脏数据。
  const K_STORE = 'sfCaseExporter:v2';

  const defaults = {
    productLineId: '',
    keyword: '',
    mainModuleIds: [],
    childModuleIds: [],
    versionId: '',
    pageSize: 20,
    maxPages: 0, // 0 = 全部
    concurrency: 3,
    interval: 400, // ms
    fetchDetail: true,
    detailConcurrency: 4,
    resume: false,
    onlyRecent: '', // '7d' | '30d' | '90d' | '180d' | '365d' | ''
    imageMode: 'link', // 'link' = 保留外链 | 'embed' = 下载内嵌为 base64（可离线）
    htmlPartSize: 0, // HTML 分卷：每个文件多少条，0 = 单文件
  };

  let cfg = Object.assign({}, defaults);

  const state = {
    running: false,
    paused: false,
    cancelToken: 0,
    totalPages: 0,
    donePages: 0,
    listRows: [],
    detailDone: 0,
    total: 0,
    startedAt: 0,
    productCache: null,
    moduleCache: {},
    versionCache: {},
    productNameMap: {}, // productLineId -> name
    versionNameMap: {}, // versionId -> code
    imgPlaceholders: 0, // 正文里无法还原的图片占位符数量
  };

  /* ------------------------------------------------------------------
   * 0.5 正文格式化模块 SFCaseFmt
   * 案例正文的章节标题藏在 <input value="*问题描述"> 里（tinymce 只读输入框），
   * 普通去标签会丢掉整个章节结构；这里用 DOM 解析还原，并输出 Markdown / 单文件 HTML。
   * ------------------------------------------------------------------ */
const SFCaseFmt = (function () {
  'use strict';


function getDoc(html) {
  if (typeof DOMParser === 'undefined') throw new Error('no DOM implementation');
  return new DOMParser().parseFromString(html || '', 'text/html');
}

const BLOCK_TAGS = { ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, DD: 1, DIV: 1, DL: 1, DT: 1,
  FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  HEADER: 1, HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, TABLE: 1, TD: 1, TH: 1,
  TR: 1, UL: 1, TBODY: 1, THEAD: 1 };
const VOID_TAGS = { AREA: 1, BASE: 1, BR: 1, COL: 1, EMBED: 1, HR: 1, IMG: 1, INPUT: 1,
  LINK: 1, META: 1, PARAM: 1, SOURCE: 1, TRACK: 1, WBR: 1 };

function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tidy(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// MD 特殊字符转义（内联文本）
function escInline(s) {
  return String(s || '').replace(/([\\`*_[\]])/g, '\\$1');
}

// 编辑器有时只留下 IMG_xxx 这类图片 ID 占位符，源站自己也无法还原成真实地址。
// 若按相对路径补全，就会拼出 https://support.sangfor.com.cn/IMG_xxx 这种假链接，
// 因此这里显式识别为「没有真实地址」，导出时标注出来而不是给出坏图。
function isImgPlaceholder(u) {
  return /^IMG_[A-Za-z0-9_-]+$/i.test(String(u || '').trim());
}

function isGoodUrl(u) {
  if (isImgPlaceholder(u)) return false;
  return /^(https?:)?\/\//i.test(u || '') || /^data:image\//i.test(u || '');
}

// 把相对 / 协议相对路径补全为绝对地址（基于站点根 ORIGIN）。
// 案例正文里的图片常写成 /_static/... 这种站点根相对路径，
// 导出成独立 HTML/MD 后浏览器会按 file:// 解析而打不开，必须补全为
// https://support.sangfor.com.cn/_static/... 才能正常显示。
function toAbs(url) {
  if (!url) return url;
  url = String(url).trim();
  if (/^https?:\/\//i.test(url)) return url;        // 已是绝对地址
  if (/^\/\//i.test(url)) return 'https:' + url;     // 协议相对 //host → https://host
  if (/^data:/i.test(url) || /^blob:/i.test(url)) return url; // 内嵌资源
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;  // 其它 scheme（mailto:、javascript: 等）保持原样
  if (url.charAt(0) === '/') return ORIGIN + url;    // 站点根相对 /_static/...
  return ORIGIN + '/' + url;                         // 其它相对路径
}

/* ---------------------------------------------------------------- 内联渲染 */
function inline(node, ctx) {
  let out = '';
  (node.childNodes || []).forEach((n) => {
    if (n.nodeType === 3) {
      out += n.nodeValue.replace(/\s+/g, ' ');
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toUpperCase();
    if (tag === 'BR') { out += '  \n'; return; }
    if (tag === 'IMG') {
      const raw = n.getAttribute('src') || '';
      const alt = n.getAttribute('alt') || '截图';
      if (isImgPlaceholder(raw)) {
        ctx.placeholders.push(raw);
        out += `[原图未公开：${raw}]`;
        return;
      }
      const src = toAbs(raw);
      if (isGoodUrl(src)) {
        ctx.images.push(src);
        out += `![${alt}](${src})`;
      } else if (src) {
        out += `[图片:${src}]`;
      }
      return;
    }
    if (tag === 'A') {
      const href = n.getAttribute('href') || '';
      const txt = inline(n, ctx).trim();
      if (!txt) return;
      if (href && !/^#/.test(href) && !/^javascript:/i.test(href)) out += `[${txt}](${href})`;
      else out += txt;
      return;
    }
    if (tag === 'CODE') {
      const t = (n.textContent || '').replace(/`/g, '\\`');
      out += '`' + t + '`';
      return;
    }
    if (tag === 'STRONG' || tag === 'B') {
      const t = inline(n, ctx).trim();
      if (t) out += '**' + t + '**';
      return;
    }
    if (tag === 'EM' || tag === 'I') {
      const t = inline(n, ctx).trim();
      if (t) out += '*' + t + '*';
      return;
    }
    if (tag === 'INPUT') return; // 章节标题输入框，已单独提取
    out += inline(n, ctx);
  });
  return out;
}

/* ---------------------------------------------------------------- 块级渲染 */

// 把容器内的节点拆成「内联部分」和「列表部分」，保持文档顺序
function splitContent(node, inlineParts, nested) {
  if (node.nodeType === 1) {
    const t = node.tagName.toUpperCase();
    if (t === 'UL' || t === 'OL') { nested.push(node); return; }
    if (t === 'DIV' || t === 'P' || t === 'SECTION' || t === 'SPAN') {
      if (node.querySelector('ul,ol')) {
        Array.prototype.forEach.call(node.childNodes, (c) => splitContent(c, inlineParts, nested));
        return;
      }
    }
  }
  inlineParts.push(node);
}

function blockList(listEl, ctx, indent) {
  const isOl = listEl.tagName.toUpperCase() === 'OL';
  const start = parseInt(listEl.getAttribute('start') || '1', 10) || 1;
  const pad = ' '.repeat(indent);
  const lines = [];
  let idx = start;
  const items = Array.prototype.filter.call(listEl.children || [], (c) => c.tagName.toUpperCase() === 'LI');

  items.forEach((li) => {
    const marker = isOl ? idx++ + '. ' : '- ';
    // li 的内容分成「内联部分」和「嵌套列表部分」
    const inlineParts = [];
    const nested = [];
    Array.prototype.forEach.call(li.childNodes, (n) => splitContent(n, inlineParts, nested));

    const fake = { childNodes: inlineParts };
    let txt = tidy(inline(fake, ctx)).replace(/\n/g, ' ').trim();
    lines.push(pad + marker + txt);

    nested.forEach((sub) => {
      const subPad = pad + ' '.repeat(marker.length);
      blockList(sub, ctx, subPad.length).forEach((l) => lines.push(l));
    });
  });
  return lines;
}

function renderBlocks(root, ctx, level) {
  const out = [];
  (root.childNodes || []).forEach((n) => {
    if (n.nodeType === 3) {
      const t = tidy(decode(n.nodeValue));
      if (t.trim()) out.push(t);
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toUpperCase();

    if (tag === 'INPUT') return;
    if (tag === 'A' && n.getAttribute('data-anchor') === 'catalogue') return;
    if (tag === 'SCRIPT' || tag === 'STYLE') return;

    if (tag === 'UL' || tag === 'OL') {
      out.push(blockList(n, ctx, 0).join('\n'));
      return;
    }
    if (tag === 'PRE') {
      const code = n.querySelector('code');
      const txt = (code || n).textContent || '';
      const fence = '```';
      out.push(fence + '\n' + txt.replace(/\n+$/, '') + '\n' + fence);
      return;
    }
    if (tag === 'IMG') {
      const raw = n.getAttribute('src') || '';
      const alt = n.getAttribute('alt') || '截图';
      if (isImgPlaceholder(raw)) {
        ctx.placeholders.push(raw);
        out.push(`[原图未公开：${raw}]`);
        return;
      }
      const src = toAbs(raw);
      if (isGoodUrl(src)) { ctx.images.push(src); out.push(`![${alt}](${src})`); }
      else if (src) out.push(`[图片:${src}]`);
      return;
    }
    if (tag === 'HR') { out.push('---'); return; }
    if (/^H[1-6]$/.test(tag)) {
      const t = tidy(inline(n, ctx)).trim();
      if (t) out.push('#'.repeat(Math.min(6, level + +tag[1])) + ' ' + t);
      return;
    }
    if (tag === 'TABLE') { out.push(renderTable(n, ctx)); return; }

    if (BLOCK_TAGS[tag]) {
      const isChapter = /mceNonEditable/i.test(n.getAttribute('class') || '');
      if (isChapter) {
        const parts = renderBlocks(n, ctx, level);
        if (parts.length) out.push(parts.join('\n\n'));
        return;
      }
      const inner = renderBlocks(n, ctx, level);
      if (inner.length) out.push(inner.join('\n\n'));
      return;
    }

    // 行内级：整块作为段落
    const t = tidy(inline(n, ctx));
    if (t.trim()) out.push(t);
  });
  return out.filter((x) => x && String(x).trim());
}

function renderTable(table, ctx) {
  const rows = [];
  (table.querySelectorAll('tr') || []).forEach((tr) => {
    const cells = [];
    (tr.children || []).forEach((c) => {
      cells.push(tidy(inline(c, ctx)).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
    });
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return '';
  const cols = Math.max.apply(null, rows.map((r) => r.length));
  const norm = rows.map((r) => {
    while (r.length < cols) r.push('');
    return r;
  });
  const head = norm[0];
  const body = norm.slice(1);
  const L = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
  body.forEach((r) => L.push('| ' + r.join(' | ') + ' |'));
  return L.join('\n');
}

/* ------------------------------- 章节切分（核心，从 input[value] 还原标题） */
// 前端把「有序步骤 + 其说明」渲染成 <ol>…</ol><ul>…</ul> 两个兄弟节点，
// 语义上 ul 属于 ol 的最后一步，这里把它收进去，Markdown 才能正确缩进。
// 编辑器会给每个列表套一层 <div>，导致 ol 与其说明 ul 不是兄弟节点。
// 先把「只含单个列表、无文本」的包装 div 解包。
function unwrapListWrappers(root) {
  if (!root || !root.children) return;
  let changed = true;
  while (changed) {
    changed = false;
    Array.prototype.slice.call(root.children).forEach((c) => {
      if (c.tagName !== 'DIV') return;
      const kids = Array.prototype.filter.call(c.children, (k) => k.nodeType === 1);
      const texts = Array.prototype.filter.call(
        c.childNodes, (n) => n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()
      );
      if (kids.length === 1 && (kids[0].tagName === 'UL' || kids[0].tagName === 'OL') && !texts.length) {
        root.replaceChild(kids[0], c);
        changed = true;
      }
    });
  }
  Array.prototype.slice.call(root.children).forEach(unwrapListWrappers);
}

function normalizeSteps(root) {
  if (!root || !root.children) return;
  unwrapListWrappers(root);
  const kids = Array.prototype.slice.call(root.children || []);
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i], nk = kids[i + 1];
    if (k.tagName === 'OL' && nk && nk.tagName === 'UL') {
      const lis = k.children || [];
      const last = lis[lis.length - 1];
      if (last && last.tagName === 'LI') last.appendChild(nk);
    }
  }
  Array.prototype.slice.call(root.children || []).forEach((c) => normalizeSteps(c));
}

function sectionTitle(b) {
  let name = '';
  const inp = b.querySelector('input[value]');
  if (inp) name = decode(inp.getAttribute('value') || '');
  if (!name) {
    const a = b.querySelector('a[data-text]');
    if (a) name = decode(a.getAttribute('data-text') || '');
  }
  return name.replace(/^\s*\*+\s*/, '').trim(); // 去掉必填星号
}

function extractSections(html) {
  const doc = getDoc(html);
  const root = doc.body;
  const sections = [];

  // 章节块：div[class*=mceNonEditable]，标题来自内部 input[value] 或 a[data-text]
  const blocks = root.querySelectorAll('div[class*="mceNonEditable"]');
  if (blocks && blocks.length) {
    blocks.forEach((b) => {
      // 跳过嵌套在其它章节块里的容器，只取最外层
      if (b.parentElement && b.parentElement.closest('div[class*="mceNonEditable"]')) return;
      sections.push({ name: sectionTitle(b), node: b });
    });
  }

  // 兜底：没有识别到章节就把整体当一段
  if (!sections.length) {
    sections.push({ name: '', node: root });
    return sections;
  }

  // 章节块之外可能还有零散内容（如开头的 case-tinymce-wrap 包裹层）
  return sections;
}

/* ------------------------------------------------------------- 对外：解析 */
function parseCase(html) {
  const ctx = { images: [], placeholders: [] };
  const sections = extractSections(html).map((s) => {
    const body = s.node.cloneNode(true);
    // 移除标题输入框与目录锚点，避免混进正文
    (body.querySelectorAll('input') || []).forEach((i) => i.remove());
    (body.querySelectorAll('a[data-anchor="catalogue"]') || []).forEach((a) => a.remove());
    normalizeSteps(body);
    const parts = renderBlocks(body, ctx, 0);
    return { name: s.name, md: parts.join('\n\n').trim() };
  }).filter((s) => s.md);

  return {
    sections,
    images: ctx.images.slice(),
    placeholders: ctx.placeholders.slice(),
    markdown: sections.map((s) => (s.name ? '### ' + s.name + '\n\n' : '') + s.md).join('\n\n'),
  };
}

/* -------------------------------------------------- 对外：正文转纯文本 */
function plainText(html) {
  const p = parseCase(html);
  return p.markdown
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt) => '[图片: ' + (alt || '截图') + ']')
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .trim();
}

/* ------------------------------------------- 对外：清洗后的正文 HTML 片段 */
function cleanHtml(html) {
  const doc = getDoc(html);
  const root = doc.body;
  (root.querySelectorAll('a[data-anchor="catalogue"]') || []).forEach((a) => a.remove());
  normalizeSteps(root);
  const blocks = root.querySelectorAll('div[class*="mceNonEditable"]');
  (blocks || []).forEach((b) => {
    if (b.parentElement && b.parentElement.closest('div[class*="mceNonEditable"]')) return;
    const inp = b.querySelector('input[value]');
    const name = sectionTitle(b);
    if (inp) inp.remove();
    if (name) {
      const h = doc.createElement('h3');
      h.textContent = name;
      b.insertBefore(h, b.firstChild);
    }
  });
  (root.querySelectorAll('[contenteditable]') || []).forEach((n) => n.removeAttribute('contenteditable'));
  (root.querySelectorAll('input,script,style') || []).forEach((n) => n.remove());
  (root.querySelectorAll('img') || []).forEach((img) => {
    const s = img.getAttribute('src');
    // 源站只有编辑器占位符、没有真实地址的图片：换成一枚可读提示，避免留下坏图
    if (s && isImgPlaceholder(s)) {
      const span = doc.createElement('span');
      span.className = 'img-missing';
      span.textContent = '[原图未公开：' + s + ']';
      if (img.parentNode) img.parentNode.replaceChild(span, img);
      return;
    }
    if (s) img.setAttribute('src', toAbs(s)); // 相对路径补全为绝对地址，否则本地打开 HTML 图片失效
    img.setAttribute('style', 'max-width:100%;height:auto;border:1px solid #e3e6ec;border-radius:6px;margin:6px 0');
    img.setAttribute('loading', 'lazy');
  });
  return root.innerHTML;
}

/* --------------------------------------------- 对外：生成单文件 HTML 文档 */
// 版本可能有几十个，全文列出会把元信息行撑爆，这里做折叠
function shortVersions(s, keep) {
  if (!s) return '';
  const parts = String(s).split(/\s*\|\s*/).filter(Boolean);
  keep = keep || 3;
  if (parts.length <= keep + 1) return parts.join(' ｜ ');
  return parts.slice(0, keep).join(' ｜ ') + ` 等 ${parts.length} 个版本`;
}

function buildHtmlDoc(rows, meta, opts) {
  opts = opts || {};
  const title = (meta && meta.title) || '深信服案例库导出';
  const pageSize = opts.pageSize || 20;

  // 预清洗正文；把 img 的 src 换成 data-src，翻到哪一页才加载哪页的图
  const payload = rows.map((r) => {
    let h = r.detail_html
      ? cleanHtml(r.detail_html)
      : '<p>' + esc(r.summary || '').replace(/\n/g, '<br>') + '</p>';
    h = h.replace(/(<img\b[^>]*?)\ssrc="([^"]*)"/gi, '$1 data-src="$2"');
    return {
      t: r.title || '(无标题)',
      p: r.product_name || '',
      m: r.child_modules || r.main_modules || '',
      v: shortVersions(r.version_codes),
      s: r.suite_version || '',
      u: r.update_time || '',
      id: r.case_id || '',
      url: r.url || '',
      h: h,
      img: (h.match(/data-src=/g) || []).length,
    };
  });

  // 防止正文里出现 </script> 提前闭合，同时处理 JSON 中的行分隔符
  const dataJson = JSON.stringify(payload)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const sub = [
    '共 ' + rows.length + ' 条',
    '导出时间 ' + esc(new Date().toLocaleString('zh-CN')),
    opts.embeddedImages ? '图片已内嵌（可离线阅读）' : '',
    opts.part ? '第 ' + opts.part + ' 卷' : '',
  ].filter(Boolean).join(' ｜ ');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bd:#e3e6ec;--fg:#1f2329;--mu:#6b7280;--ac:#1a6fd4}
*{box-sizing:border-box}
body{margin:0;font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);background:#f5f6f8}
header{background:#fff;border-bottom:1px solid var(--bd);padding:16px 24px}
header h1{margin:0 0 4px;font-size:20px}
header .sub{color:var(--mu);font-size:12.5px}
.bar{position:sticky;top:0;z-index:9;background:#fff;border-bottom:1px solid var(--bd);
padding:10px 24px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bar input[type=search]{flex:1;min-width:180px;max-width:340px;padding:6px 10px;border:1px solid var(--bd);
border-radius:6px;font-size:13px;outline:none}
.bar input[type=search]:focus{border-color:var(--ac)}
.bar button{background:#f2f4f7;border:1px solid var(--bd);border-radius:6px;padding:5px 11px;
font-size:13px;cursor:pointer;color:#334}
.bar button:hover:not(:disabled){background:#e6ebf3;border-color:var(--ac)}
.bar button:disabled{opacity:.4;cursor:default}
.bar select{padding:5px 6px;border:1px solid var(--bd);border-radius:6px;font-size:13px}
.bar .info{color:var(--mu);font-size:12.5px;margin-left:auto}
main{max-width:960px;margin:0 auto;padding:16px 16px 90px}
nav.toc{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:10px 16px;margin-bottom:14px}
nav.toc h3{margin:0 0 6px;font-size:13px;color:var(--mu);font-weight:600}
nav.toc ol{margin:0;padding-left:22px;columns:2;column-gap:26px}
nav.toc li{font-size:13px;break-inside:avoid;margin:2px 0}
nav.toc a{color:var(--ac);text-decoration:none}
nav.toc a:hover{text-decoration:underline}
nav.toc .tocmore{color:var(--mu);font-size:12px;margin-top:6px;padding-left:2px}
article.case{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:18px 24px;margin-bottom:14px;
content-visibility:auto;contain-intrinsic-size:auto 480px}
article.case h2{font-size:17px;margin:0 0 10px;padding-bottom:8px;border-bottom:2px solid var(--ac);line-height:1.5}
.meta{color:var(--mu);font-size:12.5px;margin-bottom:12px;padding:8px 12px;background:#f8f9fb;border-radius:6px}
.meta a{color:var(--ac);text-decoration:none}
.body h3{font-size:15.5px;margin:22px 0 8px;color:var(--ac);border-left:4px solid var(--ac);padding-left:9px}
.body p{margin:8px 0}
.body ul,.body ol{margin:8px 0;padding-left:26px}
.body li{margin:4px 0}
.body pre{background:#f6f8fa;border:1px solid var(--bd);border-radius:6px;padding:12px;overflow:auto;font:13px/1.6 Menlo,Consolas,monospace}
.body code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:13px}
.body img{max-width:100%;border:1px solid var(--bd);border-radius:6px;margin:6px 0;background:#fafbfc;min-height:24px}
mark{background:#ffe9a8;padding:0 2px;border-radius:2px}
.img-missing{display:inline-block;color:#c77700;background:#fff6e5;border:1px dashed #f0cfa0;
  border-radius:6px;padding:6px 10px;font-size:13px}
.empty{text-align:center;color:var(--mu);padding:60px 0}
@media print{.bar,nav.toc{display:none}body{background:#fff}
article.case{break-inside:avoid;border:none;padding:0 0 12px;content-visibility:visible}
.body img{page-break-inside:avoid}}
</style></head>
<body>
<header>
<h1>${esc(title)}</h1>
<div class="sub">${sub}</div>
</header>
<div class="bar">
<input type="search" id="q" placeholder="搜索标题 / 产品线 / 模块…" oninput="onSearch(this.value)">
<button onclick="go(1)" id="b-first">« 首页</button>
<button onclick="go(st.page-1)" id="b-prev">‹ 上一页</button>
<button onclick="go(st.page+1)" id="b-next">下一页 ›</button>
<button onclick="go(pages())" id="b-last">末页 »</button>
<select onchange="setSize(this.value)" id="sel-size">
  <option value="10">10 条/页</option>
  <option value="20" selected>20 条/页</option>
  <option value="50">50 条/页</option>
  <option value="100">100 条/页</option>
</select>
<button onclick="toggleAll()" id="b-all">展开全部（便于打印）</button>
<span class="info" id="info"></span>
</div>
<main>
<nav class="toc" id="toc"></nav>
<div id="list"></div>
</main>
<script id="sfc-data" type="application/json">${dataJson}</script>
<script>
var DATA = JSON.parse(document.getElementById('sfc-data').textContent);
DATA.forEach(function(d,i){ d._i = i; d._s = (d.t+' '+d.p+' '+d.m+' '+d.id).toLowerCase(); });

var st = { q: '', page: 1, size: ${pageSize}, all: false, lazy: true };
var CARD_CACHE = {}, CARD_N = 0, TOC_MAX = 400;
var IMG_OBS = null, BODY_OBS = null, searchTimer = null;

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function hl(s){
var t = esc(s);
if(!st.q) return t;
try{ return t.replace(new RegExp('('+st.q.replace(/[.*+?^\${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>') }catch(e){ return t }
}
/* 搜索索引在加载时一次性算好，避免每次输入都重新拼接/转小写 */
function filtered(){
if(!st.q) return DATA;
var q = st.q.toLowerCase();
return DATA.filter(function(d){ return d._s.indexOf(q) >= 0 });
}
function pages(){ return st.all ? 1 : Math.max(1, Math.ceil(filtered().length / st.size)) }
function metaOf(d){
var ml = [d.p?'产品线：'+esc(d.p):'', d.m?'模块：'+esc(d.m):'', d.v?'适用版本：'+esc(d.v):'',
          d.s?'架构：'+esc(d.s):'', d.u?'更新：'+esc(d.u):''].filter(Boolean).join(' ｜ ');
return (ml ? '<div>' + ml + '</div>' : '') +
  '<div>案例ID：' + esc(d.id) +
  (d.url ? ' ｜ <a href="' + esc(d.url) + '" target="_blank" rel="noopener">在官网打开 ↗</a>' : '') +
  '</div>';
}

/* ------------------------------------------------------------------
 * 性能：正文与图片都不再一次性塞进 DOM
 *  - 卡片骨架（标题+元信息）先渲染，正文等卡片接近视口才注入
 *  - 图片等接近视口才设置 src，避免上百张图同时解码
 *  - 注入按帧分批，避免一次 innerHTML 阻塞主线程
 * ------------------------------------------------------------------ */
function observeImages(root){
var imgs = root.querySelectorAll('img[data-src]');
for(var i=0;i<imgs.length;i++){
  if(IMG_OBS){ IMG_OBS.observe(imgs[i]); }
  else { var s = imgs[i].getAttribute('data-src'); if(s){ imgs[i].src = s; imgs[i].removeAttribute('data-src'); } }
}
}
function fillBody(node, d){
if(!node || node._filled || !d) return;
node._filled = true;
node.innerHTML = d.h;
observeImages(node);
}
function injectChunked(arts, start, step){
if(!arts || start >= arts.length) return;
var end = Math.min(arts.length, start + (step || 4));
for(var i=start;i<end;i++){
  var a = arts[i];
  if(a && a._body) fillBody(a._body, a._d);
}
if(end < arts.length) requestAnimationFrame(function(){ injectChunked(arts, end, step) });
}
function initObservers(){
if(typeof IntersectionObserver === 'undefined') return;
IMG_OBS = new IntersectionObserver(function(es){
  for(var i=0;i<es.length;i++){
    var e = es[i];
    if(!e.isIntersecting) continue;
    var im = e.target, src = im.getAttribute('data-src');
    if(src){ im.src = src; im.removeAttribute('data-src'); }
    IMG_OBS.unobserve(im);
  }
}, { rootMargin: '600px 0px' });
BODY_OBS = new IntersectionObserver(function(es){
  var hit = [];
  for(var i=0;i<es.length;i++){
    var e = es[i];
    if(!e.isIntersecting) continue;
    BODY_OBS.unobserve(e.target);
    hit.push(e.target);
  }
  if(hit.length) injectChunked(hit, 0, 4);
}, { rootMargin: '700px 0px' });
}
function clearCardCache(){
for(var k in CARD_CACHE){
  var o = CARD_CACHE[k];
  if(o && BODY_OBS){ try{ BODY_OBS.unobserve(o) }catch(e){} }
}
CARD_CACHE = {}; CARD_N = 0;
}
function newCard(d){
var el = document.createElement('article');
el.className = 'case';
el.innerHTML = '<h2></h2><div class="meta"></div><div class="body"></div>';
el._h2 = el.children[0]; el._meta = el.children[1]; el._body = el.children[2];
el._d = d;
el._meta.innerHTML = metaOf(d);
return el;
}
/* 卡片 DOM 复用：翻回上一页时直接搬回来，不重新解析正文、图片也不闪 */
function cardOf(d, idx){
var el = CARD_CACHE[d._i];
if(!el){
  el = newCard(d);
  if(CARD_N > 260) clearCardCache();
  CARD_CACHE[d._i] = el; CARD_N++;
}
el.id = 'case-' + (idx + 1);
el._h2.innerHTML = (idx + 1) + '. ' + hl(d.t);
return el;
}
function setupCards(box){
var arr = Array.prototype.slice.call(box.querySelectorAll('article.case'));
if(!arr.length) return;
if(!st.lazy || !BODY_OBS){ injectChunked(arr, 0, 20); return; }
for(var i=0;i<arr.length;i++){
  var a = arr[i];
  if(a._body && !a._body._filled) BODY_OBS.observe(a);
}
}
function render(){
var all = filtered();
if(st.page > pages()) st.page = pages();
if(st.page < 1) st.page = 1;
var start = st.all ? 0 : (st.page-1)*st.size;
var end = st.all ? all.length : Math.min(all.length, start + st.size);
var slice = all.slice(start, end);

var box = document.getElementById('list');
var toc = document.getElementById('toc');

if(!slice.length){
  box.textContent = '';
  box.innerHTML = '<div class="empty">没有匹配的案例</div>';
  toc.style.display = 'none';
} else {
  var frag = document.createDocumentFragment();
  var tl = [];
  for(var i=0;i<slice.length;i++){
    var d = slice[i], no = start + i + 1;
    frag.appendChild(cardOf(d, start + i));
    if(i < TOC_MAX) tl.push('<li><a href="#case-' + no + '">' + no + '. ' + esc(d.t.slice(0,44)) + '</a></li>');
  }
  box.textContent = '';
  box.appendChild(frag);
  toc.style.display = '';
  toc.innerHTML = '<h3>本页目录' +
    (st.all ? '（全部）' : '（第 ' + (start+1) + '-' + end + ' 条，共 ' + all.length + ' 条）') +
    '</h3><ol>' + tl.join('') + '</ol>' +
    (slice.length > TOC_MAX ? '<div class="tocmore">… 目录仅列出前 ' + TOC_MAX + ' 条，共 ' + slice.length + ' 条</div>' : '');
  setupCards(box);
}

document.getElementById('info').textContent =
  (all.length === 0 ? '共 0 条'
    : st.all ? '全部 ' + all.length + ' 条'
    : '第 ' + (start + 1) + '-' + end + ' 条 / 共 ' + all.length + ' 条')
  + (st.q ? '（已搜索「' + st.q + '」）' : '');
var last = st.all || st.page >= pages();
document.getElementById('b-first').disabled = st.all || st.page <= 1;
document.getElementById('b-prev').disabled  = st.all || st.page <= 1;
document.getElementById('b-next').disabled  = last;
document.getElementById('b-last').disabled  = last;
syncAllBtn();
try { window.scrollTo(0, 0); } catch (e) {}
}
function syncAllBtn(){
var b = document.getElementById('b-all');
if(!b) return;
b.textContent = st.all ? '⤡ 收起（回到分页）' : '展开全部（便于打印）';
}
function go(p){ st.page = p; render() }
function onSearch(v){
st.q = (v||'').trim(); st.page = 1; st.all = false; st.lazy = true;
clearTimeout(searchTimer);
searchTimer = setTimeout(render, 220); /* 输入防抖，避免逐字重建 DOM */
}
function setSize(v){ st.size = parseInt(v,10)||20; st.page = 1; st.all = false; st.lazy = true; render() }
function toggleAll(){
if(st.all){ st.all = false; st.lazy = true; render(); return; }
var n = filtered().length;
if(n > 600 && !confirm('共 ' + n + ' 条，展开全部将一次性渲染所有正文，可能较慢。\\n建议仅在小批量或打印前使用。是否继续？')) return;
st.all = true; st.lazy = false; render();
}
/* 直接 Ctrl+P 时，把当前页尚未注入的正文补齐，避免打印出空白 */
window.addEventListener('beforeprint', function(){
if(!st.lazy) return;
var arr = document.querySelectorAll('#list article.case');
for(var i=0;i<arr.length;i++) fillBody(arr[i]._body, arr[i]._d);
});
document.addEventListener('keydown', function(e){
if(e.target && e.target.tagName === 'INPUT') return;
if(e.key === 'ArrowRight' && !document.getElementById('b-next').disabled) go(st.page+1);
if(e.key === 'ArrowLeft'  && !document.getElementById('b-prev').disabled) go(st.page-1);
});
initObservers();
render();
</script>
</body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

  return { parseCase, plainText, cleanHtml, buildHtmlDoc, shortVersions, esc, tidy,
    toAbs, isImgPlaceholder };
})();

  /* ==========================================================================
   * 1. 工具函数
   * ========================================================================== */

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, '0');

  function nowStamp() {
    const d = new Date();
    return (
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
    );
  }

  function safeName(s) {
    return (s || 'all').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  }

  function stripTags(html) {
    if (!html) return '';
    try {
      const dom = new DOMParser().parseFromString(html, 'text/html');
      return (dom.body.textContent || '')
        .replace(/[ \t\u3000]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } catch (e) {
      return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t\u3000]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  }

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function parseTime(s) {
    if (!s) return 0;
    const t = new Date(String(s).replace(/-/g, '/')).getTime();
    return isNaN(t) ? 0 : t;
  }

  function elapsedText() {
    if (!state.startedAt) return '0s';
    const s = (Date.now() - state.startedAt) / 1000;
    if (s < 60) return s.toFixed(0) + 's';
    return Math.floor(s / 60) + 'm' + pad2(Math.floor(s % 60)) + 's';
  }

  const RECENT_MAP = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };

  /* ==========================================================================
   * 2. 网络层：统一走本地服务的 /api/proxy 转发
   * 目标站点不允许跨域，浏览器直连会被 CORS 拦掉；由本地服务代发则没有这个问题，
   * 同时也就不需要任何登录态了（这些接口本身是公开的）。
   * ========================================================================== */

  async function callProxy(url, method, body) {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, method: method || 'GET', body: body || '' }),
    });
    if (!res.ok) throw new Error('本地服务异常（HTTP ' + res.status + '）');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '转发请求失败');
    return data;
  }

  function unwrap(r) {
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    let obj;
    try {
      obj = JSON.parse(r.body);
    } catch (e) {
      throw new Error('响应不是合法 JSON');
    }
    if (obj && (obj.code === 0 || obj.code === 200)) return obj;
    throw new Error('业务码异常: code=' + (obj && obj.code) + ' msg=' + (obj && obj.msg));
  }

  async function getJSON(url, retry) {
    if (retry === undefined) retry = 2;
    let lastErr;
    for (let i = 0; i <= retry; i++) {
      if (state.cancelToken < 0) throw new Error('CANCELLED');
      try {
        return unwrap(await callProxy(url, 'GET'));
      } catch (e) {
        lastErr = e;
        if (i < retry) await sleep(600 * (i + 1));
      }
    }
    throw lastErr;
  }

  async function postJSON(url, payload, retry) {
    if (retry === undefined) retry = 2;
    let lastErr;
    for (let i = 0; i <= retry; i++) {
      if (state.cancelToken < 0) throw new Error('CANCELLED');
      try {
        return unwrap(await callProxy(url, 'POST', JSON.stringify(payload)));
      } catch (e) {
        lastErr = e;
        if (i < retry) await sleep(600 * (i + 1));
      }
    }
    throw lastErr;
  }

  // 图片字节经由本地服务取回，再转成 data URL 用于内嵌
  async function fetchDataURL(url) {
    try {
      const res = await fetch('/api/image?url=' + encodeURIComponent(url));
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  /* ==========================================================================
   * 3. 并发池
   * ========================================================================== */

  async function pool(tasks, limit, onEach) {
    let idx = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      for (;;) {
        if (state.cancelToken < 0) return;
        while (state.paused) await sleep(300);
        const i = idx++;
        if (i >= tasks.length) return;
        try {
          await tasks[i]();
          if (onEach) onEach(null, i);
        } catch (e) {
          if (onEach) onEach(e, i);
        }
      }
    });
    await Promise.all(workers);
  }

  /* ==========================================================================
   * 4. 元数据：产品线 / 模块树 / 版本
   * ========================================================================== */

  async function loadProductList(force) {
    if (state.productCache && !force) return state.productCache;
    const obj = await getJSON(API.productList);
    const leaves = [];
    const walk = (nodes, trail) => {
      (nodes || []).forEach((n) => {
        state.productNameMap[n.id] = n.name;
        if (n.caseAble) leaves.push({ id: n.id, name: n.name, group: trail });
        if (n.children && n.children.length) walk(n.children, trail + ' / ' + n.name);
      });
    };
    const groups = [];
    (obj.rows || []).forEach((lv0) => {
      walk(lv0.children || [], lv0.name);
      groups.push({ id: lv0.id, name: lv0.name });
    });
    state.productCache = { leaves: leaves, groups: groups, raw: obj.rows };
    return state.productCache;
  }

  async function loadModuleTree(pid) {
    if (!pid) return [];
    if (state.moduleCache[pid]) return state.moduleCache[pid];
    const obj = await getJSON(API.moduleTree(pid));
    state.moduleCache[pid] = obj.rows || [];
    return state.moduleCache[pid];
  }

  async function loadVersionList(pid) {
    if (!pid) return [];
    if (state.versionCache[pid]) return state.versionCache[pid];
    const obj = await getJSON(API.versionList(pid));
    const rows = obj.rows || [];
    rows.forEach((v) => (state.versionNameMap[v.id] = v.code));
    state.versionCache[pid] = rows;
    return rows;
  }

  /* ==========================================================================
   * 5. 断点续跑缓存（localStorage，超出配额自动降级）
   * ========================================================================== */

  const cache = {
    enabled: true,
    key: '',
    keys: [],
    disabled: false,
    init(taskKey) {
      this.key = K_STORE + ':' + taskKey;
      this.keys = [];
      this.disabled = false;
    },
    put(page, rows) {
      if (!this.enabled || this.disabled) return;
      try {
        const k = this.key + ':p:' + page;
        localStorage.setItem(k, JSON.stringify(rows));
        this.keys.push(k);
        localStorage.setItem(this.key + ':idx', JSON.stringify(this.keys));
      } catch (e) {
        this.disabled = true;
        log('⚠ 本地缓存空间不足，已自动关闭断点续跑（不影响本次抓取）', 'warn');
      }
    },
    load() {
      if (!this.enabled || this.disabled) return { pages: {}, list: [] };
      try {
        const idx = JSON.parse(localStorage.getItem(this.key + ':idx') || '[]');
        const out = [];
        const pages = {};
        idx.forEach((k) => {
          const v = localStorage.getItem(k);
          if (v === null) return;
          const rows = JSON.parse(v);
          pages[parseInt(k.split(':p:')[1], 10)] = true;
          out.push.apply(out, rows);
        });
        this.keys = idx;
        return { pages: pages, list: out };
      } catch (e) {
        return { pages: {}, list: [] };
      }
    },
    clear() {
      if (!this.key) return;
      try {
        (JSON.parse(localStorage.getItem(this.key + ':idx') || '[]') || []).forEach((k) =>
          localStorage.removeItem(k)
        );
        localStorage.removeItem(this.key + ':idx');
      } catch (e) {}
      this.keys = [];
    },
  };

  function clearAllCache() {
    try {
      const del = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(K_STORE) === 0) del.push(k);
      }
      del.forEach((k) => localStorage.removeItem(k));
      log('已清空全部断点缓存（' + del.length + ' 条）', 'ok');
    } catch (e) {
      log('清空缓存失败: ' + e.message, 'err');
    }
  }

  /* ==========================================================================
   * 6. 核心抓取流程
   * ========================================================================== */

  function buildSearchPayload(pageNum) {
    // 复刻前端 selectPost(): 选中子模块时，需把其父主模块从 mainModuleIds 中剔除
    let main = cfg.mainModuleIds.slice();
    const child = cfg.childModuleIds.slice();
    if (child.length) {
      const flat = [];
      const flatten = (nodes) =>
        (nodes || []).forEach((n) => {
          flat.push(n);
          flatten(n.children);
        });
      flatten(state.moduleCache[cfg.productLineId] || []);
      child.forEach((cid) => {
        const node = flat.find((n) => String(n.id) === String(cid));
        if (node && node.pid) main = main.filter((m) => String(m) !== String(node.pid));
      });
    }
    return {
      childModuleIds: child.map(Number),
      keyword: cfg.keyword || '',
      mainModuleIds: main.map(Number),
      productLineId: cfg.productLineId ? String(cfg.productLineId) : '',
      versionId: cfg.versionId ? String(cfg.versionId) : '',
      pageNum: pageNum,
      pageSize: cfg.pageSize,
    };
  }

  function normalizeRow(r) {
    const pid = r.product || cfg.productLineId || '';
    const sid = r.source_id || (r.id ? String(r.id).split(':').pop() : '');
    return {
      case_id: r.id || '',
      source_id: sid,
      url: DETAIL_URL(pid, sid),
      product_id: pid,
      product_name: state.productNameMap[pid] || '',
      title: r.title || '',
      main_modules: r.main_module_names || '',
      main_module_ids: r.main_module_ids || '',
      child_modules: r.child_module_names || '',
      child_module_ids: r.child_module_ids || '',
      version_ids: r.product_version || '',
      // 只保留能映射出名称的版本；全是裸 id 时再回退显示 id，避免 "70" 这种无意义值
      version_codes: (function () {
        const ids = (r.product_version || '').split(',').filter(Boolean);
        const named = ids.map((v) => state.versionNameMap[v]).filter(Boolean);
        return named.length ? named.join(' | ') : ids.join(',');
      })(),
      create_time: r.create_time || '',
      update_time: r.update_time || '',
      summary: r.content || '',
      detail_html: '',
      detail_md: '',
      detail_text: '',
      images: [],
      sections: [],
      detail_fetched: false,
    };
  }

  function describeTask() {
    const p = cfg.productLineId ? state.productNameMap[cfg.productLineId] || cfg.productLineId : '全部产品';
    return '产品线=' + p + ' 关键词=' + (cfg.keyword || '(空)') + ' 版本=' + (cfg.versionId || '全部');
  }

  async function crawl() {
    if (state.running) return;
    state.running = true;
    state.paused = false;
    state.cancelToken = 1;
    state.startedAt = Date.now();
    state.listRows = [];
    state.donePages = 0;
    state.detailDone = 0;
    state.total = 0;
    state.imgPlaceholders = 0;
    refreshStats();

    const taskKey = [
      cfg.productLineId || 'all',
      cfg.versionId || 'v0',
      cfg.mainModuleIds.join('-') || 'm0',
      cfg.childModuleIds.join('-') || 'c0',
      encodeURIComponent(cfg.keyword || ''),
      cfg.pageSize,
    ].join('|');
    cache.init(taskKey);
    if (!cfg.resume) cache.clear();

    setRunningUI(true);
    log('▶ 开始抓取  ' + describeTask(), 'info');

    try {
      // 预热：版本名映射（导出时把 version id 换成可读版本号）
      if (cfg.productLineId) {
        try {
          await loadVersionList(cfg.productLineId);
        } catch (e) {
          log('⚠ 版本列表加载失败：' + e.message, 'warn');
        }
      }

      log('正在探测总量…');
      const first = await postJSON(API.search, buildSearchPayload(0));
      const rows = first.rows || {};
      const total = rows.totalElements || 0;
      let totalPages = rows.totalPages || 0;
      // ES 深翻页上限 10000 条，超出的页取不到数据，提前截断避免大量无效请求
      const esMaxPage = Math.max(1, Math.floor(10000 / cfg.pageSize));
      if (totalPages > esMaxPage) {
        log(
          '⚠ 命中 ' + total + ' 条，超过 ES 深翻页上限（10000 条 / 每页 ' + cfg.pageSize +
            ' = ' + esMaxPage + ' 页），本次最多取前 ' + esMaxPage +
            ' 页；建议加产品线/模块/关键词等条件分批抓取',
          'warn'
        );
        totalPages = esMaxPage;
      }
      if (cfg.maxPages > 0 && totalPages > cfg.maxPages) totalPages = cfg.maxPages;
      state.totalPages = totalPages;
      state.total = total;
      log('共 ' + total + ' 条 / ' + rows.totalPages + ' 页' + (cfg.maxPages > 0 ? '，本次上限 ' + totalPages + ' 页' : ''));

      const firstRows = (rows.content || []).map(normalizeRow);
      state.listRows = firstRows.slice();
      cache.put(0, firstRows);
      state.donePages = 1;
      updateProgress();

      // 断点：读取缓存
      const restored = cfg.resume ? cache.load() : { pages: {}, list: [] };
      if (cfg.resume && restored.list.length) {
        log('↺ 断点恢复：' + restored.list.length + ' 条（' + Object.keys(restored.pages).length + ' 页）', 'info');
        const seen0 = new Set(state.listRows.map((r) => r.case_id));
        let legacy = 0;
        restored.list.forEach((r) => {
          // 旧格式缓存没有结构化正文字段，标记为未抓取，稍后重新拉详情
          if (cfg.fetchDetail && !r.detail_md) {
            r.detail_fetched = false;
            legacy++;
          }
          if (!seen0.has(r.case_id)) {
            seen0.add(r.case_id);
            state.listRows.push(r);
          }
        });
        if (legacy) log('（其中 ' + legacy + ' 条为旧格式缓存，将重新抓取正文）');
      }

      // 翻页
      const pages = [];
      for (let p = 1; p < totalPages; p++) {
        if (restored.pages[p]) {
          state.donePages++;
          continue;
        }
        pages.push(p);
      }
      if (pages.length) {
        log('开始翻页抓取，剩余 ' + pages.length + ' 页，并发 ' + cfg.concurrency);
        await pool(
          pages.map((p) => async () => {
            const res = await postJSON(API.search, buildSearchPayload(p));
            const list = (res.rows && res.rows.content) || [];
            const nr = list.map(normalizeRow);
            state.listRows.push.apply(state.listRows, nr);
            cache.put(p, nr);
            state.donePages++;
            updateProgress();
            if (cfg.interval) await sleep(cfg.interval);
          }),
          cfg.concurrency,
          (err, i) => {
            if (err) {
              state.donePages++;
              log('✗ 第 ' + pages[i] + ' 页失败：' + err.message, 'err');
              updateProgress();
            }
          }
        );
      }

      // 去重
      const seen = new Set();
      state.listRows = state.listRows.filter((r) => {
        if (seen.has(r.case_id)) return false;
        seen.add(r.case_id);
        return true;
      });

      // 时间过滤
      if (RECENT_MAP[cfg.onlyRecent]) {
        const days = RECENT_MAP[cfg.onlyRecent];
        const th = Date.now() - days * 86400000;
        const before = state.listRows.length;
        state.listRows = state.listRows.filter((r) => parseTime(r.update_time) >= th);
        log('时间过滤（近 ' + days + ' 天）：' + before + ' → ' + state.listRows.length + ' 条', 'info');
      }

      log('✔ 列表完成，共 ' + state.listRows.length + ' 条', 'ok');
      refreshStats();

      // 详情正文
      if (cfg.fetchDetail && state.listRows.length) {
        log('开始抓取正文详情…');
        const targets = state.listRows.filter((r) => !r.detail_fetched && r.source_id);
        let n = 0;
        await pool(
          targets.map((row) => async () => {
            const obj = await getJSON(API.detail(row.source_id), 1);
            const d = obj.rows || {};
            row.detail_html = d.content || d.contentWeb || '';
            // 结构化解析：还原「问题描述 / 告警信息 / 根因 / 解决方案」等章节
            try {
              const parsed = SFCaseFmt.parseCase(row.detail_html);
              row.detail_md = parsed.markdown;
              row.sections = parsed.sections;
              row.images = parsed.images;
              state.imgPlaceholders += (parsed.placeholders || []).length;
              row.detail_text = SFCaseFmt.plainText(row.detail_html);
            } catch (pe) {
              row.detail_text = stripTags(row.detail_html);
              row.detail_md = '';
            }
            row.product_name = d.productName || row.product_name;
            row.suite_version = d.suiteVersion || '';
            row.detail_main_modules = d.mainModuleNames || '';
            row.detail_child_modules = d.childModuleNames || '';
            row.detail_name = d.name || row.title;
            row.detail_fetched = true;
            n++;
            state.detailDone = n;
            updateProgress();
            if (cfg.interval) await sleep(Math.floor(cfg.interval / 2));
          }),
          cfg.detailConcurrency,
          (err) => {
            if (err) {
              n++;
              state.detailDone = n;
              log('✗ 详情失败：' + err.message, 'err');
              updateProgress();
            }
          }
        );
        log(
          '✔ 正文完成：' + state.listRows.filter((r) => r.detail_fetched).length + ' / ' + state.listRows.length,
          'ok'
        );
      }

      if (state.imgPlaceholders) {
        log(
          'ℹ 有 ' + state.imgPlaceholders + ' 张图片在源站只是编辑器占位符（形如 IMG_xxx），' +
            '官方并未公开真实地址，导出结果中已标注，无法下载。',
          'warn'
        );
      }

      const secs = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      log('🎉 全部完成，共 ' + state.listRows.length + ' 条，耗时 ' + secs + 's', 'ok');
      updateProgress(true);
    } catch (e) {
      if (e.message === 'CANCELLED') {
        log('⏹ 已停止', 'warn');
      } else {
        log('✗ 抓取失败：' + e.message, 'err');
      }
    } finally {
      state.running = false;
      state.paused = false;
      setRunningUI(false);
      refreshStats();
      updateProgress();
    }
  }

  /* ------------------------------------------------------ 关键字预搜索（先搜后爬） */
  // 官方返回的 highlightTitle 用 <span style="color:#1180ff"> 标记命中词，
  // 这里先把它替换成私有占位符，再去标签、转义，最后还原成 <mark>，避免注入风险。
  function safeHighlight(html) {
    let s = String(html || '');
    s = s.replace(/<span[^>]*color:\s*#?1180ff[^>]*>([\s\S]*?)<\/span>/gi, '\u0001$1\u0002');
    s = s.replace(/<[^>]+>/g, '');
    return SFCaseFmt.esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
  }

  async function previewSearch() {
    const box = $('preview');
    const card = $('preview-card');
    card.hidden = false;
    const kw = cfg.keyword || '';
    box.innerHTML = '<div class="card-hint">搜索中…</div>';
    try {
      // 用与实际抓取相同的 pageSize，保证预览里的页数就是真正要爬的页数
      const r = await postJSON(API.search, buildSearchPayload(0));
      const rows = r.rows || {};
      const total = rows.totalElements || 0;
      state.total = total;
      let pages = rows.totalPages || 0;
      const maxPage = Math.max(1, Math.floor(10000 / (cfg.pageSize || 20)));
      if (pages > maxPage) pages = maxPage; // ES 深翻页上限
      const list = (rows.content || []).slice(0, 8);
      refreshStats();

      if (!total) {
        box.innerHTML =
          '<div class="card-hint">' + (kw ? '关键字「' + SFCaseFmt.esc(kw) + '」' : '当前条件') + '未命中任何案例</div>';
        log('预搜索：命中 0 条' + (kw ? '（关键字「' + kw + '」）' : ''), 'warn');
        return;
      }

      const items = list
        .map((c, i) => {
          const pid = c.product || cfg.productLineId || '';
          const title = safeHighlight(c.highlightTitle || c.title);
          const mod = [c.main_module_names, c.child_module_names]
            .filter(Boolean)
            .map(SFCaseFmt.esc)
            .join(' / ');
          return (
            '<div class="pv-item"><span class="pv-n">' + (i + 1) + '.</span>' +
            '<a href="' + SFCaseFmt.esc(DETAIL_URL(pid, c.source_id)) + '" target="_blank" rel="noopener">' + title + '</a>' +
            (mod ? '<span class="pv-m">' + mod + '</span>' : '') +
            '</div>'
          );
        })
        .join('');

      box.innerHTML =
        '<div class="pv-head">命中 <b>' + total + '</b> 条 / ' + pages + ' 页' +
        (kw ? '　关键字「' + SFCaseFmt.esc(kw) + '」' : '　（未设置关键字）') + '</div>' +
        items +
        '<div class="card-hint" style="margin:14px 0 0">确认无误后再点「开始抓取」；点标题可在官网打开原文。</div>';
      log('预搜索：命中 ' + total + ' 条 / ' + pages + ' 页' + (kw ? '（关键字「' + kw + '」）' : ''));
    } catch (e) {
      box.innerHTML = '<div class="card-hint" style="color:#c0392b">搜索失败：' + SFCaseFmt.esc(e.message) + '</div>';
      log('预搜索失败：' + e.message, 'err');
    }
  }

  /* ==========================================================================
   * 7. 导出
   * ========================================================================== */

  const EXPORT_FIELDS = [
    ['case_id', '案例ID'],
    ['source_id', '源ID'],
    ['title', '标题'],
    ['product_id', '产品线ID'],
    ['product_name', '产品线'],
    ['main_modules', '主模块'],
    ['child_modules', '子模块'],
    ['version_codes', '适用版本'],
    ['suite_version', '架构版本'],
    ['create_time', '创建时间'],
    ['update_time', '更新时间'],
    ['url', '详情页链接'],
    ['summary', '列表摘要'],
    ['detail_md', '正文(Markdown)'],
    ['detail_text', '正文(纯文本)'],
    ['detail_html', '正文(HTML)'],
  ];

  function toCSV(rows) {
    const head = EXPORT_FIELDS.map((f) => csvCell(f[1])).join(',');
    const body = rows
      .map((r) => EXPORT_FIELDS.map((f) => csvCell(r[f[0]] !== undefined ? r[f[0]] : '')).join(','))
      .join('\r\n');
    return '\uFEFF' + head + '\r\n' + body;
  }

  function toMarkdown(rows, meta) {
    const L = [];
    L.push('# 深信服案例库导出');
    L.push('');
    L.push(
      '> 产品线：' + (meta.product || '全部') + '　｜　关键词：' + (meta.keyword || '(空)') +
      '　｜　共 ' + rows.length + ' 条　｜　导出时间：' + new Date().toLocaleString('zh-CN')
    );
    L.push('');
    L.push('## 目录');
    L.push('');
    rows.forEach((r, i) => {
      L.push((i + 1) + '. [' + (r.title || '(无标题)').replace(/[[\]]/g, '') + '](#case-' + (i + 1) + ')');
    });
    L.push('');
    L.push('---');
    L.push('');

    rows.forEach((r, i) => {
      L.push('<a id="case-' + (i + 1) + '"></a>');
      L.push('');
      L.push('## ' + (i + 1) + '. ' + (r.title || '(无标题)'));
      L.push('');
      const metaLine = [
        r.product_name ? '产品线 ' + r.product_name : '',
        r.child_modules || r.main_modules ? '模块 ' + (r.child_modules || r.main_modules) : '',
        SFCaseFmt.shortVersions(r.version_codes) ? '版本 ' + SFCaseFmt.shortVersions(r.version_codes) : '',
        r.suite_version ? '架构 ' + r.suite_version : '',
        r.update_time ? '更新 ' + r.update_time : '',
        '案例ID ' + r.case_id,
      ]
        .filter(Boolean)
        .join('　｜　');
      L.push('> ' + metaLine);
      L.push('');
      L.push('> 官网链接：<' + r.url + '>');
      L.push('');

      // 优先用结构化 Markdown（含章节标题、列表层级、图片）
      const body = r.detail_md || r.detail_text || r.summary || '';
      if (body) {
        // 章节 ### 降级为 ####，避免与案例标题 ## 同级混乱
        L.push(body.replace(/^###\s+/gm, '#### '));
      } else {
        L.push('_（无正文）_');
      }
      L.push('');
      L.push('---');
      L.push('');
    });
    return L.join('\n');
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 2000);
  }

  function baseName() {
    const p = cfg.productLineId
      ? safeName(state.productNameMap[cfg.productLineId] || cfg.productLineId)
      : 'all';
    return 'sangfor_cases_' + p + '_' + safeName(cfg.keyword || 'kw') + '_' + nowStamp();
  }

  /* ---------------------------------------------------- 图片下载与内嵌（可选） */
  // 把图片下载成 data: URL 内嵌进 HTML/Markdown，导出的文件可离线阅读。
  async function embedImages(rows) {
    // 先把正文里的相对图片路径补全为绝对地址：否则既无法下载，下面的字符串替换也匹配不到
    rows.forEach((r) => {
      if (r.detail_html) {
        r.detail_html = r.detail_html.replace(/(<img\b[^>]*?)\ssrc="([^"]*)"/gi, (m, pre, url) =>
          pre + ' src="' + SFCaseFmt.toAbs(url) + '"'
        );
      }
    });
    const urls = [];
    rows.forEach((r) =>
      (r.images || []).forEach((u) => {
        const a = SFCaseFmt.toAbs(u);
        if (urls.indexOf(a) < 0 && /^https?:\/\//i.test(a)) urls.push(a);
      })
    );
    if (!urls.length) {
      log('正文无外链图片，跳过内嵌', 'warn');
      return 0;
    }
    log('开始下载 ' + urls.length + ' 张图片用于内嵌…');
    const map = {};
    let ok = 0,
      fail = 0;
    await pool(
      urls.map((u) => async () => {
        const d = await fetchDataURL(u);
        if (d) {
          map[u] = d;
          ok++;
        } else fail++;
      }),
      4
    );
    rows.forEach((r) => {
      if (r.detail_html) {
        let h = r.detail_html;
        Object.keys(map).forEach((u) => {
          h = h.split(u).join(map[u]);
        });
        r.detail_html = h;
      }
      if (r.detail_md) {
        let m = r.detail_md;
        Object.keys(map).forEach((u) => {
          m = m.split(u).join(map[u]);
        });
        r.detail_md = m;
      }
    });
    log('图片内嵌完成：成功 ' + ok + '，失败 ' + fail, fail ? 'warn' : 'ok');
    return ok;
  }

  async function doExportHtml() {
    if (!state.listRows.length) {
      log('没有可导出的数据', 'warn');
      return;
    }
    const rows = state.listRows;
    const name = baseName();
    if (cfg.imageMode === 'embed') {
      await embedImages(rows);
    }
    const baseTitle =
      '深信服案例导出 - ' + (state.productNameMap[cfg.productLineId] || '全部产品') +
      (cfg.keyword ? ' - ' + cfg.keyword : '');

    // 分卷：案例极多时单文件体积会很大，拆成多个文件更好打开
    const size = Math.max(0, cfg.htmlPartSize || 0);
    if (size > 0 && rows.length > size) {
      const n = Math.ceil(rows.length / size);
      log('开始分卷导出：' + rows.length + ' 条 → ' + n + ' 个文件（每卷 ' + size + ' 条）');
      for (let i = 0; i < n; i++) {
        const part = rows.slice(i * size, (i + 1) * size);
        const html = SFCaseFmt.buildHtmlDoc(
          part,
          { title: baseTitle },
          { embeddedImages: cfg.imageMode === 'embed', pageSize: cfg.pageSize, part: i + 1 }
        );
        download(name + '_part' + (i + 1) + '.html', html, 'text/html;charset=utf-8');
        await sleep(400); // 连续触发下载时给浏览器一点反应时间
      }
      log('已导出 ' + n + ' 个 HTML 分卷 → ' + name + '_part*.html', 'ok');
      return;
    }

    const html = SFCaseFmt.buildHtmlDoc(rows, { title: baseTitle }, {
      embeddedImages: cfg.imageMode === 'embed',
      pageSize: cfg.pageSize,
    });
    download(name + '.html', html, 'text/html;charset=utf-8');
    log('已导出 HTML（单文件，内部已分页，可直接浏览器打开 / 打印为 PDF）→ ' + name + '.html', 'ok');
  }

  function doExport(type) {
    if (!state.listRows.length) {
      log('没有可导出的数据', 'warn');
      return;
    }
    const rows = state.listRows;
    const name = baseName();
    if (type === 'json') {
      download(
        name + '.json',
        JSON.stringify(
          {
            meta: {
              exported_at: new Date().toISOString(),
              source: 'support.sangfor.com.cn',
              product_line_id: cfg.productLineId,
              product_line_name: state.productNameMap[cfg.productLineId] || '',
              keyword: cfg.keyword,
              version_id: cfg.versionId,
              main_module_ids: cfg.mainModuleIds,
              child_module_ids: cfg.childModuleIds,
              count: rows.length,
            },
            rows: rows,
          },
          null,
          2
        ),
        'application/json;charset=utf-8'
      );
    } else if (type === 'csv') {
      download(name + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
    } else {
      download(
        name + '.md',
        toMarkdown(rows, {
          product: state.productNameMap[cfg.productLineId] || '全部',
          keyword: cfg.keyword,
        }),
        'text/markdown;charset=utf-8'
      );
    }
    log('已导出 ' + rows.length + ' 条 → ' + name + '.' + type, 'ok');
  }

  /* ==========================================================================
   * 8. 界面
   * ========================================================================== */

  let logBox = null;
  let elapsedTimer = null;

  function log(msg, level) {
    if (!logBox) return;
    const d = document.createElement('div');
    d.className = 'log-line' + (level ? ' ' + level : '');
    const t = new Date();
    d.textContent = '[' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) + '] ' + msg;
    logBox.appendChild(d);
    logBox.scrollTop = logBox.scrollHeight;
    while (logBox.childElementCount > 400) logBox.removeChild(logBox.firstChild);
  }

  function setChip(text, kind) {
    const c = $('chip-conn');
    c.textContent = text;
    c.className = 'chip' + (kind ? ' ' + kind : '');
  }

  function refreshStats() {
    $('st-total').textContent = state.total ? String(state.total) : '—';
    $('st-list').textContent = String(state.listRows.length);
    $('st-detail').textContent = String(state.detailDone);
    $('st-elapsed').textContent = elapsedText();
    const has = state.listRows.length > 0;
    ['btn-export-html', 'btn-export-md', 'btn-export-csv', 'btn-export-json'].forEach((id) => {
      $(id).disabled = !has;
    });
    $('export-hint').textContent = has
      ? '当前可导出 ' + state.listRows.length + ' 条。HTML 为单文件且内部自带分页，推荐优先使用。'
      : '抓取完成后即可导出。';
  }

  function computePct() {
    const dTotal = state.totalPages || 0;
    const dDone = state.donePages || 0;
    const listPct = dTotal ? Math.min(1, dDone / dTotal) : 0;
    if (!cfg.fetchDetail) return listPct;
    const nTotal = state.listRows.length || 0;
    const nDone = state.detailDone || 0;
    if (listPct < 1) return listPct * 0.4;
    const detailPct = nTotal ? Math.min(1, nDone / nTotal) : 0;
    return 0.4 + detailPct * 0.6;
  }

  function updateProgress(done) {
    if (!state.running && !state.totalPages && !state.listRows.length) {
      $('prog-fill').style.width = '0%';
      $('prog-text').textContent = '待开始';
      return;
    }
    const pct = done ? 1 : computePct();
    $('prog-fill').style.width = (pct * 100).toFixed(1) + '%';

    const parts = [];
    if (state.totalPages) parts.push('列表 ' + state.donePages + '/' + state.totalPages + ' 页');
    parts.push('案例 ' + state.listRows.length + ' 条');
    if (cfg.fetchDetail && state.listRows.length) {
      parts.push('正文 ' + state.detailDone + '/' + state.listRows.length + ' 条');
    }
    parts.push('耗时 ' + elapsedText());
    $('prog-text').textContent = (state.paused ? '已暂停 · ' : '') + parts.join(' · ');
    $('st-elapsed').textContent = elapsedText();
  }

  function setRunningUI(running) {
    $('btn-start').disabled = running;
    $('btn-preview').disabled = running;
    $('btn-test').disabled = running;
    $('btn-pause').disabled = !running;
    $('btn-stop').disabled = !running;
    if (!running) $('btn-pause').textContent = '⏸ 暂停';
    if (running && !elapsedTimer) {
      elapsedTimer = setInterval(() => updateProgress(), 500);
    } else if (!running && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  /* ------------------------------------------------------- 产品线 / 版本 / 模块 */

  async function initProducts() {
    try {
      const data = await loadProductList();
      fillProductSelect('');
      log('产品线加载完成：' + data.leaves.length + ' 个可选', 'ok');
      setChip('连接正常', 'ok');
    } catch (e) {
      fillProductSelect('');
      $('f-product').innerHTML = '<option value="">加载失败，点「测试连接」重试</option>';
      log('产品线加载失败：' + e.message, 'err');
      setChip('连接失败', 'err');
    }
  }

  function fillProductSelect(filter) {
    const data = state.productCache;
    const sel = $('f-product');
    if (!data) return;
    const kw = (filter || '').trim().toLowerCase();
    const list = kw
      ? data.leaves.filter((p) => (p.name + ' ' + p.group + ' ' + p.id).toLowerCase().indexOf(kw) >= 0)
      : data.leaves;
    const keep = cfg.productLineId;
    sel.innerHTML = '<option value="">全部产品</option>' + list
      .map((p) => '<option value="' + p.id + '">' + SFCaseFmt.esc(p.name) + '（' + p.id + '）</option>')
      .join('');
    if (keep && list.some((p) => String(p.id) === String(keep))) sel.value = keep;
    else {
      sel.value = '';
      cfg.productLineId = '';
    }
  }

  async function refreshVersions() {
    const sel = $('f-version');
    sel.innerHTML = '<option value="">全部版本</option>';
    if (!cfg.productLineId) return;
    try {
      const vs = await loadVersionList(cfg.productLineId);
      vs.forEach((v) => {
        const o = document.createElement('option');
        o.value = String(v.id);
        o.textContent = v.code;
        sel.appendChild(o);
      });
    } catch (e) {
      log('版本列表加载失败：' + e.message, 'warn');
    }
  }

  async function refreshModules() {
    const box = $('modules');
    const hint = $('module-hint');
    cfg.mainModuleIds = [];
    cfg.childModuleIds = [];
    if (!cfg.productLineId) {
      box.innerHTML = '';
      hint.textContent = '先在上方选择产品线';
      return;
    }
    hint.textContent = '加载中…';
    box.innerHTML = '';
    try {
      const tree = await loadModuleTree(cfg.productLineId);
      if (!tree || !tree.length) {
        hint.textContent = '该产品线没有模块筛选，可直接抓取全部案例。';
        return;
      }
      hint.textContent = '勾选后只抓取所选模块；未勾选则不限模块。';
      const mk = (node, depth) => {
        const isMain = depth === 0;
        const row = document.createElement('label');
        row.className = 'mod-item' + (isMain ? '' : ' child');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          const arr = isMain ? cfg.mainModuleIds : cfg.childModuleIds;
          const i = arr.map(String).indexOf(String(node.id));
          if (cb.checked && i < 0) arr.push(String(node.id));
          if (!cb.checked && i >= 0) arr.splice(i, 1);
        });
        const span = document.createElement('span');
        span.textContent = node.name;
        row.appendChild(cb);
        row.appendChild(span);
        box.appendChild(row);
        (node.children || []).forEach((c) => mk(c, depth + 1));
      };
      tree.forEach((n) => mk(n, 0));
    } catch (e) {
      hint.textContent = '模块加载失败：' + e.message;
      log('模块加载失败：' + e.message, 'err');
    }
  }

  /* ------------------------------------------------------------ 事件绑定 */

  function readCfgFromUI() {
    cfg.keyword = ($('f-keyword').value || '').trim();
    cfg.versionId = $('f-version').value || '';
    cfg.pageSize = Math.max(1, parseInt($('f-pagesize').value, 10) || 20);
    cfg.maxPages = Math.max(0, parseInt($('f-maxpages').value, 10) || 0);
    cfg.concurrency = Math.min(8, Math.max(1, parseInt($('f-concurrency').value, 10) || 3));
    cfg.detailConcurrency = Math.min(8, Math.max(1, parseInt($('f-detailconcurrency').value, 10) || 4));
    cfg.interval = Math.max(0, parseInt($('f-interval').value, 10) || 0);
    cfg.onlyRecent = $('f-recent').value || '';
    cfg.fetchDetail = $('f-fetch-detail').checked;
    cfg.resume = $('f-resume').checked;
    cfg.imageMode = $('f-image-embed').checked ? 'embed' : 'link';
    cfg.htmlPartSize = Math.max(0, parseInt($('f-partsize').value, 10) || 0);
  }

  function bind() {
    logBox = $('log');

    $('f-product').addEventListener('change', async (e) => {
      cfg.productLineId = e.target.value || '';
      await refreshVersions();
      await refreshModules();
    });

    $('f-product-filter').addEventListener('input', (e) => fillProductSelect(e.target.value));

    $('btn-module-clear').addEventListener('click', () => {
      $('modules').querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.checked = false));
      cfg.mainModuleIds = [];
      cfg.childModuleIds = [];
    });

    $('btn-test').addEventListener('click', async () => {
      readCfgFromUI();
      log('测试连接中…');
      try {
        const r = await postJSON(API.search, buildSearchPayload(0));
        const n = (r.rows && r.rows.totalElements) || 0;
        state.total = n;
        refreshStats();
        setChip('连接正常', 'ok');
        log('✔ 连接正常，当前条件下命中 ' + n + ' 条案例', 'ok');
      } catch (e) {
        setChip('连接失败', 'err');
        log('✗ 连接失败：' + e.message, 'err');
      }
    });

    $('btn-preview').addEventListener('click', () => {
      readCfgFromUI();
      previewSearch();
    });

    $('btn-preview-close').addEventListener('click', () => {
      $('preview-card').hidden = true;
    });

    $('btn-start').addEventListener('click', () => {
      readCfgFromUI();
      crawl();
    });

    $('btn-pause').addEventListener('click', () => {
      state.paused = !state.paused;
      $('btn-pause').textContent = state.paused ? '⏵ 继续' : '⏸ 暂停';
      log(state.paused ? '已暂停' : '已继续', 'warn');
      updateProgress();
    });

    $('btn-stop').addEventListener('click', () => {
      state.cancelToken = -1;
      state.paused = false;
      log('正在停止…', 'warn');
    });

    $('btn-export-html').addEventListener('click', () => {
      readCfgFromUI();
      doExportHtml();
    });
    $('btn-export-md').addEventListener('click', () => doExport('md'));
    $('btn-export-csv').addEventListener('click', () => doExport('csv'));
    $('btn-export-json').addEventListener('click', () => doExport('json'));

    $('btn-log-clear').addEventListener('click', () => (logBox.innerHTML = ''));

    $('btn-quit').addEventListener('click', async () => {
      if (!confirm('退出后会关闭本地服务，当前未导出的抓取结果将丢失。确定退出吗？')) return;
      try {
        await fetch('/api/quit', { method: 'POST' });
      } catch (e) {}
      document.body.innerHTML =
        '<div style="padding:80px 40px;text-align:center;color:#8a93a0;font-size:14px">' +
        '程序已退出，本页面可以关闭了。</div>';
    });

    window.addEventListener('beforeunload', (e) => {
      if (!state.running) return undefined;
      e.preventDefault();
      e.returnValue = '抓取仍在进行中，确定要离开吗？';
      return e.returnValue;
    });
  }

  /* ------------------------------------------------------------------ 启动 */

  async function boot() {
    bind();
    setRunningUI(false);
    refreshStats();
    try {
      const info = await (await fetch('/api/info')).json();
      document.title = info.name + ' v' + info.version;
    } catch (e) {}
    log('本地服务已就绪，正在加载产品线…', 'info');
    await initProducts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
