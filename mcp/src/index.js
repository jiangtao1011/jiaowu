// 教务管理 MCP 服务 —— 入口
// 通过 stdio 与桌面端 agent（Claude Desktop / Codex / WorkBuddy）通信，
// 把教务管理后端的 REST API 封装成一组工具。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EduAdminClient } from './client.js';

const client = new EduAdminClient();

// 导出文件落盘目录（供 agent 把 xlsx 保存到本地）
const EXPORT_DIR = process.env.EDU_ADMIN_EXPORT_DIR || process.env.HOME + '/Downloads';

const server = new McpServer({
  name: 'edu-admin',
  version: '1.0.0',
});

// 统一处理 handler 抛错，并把结果序列化成标准 text content 返回给 agent
async function run(fn) {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message || String(e) }) }] };
  }
}

// ===== 认证 =====
server.registerTool(
  'edu_login',
  {
    title: '登录教务管理',
    description: '用教务管理账号登录，换取访问令牌。后续所有工具会自动携带该令牌。',
    inputSchema: {
      username: z.string().describe('用户名，如 admin'),
      password: z.string().describe('密码'),
    },
  },
  async ({ username, password }) => run(() => client.login({ username, password }))
);

// ===== 基本信息 =====
server.registerTool(
  'edu_list_classes',
  {
    title: '列出班级',
    description: '查询班级信息（行政班/分层/走班），含人数、年级、合班成员。导入课表前需先确认班级名称。',
    inputSchema: {},
  },
  async () => run(() => client.get('/api/classes'))
);

server.registerTool(
  'edu_list_teachers',
  {
    title: '列出教师',
    description: '查询教师信息（姓名、学科、课酬标准、所带班级）。导入课表前需先确认教师姓名。',
    inputSchema: {},
  },
  async () => run(() => client.get('/api/teachers'))
);

server.registerTool(
  'edu_list_period_types',
  {
    title: '列出按次计酬类型',
    description: '查询按次计酬类型字典（晚自习/答疑/晚读/晚练/自定义），含每节固定课酬单价。课表导入时类型列可填这些类型名。',
    inputSchema: {},
  },
  async () => run(() => client.get('/api/stats/type-pays'))
);

// ===== 课表 =====
server.registerTool(
  'edu_list_schedules',
  {
    title: '查看课表',
    description: '查询课表，可按班级/教师/类型/时段过滤。',
    inputSchema: {
      class_id: z.coerce.number().optional().describe('班级 ID（可选）'),
      teacher_id: z.coerce.number().optional().describe('教师 ID（可选）'),
      period_type: z.string().optional().describe('类型：正课/早自习/晚自习/答疑 或自定义类型（可选）'),
      term: z.string().optional().describe('时段：常规/夏令营/冬令营/全员夏令营/全员冬令营/节假补课（可选）'),
    },
  },
  async (args) => run(() => client.get('/api/schedules', args))
);

server.registerTool(
  'edu_import_schedule',
  {
    title: '导入课表',
    description: '导入课表文件（Excel .xlsx/.xls 或 CSV）。需先调用 edu_list_classes 与 edu_list_teachers 确认班级/教师名称。表头需含：班级、星期、节次、类型、时段、课程名称、教师。可选参数：effective_from（生效日期）、effective_to（结束日期）、scope（append 追加 / all 全校替换 / grade 年级替换 / term 时段替换）。',
    inputSchema: {
      filePath: z.string().describe('课表文件的绝对路径（.xlsx/.xls/.csv）'),
      effective_from: z.string().optional().describe('生效日期 YYYY-MM-DD（可选）'),
      effective_to: z.string().optional().describe('结束日期 YYYY-MM-DD（可选）'),
      scope: z.enum(['append', 'all', 'grade', 'term']).optional().describe('替换范围，默认 append 追加'),
      grade: z.string().optional().describe('scope=grade 时指定年级（可选）'),
      scope_term: z.string().optional().describe('scope=term 时指定时段（可选）'),
    },
  },
  async (args) => {
    const { filePath, ...body } = args;
    return run(async () => {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(filePath);
      const filename = filePath.split('/').pop();
      const form = new FormData();
      form.append('file', new Blob([buf]), filename);
      for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
      return client._req('POST', '/api/schedules/import', form, true);
    });
  }
);

