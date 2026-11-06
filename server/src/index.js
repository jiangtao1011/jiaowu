import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import './db.js';

import authRoutes from './routes/auth.js';
import { readonlyGuard } from './auth.js';
import userRoutes from './routes/users.js';
import classRoutes from './routes/classes.js';
import teacherRoutes from './routes/teachers.js';
import scheduleRoutes from './routes/schedules.js';
import noticeRoutes from './routes/notices.js';
import uploadTaskRoutes from './routes/uploadTasks.js';
import inspectionRoutes from './routes/inspections.js';
import applicationRoutes from './routes/applications.js';
import statsRoutes from './routes/stats.js';
import workplanRoutes from './routes/workplan.js';
import dashboardRoutes from './routes/dashboard.js';
import assessmentRoutes from './routes/assessment.js';
import adminRoutes from './routes/admin.js';
import datacenterRoutes from './routes/datacenter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// 简单请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, data: 'ok' }));

// 全局只读兜底：校长对所有业务写接口一律 403（防御层，防漏改）
app.use('/api', readonlyGuard);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/notices', noticeRoutes);
app.use('/api/upload-tasks', uploadTaskRoutes);
app.use('/api/inspections', inspectionRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/workplan', workplanRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/datacenter', datacenterRoutes);

// 404
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// 前端静态托管：server/dist 由 client 构建产物复制而来（或直接指向 client/dist）。
// 优先用 server/dist，若不存在则回退 client/dist，保证单端口 4000 直接访问前端。
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
const SERVER_DIST = path.join(__dirname, '..', 'dist');
const FRONTEND_DIR = fs.existsSync(SERVER_DIST) ? SERVER_DIST : CLIENT_DIST;

if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  // SPA history 路由回退：非 /api 的路径一律返回 index.html
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
  console.log(`前端静态托管: ${FRONTEND_DIR}`);
} else {
  console.log('未找到前端构建产物，请先运行 client: npm run build');
}

// 全局错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`教务管理后端已启动: http://localhost:${PORT}`);
  console.log(`局域网访问: http://<本机IP>:${PORT}`);
});
