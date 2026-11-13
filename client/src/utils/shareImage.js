// 生成「分享卡片图」：复刻通知分享落地页的公文版式。
// 纯前端 Canvas 实现。关键：测量高度与绘制共用同一套折行逻辑，避免错位。

const W = 750;
const PAD = 48;
const CONTENT_W = W - PAD * 2;
const SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const SERIF = '"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif';

// 圆角矩形路径
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 行内解析：把 **粗体**、*斜体*、`代码`、[链接](url) 拆成带样式的片段
function inlineSegs(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\([^)]*\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), b: false, i: false, c: false });
    if (m[2] !== undefined) out.push({ t: m[2], b: true, i: false, c: false });
    else if (m[4] !== undefined) out.push({ t: m[4], b: false, i: true, c: false });
    else if (m[6] !== undefined) out.push({ t: m[6], b: false, i: false, c: true });
    else if (m[8] !== undefined) out.push({ t: m[8], b: false, i: false, c: false, link: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: text.slice(last), b: false, i: false, c: false });
  if (!out.length) out.push({ t: '', b: false, i: false, c: false });
  return out;
}

function fontOf(seg, size) {
  const fam = seg.c ? 'ui-monospace,Menlo,monospace' : SERIF;
  const st = seg.i ? 'italic ' : '';
  const wt = seg.b ? 'bold ' : '';
  return `${st}${wt}${size}px ${fam}`;
}

// 把片段按 maxWidth 折行。返回 [[seg,...], ...]
function wrap(ctx, segs, size, maxWidth) {
  const lines = [[]];
  let curW = 0;
  for (const seg of segs) {
    let text = seg.t;
    while (text.length) {
      ctx.font = fontOf(seg, size);
      let take = text.length;
      // 找能放下的最大前缀（至少 1 个字符）
      while (take > 0 && ctx.measureText(text.slice(0, take)).width > maxWidth - curW) take--;
      if (take === 0) {
        // 当前行放不下任何字符 → 换行
        lines.push([]);
        curW = 0;
        continue;
      }
      lines[lines.length - 1].push({ ...seg, t: text.slice(0, take) });
      curW += ctx.measureText(text.slice(0, take)).width;
      text = text.slice(take);
      if (text.length) { lines.push([]); curW = 0; }
    }
  }
  return lines;
}

// 把 Markdown 解析成 block 数组，每项带类型与文本
function mdBlocks(md) {
  if (!md) return [];
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let raw of lines) {
    raw = raw.replace(/\s+$/, '');
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { blocks.push({ type: 'hr' }); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2] }); continue; }
    if (/^\s*>\s?/.test(raw)) { blocks.push({ type: 'quote', text: raw.replace(/^\s*>\s?/, '') }); continue; }
    const li = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (li) { blocks.push({ type: 'li', text: li[1] }); continue; }
    const oli = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (oli) { blocks.push({ type: 'li', text: oli[1] }); continue; }
    if (raw.trim() === '') { blocks.push({ type: 'sp' }); continue; }
    blocks.push({ type: 'p', text: raw });
  }
  return blocks;
}

// 计算单个 block 的布局（折行结果 + 尺寸），测量与绘制共用
function blockLayout(ctx, b) {
  if (b.type === 'hr') return { kind: 'hr', height: 26 };
  if (b.type === 'sp') return { kind: 'sp', height: 14 };

  if (b.type === 'h') {
    const size = [0, 22, 20, 18, 16][b.level] || 16;
    const lines = wrap(ctx, [{ t: b.text, b: true, i: false, c: false }], size, CONTENT_W);
    return { kind: 'h', size, lines, lineH: size + 10, height: lines.length * (size + 10) + 8 };
  }

  if (b.type === 'quote') {
    const size = 15;
    const lines = wrap(ctx, inlineSegs(b.text), size, CONTENT_W - 22);
    return { kind: 'quote', size, lines, lineH: 26, height: lines.length * 26 + 10 };
  }

  if (b.type === 'li') {
    const size = 17;
    const lines = wrap(ctx, inlineSegs(b.text), size, CONTENT_W - 24);
    return { kind: 'li', size, lines, lineH: 28, height: lines.length * 28 };
  }

  // p
  const size = 17;
  const lines = wrap(ctx, inlineSegs(b.text), size, CONTENT_W);
  return { kind: 'p', size, lines, lineH: 28, height: lines.length * 28 + 6 };
}

function drawSegLine(ctx, segs, x, y, size) {
  let cx = x;
  for (const seg of segs) {
    ctx.font = fontOf(seg, size);
    ctx.fillStyle = seg.link ? '#167d6f' : seg.b ? '#c0392b' : seg.c ? '#4b5563' : '#374151';
    ctx.fillText(seg.t, cx, y);
    cx += ctx.measureText(seg.t).width;
  }
}