// ===== 按日统计（校历 + 生成 + 汇总） =====
server.registerTool(
  'edu_mark_calendar',
  {
    title: '标记校历（放假/补课/停课）',
    description: '标记上课日历。type：上课/放假/停课/补课。补课时需填 make_up_for（补哪天的日期，或周几 1-7）。可用 date 标单日，或用 from+to 标区间。grade 为空=全校。',
    inputSchema: {
      date: z.string().optional().describe('单日 YYYY-MM-DD（与 from/to 二选一）'),
      from: z.string().optional().describe('区间起始日 YYYY-MM-DD（可选）'),
      to: z.string().optional().describe('区间结束日 YYYY-MM-DD（可选）'),
      grade: z.string().optional().describe('年级（空=全校）'),
      type: z.enum(['上课', '放假', '停课', '补课']).describe('类型'),
      make_up_for: z.string().optional().describe('补哪天：日期 YYYY-MM-DD 或周几 1-7（仅补课需填）'),
      note: z.string().optional().describe('备注'),
    },
  },
  async (args) => {
    const { from, to, ...rest } = args;
    const item = { ...rest };
    if (from && to) { item.from = from; item.to = to; }
    return run(() => client.post('/api/stats/calendar', { items: [item] }));
  }
);

server.registerTool(
  'edu_generate_instances',
  {
    title: '生成上课记录',
    description: '把固定课表按校历展开成按日的上课记录（幂等）。统计课酬前需先执行。replace=true 会先清空区间内课表展开记录再重新生成（避免改表后重复计酬）。',
    inputSchema: {
      from_date: z.string().describe('开始日期 YYYY-MM-DD'),
      to_date: z.string().describe('结束日期 YYYY-MM-DD'),
      replace: z.boolean().optional().describe('是否先清空区间内旧记录再生成，默认 true'),
    },
  },
  async ({ from_date, to_date, replace }) =>
    run(() => client.post('/api/stats/generate', { from_date, to_date, replace: replace ?? true }))
);

server.registerTool(
  'edu_summary',
  {
    title: '课酬汇总统计',
    description: '按教师汇总课酬（按日精确口径）。返回每位教师的各类别节数、原始课时、折算课时、课酬总额。',
    inputSchema: {
      from_date: z.string().describe('开始日期 YYYY-MM-DD'),
      to_date: z.string().describe('结束日期 YYYY-MM-DD'),
      term: z.string().optional().describe('时段筛选（可选）'),
      teacher_id: z.coerce.number().optional().describe('教师 ID 筛选（可选）'),
    },
  },
  async (args) => run(() => client.get('/api/stats/summary', args))
);

