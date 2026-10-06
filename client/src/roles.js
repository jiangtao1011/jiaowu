// 前端角色判断工具：统一从 localStorage 的 edu_user 读取当前用户角色，避免各页面重复散落硬编码。
export function currentUser() {
  try { return JSON.parse(localStorage.getItem('edu_user') || '{}'); } catch { return {}; }
}

export const ADMIN_ROLES = ['admin', '教务员', '教务处'];
// 账号管理：admin + 教务员（教务员不可改角色/不动 admin）
export const USER_EDIT_ROLES = ['admin', '教务员'];
// 常规检查配置（类型/维度/配置项）：admin + 教务处
export const INSPECTION_CONFIG_ROLES = ['admin', '教务处'];
// 常规检查提交：admin/教务员/教务处 + 教研组长/备课组长
export const INSPECTION_SUBMIT_ROLES = ['admin', '教务员', '教务处', '教研组长', '备课组长'];

export function hasRole(user, roles) {
  return roles.includes(user?.role);
}

export const isAdmin = (user) => hasRole(user, ADMIN_ROLES);
export const canEditUser = (user) => hasRole(user, USER_EDIT_ROLES);
export const canConfigInspection = (user) => hasRole(user, INSPECTION_CONFIG_ROLES);
export const canSubmitInspection = (user) => hasRole(user, INSPECTION_SUBMIT_ROLES);