function drawBlock(ctx, b, x, y) {
  ctx.textAlign = 'left';
  if (b.kind === 'hr') {
    const g = ctx.createLinearGradient(x, y, x + CONTENT_W, y);
    g.addColorStop(0, 'rgba(192,57,43,0)');
    g.addColorStop(0.3, '#c0392b');
    g.addColorStop(0.7, '#c0392b');
    g.addColorStop(1, 'rgba(192,57,43,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y - 1, CONTENT_W, 2);
    return;
  }
  if (b.kind === 'sp') return;
  if (b.kind === 'h') {
    ctx.fillStyle = '#1f2937';
    for (let i = 0; i < b.lines.length; i++) {
      drawSegLine(ctx, b.lines[i], x, y + i * b.lineH + b.size, b.size);
    }
    return;
  }
  if (b.kind === 'quote') {
    ctx.fillStyle = '#eef4f3';
    ctx.fillRect(x, y - 4, CONTENT_W, b.height - 6);
    ctx.fillStyle = '#167d6f';
    ctx.fillRect(x, y - 4, 3, b.height - 6);
    for (let i = 0; i < b.lines.length; i++) {
      drawSegLine(ctx, b.lines[i], x + 14, y + i * b.lineH + b.size, b.size);
    }
    return;
  }
  if (b.kind === 'li') {
    ctx.fillStyle = '#167d6f';
    ctx.font = `bold ${b.size}px ${SERIF}`;
    ctx.fillText('•', x, y + b.size);
    for (let i = 0; i < b.lines.length; i++) {
      drawSegLine(ctx, b.lines[i], x + 24, y + i * b.lineH + b.size, b.size);
    }
    return;
  }
  // p
  for (let i = 0; i < b.lines.length; i++) {
    drawSegLine(ctx, b.lines[i], x, y + i * b.lineH + b.size, b.size);
  }
}

export function downloadShareImage({ title, sub, content, qrDataUrl, url, filename, meta }) {
  if (!qrDataUrl) return;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // 1. 测量：头部 + 正文 + 底部
  const blocks = mdBlocks(content).map((b) => blockLayout(ctx, b));

  // 标题折行（宋体 26 居中）
  ctx.font = `bold 26px ${SERIF}`;
  const titleLines = wrap(ctx, [{ t: title || '', b: true, i: false, c: false }], 26, CONTENT_W);

  // 头部高度：品牌(30) + 间距(16) + 徽章(26) + 间距(14) + 标题 + 间距(10) + meta(20) + 间距(14) + 红线(2) + 间距(22)
  let headH = 30 + 16 + 26 + 14 + titleLines.length * 34 + 10 + 20 + 14 + 2 + 22;

  let bodyH = 0;
  for (const b of blocks) bodyH += b.height;

  // 底部：二维码 120 + 引导语 + 链接
  const QR = 120;
  const FOOTER_H = QR + 40;
  const TOP = 40;
  const BOTTOM = 32;

  const H = TOP + headH + bodyH + FOOTER_H + BOTTOM;
  canvas.width = W;
  canvas.height = H;

  // 2. 绘制
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  let y = TOP;

  // 品牌（圆标 + 文字，整体水平居中，模拟落地页 .n-brand）
  {
    const brandText = '课程中心 · 教务管理';
    ctx.textAlign = 'left';
    ctx.font = `12.5px ${SANS}`;
    const textW = ctx.measureText(brandText).width;
    const markSize = 24;
    const gap = 8;
    const totalW = markSize + gap + textW;
    const startX = (W - totalW) / 2;

    // 圆标（墨绿底白字「教」）
    const markY = y + 2;
    ctx.fillStyle = '#167d6f';
    roundRect(ctx, startX, markY, markSize, markSize, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 13px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText('教', startX + markSize / 2, markY + 17);

    // 品牌文字
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6b7280';
    ctx.font = `12.5px ${SANS}`;
    ctx.fillText(brandText, startX + markSize + gap, y + 17);
    y += 30 + 16;
  }

  // 后续徽章/标题/meta 都是居中，显式恢复 textAlign
  ctx.textAlign = 'center';

  // 徽章
  if (sub) {
    ctx.font = `13px ${SANS}`;
    const bw = ctx.measureText(sub).width + 22;
    ctx.fillStyle = '#eef4f3';
    ctx.fillRect(W / 2 - bw / 2, y - 15, bw, 24);
    ctx.fillStyle = '#167d6f';
    ctx.fillText(sub, W / 2, y + 2);
    y += 26 + 14;
  }

  // 标题（居中，宋体）
  ctx.fillStyle = '#1f2937';
  ctx.font = `bold 26px ${SERIF}`;
  for (let i = 0; i < titleLines.length; i++) {
    ctx.fillText(titleLines[i].map((s) => s.t).join(''), W / 2, y + (i + 1) * 34);
  }
  y += titleLines.length * 34 + 10;

  // meta
  if (meta) {
    ctx.fillStyle = '#6b7280';
    ctx.font = `13px ${SANS}`;
    ctx.fillText(meta, W / 2, y + 13);
    y += 20 + 14;
  }

  // 红头分隔线
  const g = ctx.createLinearGradient(PAD, y, W - PAD, y);
  g.addColorStop(0, 'rgba(192,57,43,0)');
  g.addColorStop(0.3, '#c0392b');
  g.addColorStop(0.7, '#c0392b');
  g.addColorStop(1, 'rgba(192,57,43,0)');
  ctx.fillStyle = g;
  ctx.fillRect(PAD, y - 1, CONTENT_W, 2);
  y += 2 + 22;

  // 正文
  ctx.textAlign = 'left';
  for (const b of blocks) {
    drawBlock(ctx, b, PAD, y);
    y += b.height;
  }

  // 底部分隔线
  const footerTop = H - FOOTER_H - BOTTOM;
  ctx.strokeStyle = '#e6e8ec';
  ctx.beginPath();
  ctx.moveTo(PAD, footerTop);
  ctx.lineTo(W - PAD, footerTop);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#167d6f';
  ctx.font = `bold 16px ${SANS}`;
  ctx.fillText('长按识别二维码，或复制链接打开', PAD, footerTop + 30);

  ctx.fillStyle = '#6b7280';
  ctx.font = `13px ${SANS}`;
  ctx.fillText(url || '', PAD, footerTop + 54);

  // 右下角二维码
  const qx = W - PAD - QR;
  const qy = footerTop + 20;
  ctx.fillStyle = '#f5f6f8';
  ctx.fillRect(qx - 6, qy - 6, QR + 12, QR + 12);

  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, qx, qy, QR, QR);
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || '分享图.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  };
  img.src = qrDataUrl;
}