server.registerTool(
  'edu_export_payroll',
  {
    title: '导出课酬报表',
    description: '导出课酬 Excel 报表到本地目录。kind=detail 导出明细表（每节课一行，含来源/原教师/停课态）；kind=financial 导出财务审核汇总表（按教师一行，金额按来源分列+口径说明，上交给财务）。返回保存路径。',
    inputSchema: {
      from_date: z.string().describe('开始日期 YYYY-MM-DD'),
      to_date: z.string().describe('结束日期 YYYY-MM-DD'),
      kind: z.enum(['detail', 'financial']).describe('报表类型：detail 明细 / financial 财务汇总'),
      term: z.string().optional().describe('时段筛选（可选）'),
    },
  },
  async (args) => {
    const { kind, from_date, to_date, term } = args;
    return run(async () => {
      const endpoint = kind === 'financial' ? '/api/stats/financial-report' : '/api/stats/export';
      const q = new URLSearchParams({ from_date, to_date });
      if (term) q.set('term', term);
      const res = await fetch(client.baseUrl + endpoint + '?' + q, {
        headers: { Authorization: `Bearer ${client.token}` },
      });
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${kind === 'financial' ? '课酬财务汇总表' : '课酬明细'}_${from_date}_${to_date}.xlsx`;
      const { mkdirSync } = await import('node:fs');
      const { writeFile } = await import('node:fs/promises');
      mkdirSync(EXPORT_DIR, { recursive: true });
      const outPath = EXPORT_DIR + '/' + filename;
      await writeFile(outPath, buf);
      return { ok: true, data: { path: outPath, filename, kind } };
    });
  }
);

// 财务对账：调 /financial-check 返回勾稽结果与异常清单（文本结论），导出前先跑。
server.registerTool(
  'edu_financial_check',
  {
    title: '课酬勾稽校验',
    description: '对指定区间的课酬做自动对账：明细逐条金额之和是否等于汇总合计，并返回异常清单（无价类型/缺课酬标准/代课计数异常/单人偏高）与按类型/年级/学科金额小计。导出财务审核包前务必先跑，发现异常先修正。',
    inputSchema: {
      from_date: z.string().describe('开始日期 YYYY-MM-DD'),
      to_date: z.string().describe('结束日期 YYYY-MM-DD'),
      term: z.string().optional().describe('时段筛选（可选）'),
    },
  },
  async (args) => run(() => client.get('/api/stats/financial-check', args))
);

// 导出财务审核包：单文件多 sheet（汇总+明细+勾稽+口径说明），一键给财务。
server.registerTool(
  'edu_export_financial_pack',
  {
    title: '导出财务审核包',
    description: '导出「财务审核包」到本地目录：单个 Excel 含财务汇总表、课酬明细、勾稽校验、口径说明四个 sheet。建议先跑 edu_financial_check 确认无异常再出包。返回保存路径。',
    inputSchema: {
      from_date: z.string().describe('开始日期 YYYY-MM-DD'),
      to_date: z.string().describe('结束日期 YYYY-MM-DD'),
      term: z.string().optional().describe('时段筛选（可选）'),
    },
  },
  async (args) => {
    const { from_date, to_date, term } = args;
    return run(async () => {
      const q = new URLSearchParams({ from_date, to_date });
      if (term) q.set('term', term);
      const res = await fetch(client.baseUrl + '/api/stats/financial-pack?' + q, {
        headers: { Authorization: `Bearer ${client.token}` },
      });
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `课酬财务审核包_${from_date}_${to_date}.xlsx`;
      const { mkdirSync } = await import('node:fs');
      const { writeFile } = await import('node:fs/promises');
      mkdirSync(EXPORT_DIR, { recursive: true });
      const outPath = EXPORT_DIR + '/' + filename;
      await writeFile(outPath, buf);
      return { ok: true, data: { path: outPath, filename } };
    });
  }
);

// 归档固化：财务审核通过后固化快照，之后改表/重新生成不影响已归档月份。
server.registerTool(
  'edu_archive_payroll',
  {
    title: '固化课酬快照',
    description: '把指定区间的课酬结果固化为归档快照。财务审核通过后调用，之后重新生成上课记录、改课表、改单价均不影响已归档月份。返回快照 id 与课酬合计。',
    inputSchema: {
      from_date: z.string().describe('开始日期 YYYY-MM-DD'),
      to_date: z.string().describe('结束日期 YYYY-MM-DD'),
      term: z.string().optional().describe('时段筛选（可选）'),
      label: z.string().optional().describe('归档备注（如「2026年9月已审核」）'),
    },
  },
  async (args) => {
    const { from_date, to_date, term, label } = args;
    return run(async () => {
      const q = new URLSearchParams({ from_date, to_date });
      if (term) q.set('term', term);
      return client._req('POST', '/api/stats/snapshots?' + q, label ? { label } : {}, true);
    });
  }
);

// ===== 通知 =====
server.registerTool(
  'edu_create_notice',
  {
    title: '创建通知',
    description: '创建一条通知（草稿）。返回通知 ID 与分享 token，可生成免登录链接发到工作群。',
    inputSchema: {
      title: z.string().describe('通知标题'),
      type: z.string().optional().describe('通知类型：课务调整/考试通知/其他等'),
      content: z.string().describe('通知正文'),
    },
  },
  async (args) => run(() => client.post('/api/notices', args))
);

server.registerTool(
  'edu_publish_notice',
  {
    title: '发布通知',
    description: '发布一条通知（把草稿设为已发布）。',
    inputSchema: {
      id: z.coerce.number().describe('通知 ID'),
    },
  },
  async ({ id }) => run(() => client._req('PATCH', `/api/notices/${id}/publish`, { publish_status: 'published' }, true))
);

server.registerTool(
  'edu_list_notices',
  {
    title: '列出通知',
    description: '查询通知列表（含分享 token 与已读/点赞/回复计数）。',
    inputSchema: {},
  },
  async () => run(() => client.get('/api/notices'))
);

// ===== 上课记录 =====
server.registerTool(
  'edu_list_instances',
  {
    title: '查看上课记录',
    description: '查询按日上课记录（可过滤日期/班级/教师），用于核对统计结果。',
    inputSchema: {
      from_date: z.string().optional().describe('开始日期（可选）'),
      to_date: z.string().optional().describe('结束日期（可选）'),
      class_id: z.coerce.number().optional().describe('班级 ID（可选）'),
      teacher_id: z.coerce.number().optional().describe('教师 ID（可选）'),
    },
  },
  async (args) => run(() => client.get('/api/stats/instances', args))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 用 stderr 输出日志，避免污染 stdio 协议通道
  console.error(`edu-admin MCP 服务已启动，后端地址：${client.baseUrl}`);
}

main().catch((e) => {
  console.error('MCP 服务启动失败：', e);
  process.exit(1);
});
