import bcrypt from 'bcryptjs';
import { db } from './db.js';

// 创建初始教务员账号（若不存在）
const ADMIN = {
  username: 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
  name: '教务员',
  role: 'admin',
};

const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username);
if (!exists) {
  const hash = bcrypt.hashSync(ADMIN.password, 10);
  db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)')
    .run(ADMIN.username, hash, ADMIN.name, ADMIN.role);
  console.log(`已创建初始管理员账号：${ADMIN.username} / ${ADMIN.password}（请尽快修改密码）`);
} else {
  console.log(`管理员账号已存在：${ADMIN.username}`);
}
