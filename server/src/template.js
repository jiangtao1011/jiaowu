import * as XLSX from 'xlsx';

// 解析上传的表格文件（Excel 或 CSV），返回对象数组
export function parseSheet(buffer, originalName) {
  const isCsv = /\.csv$/i.test(originalName || '');
  let wb;
  if (isCsv) {
    // CSV 以 UTF-8 文本读取，避免中文表头乱码
    wb = XLSX.read(buffer.toString('utf8'), { type: 'string' });
  } else {
    wb = XLSX.read(buffer, { type: 'buffer' });
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// 从行中按多个候选键取第一个存在的值
export function keyOf(row, ...keys) {
  for (const k of keys) {
    if (k in row) return row[k];
  }
  return undefined;
}

// 生成并下载一个 Excel 模板（表头 + 示例行）。
// extraSheets：可选，形如 [{ name: '填写说明', rows: [['说明行1'], ['说明行2']] }]
export function downloadTemplate(res, headers, sampleRows, filename, extraSheets = []) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  // 表头列宽适当放宽
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '导入模板');
  for (const { name, rows } of extraSheets) {
    const s = XLSX.utils.aoa_to_sheet(rows);
    s['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, s, name);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buf);
}
