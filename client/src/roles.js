// 前端角色判断工具：统一从 localStorage 的 edu_user 读取当前用户角色，避免各页面重复散落硬编码。
// 岗位制重构（2026-11-05）：8 角色五层。这里是与后端 auth.js 对应的前端单一事实源。
export function currentUser() {
  try { return JSON.parse(localStorage.getItem('edu_user') || '{}'); } catch { return {}; }
}

// ===== 角色组（与 server/src/auth.js 保持一致）=====
export const SYSTEM_ROLES = ['admin'];                                  // 数据库、角色管理独占
export const READONLY_ROLES = ['分管领导'];                              // 纯只读
export const DIRECTOR_ROLES = ['admin', '教务主任'];                     // 业务配置 + 终审 + 建号
export const CLERK_ROLES = ['admin', '教务主任', '教务员'];              // 录入维护
export const RESULT_VIEW_ROLES = ['admin', '分管领导', '教务主任', '教务员']; // 结果查看 + 导出

// 全量业务管理（等价旧「admin+教务员+教务处」，教务处→教务主任）
export const ADMIN_ROLES = ['admin', '教务主任', '教务员'];
// 账号管理：admin + 教务主任（不可改角色）
export const USER_EDIT_ROLES = ['admin', '教务主任'];
// 常规检查配置：admin + 教务主任
export const INSPECTION_CONFIG_ROLES = ['admin', '教务主任'];
// 常规检查提交：admin/教务主任/教务员 + 教研组长/备课组长
export const INSPECTION_SUBMIT_ROLES = ['admin', '教务主任', '教务员', '教研组长', '备课组长'];

// 系统全部有效角色（与后端 VALID_ROLES 一致，供账号管理下拉）
export const VALID_ROLES = ['admin', '分管领导', '教务主任', '教务员', '教研组长', '备课组长', '年级组长', '教师'];

export function hasRole(user, roles) {
  return roles.includes(user?.role);
}

// 兼容旧 API：isAdmin = 全量业务管理视角（admin/教务主任/教务员）
export const isAdmin = (user) => hasRole(user, ADMIN_ROLES);
export const canEditUser = (user) => hasRole(user, USER_EDIT_ROLES);
export const canConfigInspection = (user) => hasRole(user, INSPECTION_CONFIG_ROLES);
export const canSubmitInspection = (user) => hasRole(user, INSPECTION_SUBMIT_ROLES);

// 新增判断工具
export const isReadonly = (user) => hasRole(user, READONLY_ROLES);          // 分管领导
export const canReview = (user) => hasRole(user, DIRECTOR_ROLES);           // 终审（admin/教务主任）
export const canClerk = (user) => hasRole(user, CLERK_ROLES);               // 录入维护
export const canViewResults = (user) => hasRole(user, RESULT_VIEW_ROLES);   // 结果查看
export const isSystemAdmin = (user) => hasRole(user, SYSTEM_ROLES);         // admin 独占
