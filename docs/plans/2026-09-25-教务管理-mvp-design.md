# 教务管理应用 —— MVP 设计文档

日期：2026-09-25
状态：已确认，进入开发

## 1. 目标与范围

局域网内的 Web 应用，服务于「课程中心」的教务管理事务。本次先做核心 MVP，跑通后逐步扩展常规检查、竞赛课申报、教学业绩考核等模块。

### 本期 MVP 范围（P0）

1. **账号与权限**：内置账号，教务员统一创建；角色 = 教务员 / 教研组长 / 备课组长 / 教师 / 教务处。
2. **基本信息**：班级（行政班、走班、人数）、教师（所带班级、课酬标准）。
3. **课表**：由表格导入生成课表，精准到每一位老师；早自习/晚自习一并纳入；拖拽式调课、代课；汇总统计。
4. **通知**：可生成链接，发到工作群供教师点击查看（课务调整通知、考试通知）。
5. **教学计划 / 文件上传**：教务员自定义上传内容、指定人员范围、要求与截止时间；在线浏览。

### 后续模块（P1+，本期不实现）

- 答疑课在线填报与审核、教学计划进度、常规检查（移动端拍照）、竞赛课/私人定制课申报、教学业绩考核自动汇总、历史快照的完整统计口径。

## 2. 技术栈与理由

- **后端**：Node.js 24 + 原生 `node:sqlite`（Node 24 内置稳定 SQLite，零外部数据库依赖）。
- **Web 框架**：Express（轻量、成熟）。
- **认证**：JWT（`jsonwebtoken`）+ `bcryptjs` 密码哈希。
- **前端**：React 18 + Vite，`react-router-dom` 路由，`axios` 请求。响应式布局，兼容移动端。
- **文件上传**：`multer`，文件存本地 `server/uploads/`。
- **课表导入**：`xlsx` 解析 Excel；同时也接受 CSV 兜底。

理由：单机局域网部署、零外部服务依赖、部署最简；同一门语言前后端协作方便；后端 API 设计为「技能友好」，便于被 Claude 桌面端 / WorkBuddy 桌面端技能调用。

## 3. 目录结构

```
教务管理/
├── 教务管理需求.md
├── docs/plans/            # 设计文档
├── server/                # 后端
│   ├── package.json
│   ├── src/
│   │   ├── index.js       # 入口
│   │   ├── db.js          # SQLite 连接与 schema 初始化
│   │   ├── auth.js        # JWT 中间件、角色校验
│   │   ├── seed.js        # 初始教务员账号
│   │   └── routes/        # 各模块路由
│   └── uploads/           # 上传文件存储
└── client/                # 前端
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── api.js         # axios 封装 + token
        ├── pages/         # 页面
        └── components/    # 通用组件
```

## 4. 数据模型（核心表）

> 关键设计：**任何影响「统计口径」的表（课表、任课、班级人数）都带时间版本**，
> 用 `effective_from` / `effective_to`（或快照）保留变动前记录，保证「变化前的统计不受影响」。

### users（用户）
- id, username(唯一), password_hash, name, role, phone, active, created_at

### classes（班级）
- id, name(唯一), type(行政班/走班), student_count, grade, effective_from, effective_to, created_at

### teachers（教师）
- id, name, phone, subject, pay_standard(JSON: 夏/冬令营、全员夏/冬令营、节假补课), active

### teacher_classes（任课关系，带时间版本）
- id, teacher_id, class_id, subject, effective_from, effective_to, created_at

### schedules（课表条目，带时间版本）
- id, class_id, teacher_id, subject, day_of_week(0-6), period_no, period_type(早自习/正课/晚自习/答疑), effective_from, effective_to, version, created_at

### schedule_changes（调课/代课记录）
- id, schedule_id, change_type(调课/代课/停课), from_teacher_id, to_teacher_id, from_date, to_date, reason, operator_id, created_at

### notices（通知）
- id, title, type(课务调整/考试/其他), content, share_token(唯一，用于生成链接), publish_status, created_by, created_at, published_at

### upload_tasks（教学计划上传任务）
- id, title, description, target_role / target_user_ids(JSON), requirement, deadline, allow_file_types, created_by, created_at

### uploads（上传文件）
- id, task_id, uploader_id, filename, stored_path, uploaded_at

### audit_logs（审计日志）
- id, user_id, action, target, detail, created_at

## 5. API 设计（技能友好）

统一前缀 `/api`，JSON 返回 `{ ok, data | error }`。认证通过 `Authorization: Bearer <token>`。

- `POST /api/auth/login`、`GET /api/auth/me`
- 用户：`GET/POST /api/users`、`PATCH /api/users/:id`
- 班级：`GET/POST/PATCH /api/classes`
- 教师：`GET/POST/PATCH /api/teachers`
- 课表：`GET /api/schedules`、`POST /api/schedules/import`（Excel/CSV）、`POST /api/schedules/adjust`（调课/代课）、`GET /api/schedules/summary`
- 通知：`GET/POST /api/notices`、`GET /api/notices/share/:token`（无需登录）
- 上传任务：`GET/POST /api/upload-tasks`、`POST /api/upload-tasks/:id/files`、`GET /api/upload-tasks/:id/files`、`GET /api/files/:id/download`

**技能化考量**：每个端点职责单一、幂等，参数显式；后续可把「导入课表」「汇总统计」「生成通知链接」等封装为 Claude / WorkBuddy 技能，直接调用这些 API。

## 6. 错误处理与安全

- 统一错误中间件，返回结构化错误；SQL 错误不泄漏堆栈。
- 密码 bcrypt 哈希；JWT 过期 7 天；角色中间件控制权限。
- 文件上传校验扩展名与大小（默认 20MB）；下载走鉴权端点。
- 通知分享链接用随机 token，不暴露内部 ID。

## 7. 验证方式

- 后端：手动 curl 冒烟 + 关键端点自测脚本。
- 前端：启动 Vite 后浏览器操作核心流程（登录 → 建班级/教师 → 导入课表 → 拖拽调课 → 发通知 → 传文件）。
- 见 `README.md` 启动说明。
