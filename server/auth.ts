// Authentication: users storage, JWT, middleware
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const JWT_SECRET = process.env.JWT_SECRET || "ozonreply-jwt-secret-2026";
const JWT_EXPIRES = "30d";

// First account / superadmin email
const SUPERADMIN_EMAIL = "rd.mptrade@gmail.com";

export type UserStatus = "pending" | "approved" | "rejected";
export type UserRole = "superadmin" | "admin" | "user";

export interface User {
  id: number;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  tenantId: number | null; // null only for superadmin
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
}

export interface UserPublic {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  tenantId: number | null;
  createdAt: string;
  approvedAt?: string;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function loadUsers(): User[] {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveUsers(users: User[]) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── PG-aware wrappers (used when DATABASE_URL is set) ─────────────────────────
// When PG is active, (globalThis as any).__pgUsers contains async helpers.

function _pgUsers(): any { return (globalThis as any).__pgUsers; }

export function getAllUsersSync(): User[] {
  return loadUsers();
}

export async function getAllUsersAsync(): Promise<User[]> {
  const pg = _pgUsers();
  if (pg) return pg.loadUsersPg();
  return loadUsers();
}

function nextId(users: User[]): number {
  return users.length > 0 ? Math.max(...users.map((u) => u.id)) + 1 : 1;
}

export function toPublic(u: User): UserPublic {
  const { passwordHash, approvedBy, ...rest } = u;
  return rest;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

export function signToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token: string): { userId: number } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: number };
  } catch {
    return null;
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function registerUser(
  email: string,
  password: string,
  name: string,
  tenantId: number | null = null
): Promise<{ ok: true; user: UserPublic } | { ok: false; error: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  if (password.length < 6) {
    return { ok: false, error: "Пароль должен быть не менее 6 символов" };
  }

  const isSuperadmin = normalizedEmail === SUPERADMIN_EMAIL.toLowerCase();

  const pg = _pgUsers();
  if (pg) {
    // PG path
    const users: User[] = await pg.loadUsersPg();
    if (users.find((u: User) => u.email.toLowerCase() === normalizedEmail)) {
      return { ok: false, error: "Пользователь с таким email уже существует" };
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const isFirstUser = users.length === 0;
    // Owner of a new tenant is auto-approved (they registered themselves)
    // Only users added manually inside an existing tenant need approval
    const isAutoApproved = isSuperadmin || isFirstUser || !!tenantId;
    const user: User = {
      id: nextId(users),
      email: normalizedEmail,
      passwordHash,
      name: name.trim(),
      role: isSuperadmin ? "superadmin" : (tenantId ? "admin" : "user"),
      status: isAutoApproved ? "approved" : "pending",
      tenantId: isSuperadmin ? null : tenantId,
      createdAt: new Date().toISOString(),
    };
    await pg.saveUserPg(user);
    return { ok: true, user: toPublic(user) };
  }

  // SQLite / file path
  const users = loadUsers();
  if (users.find((u) => u.email.toLowerCase() === normalizedEmail)) {
    return { ok: false, error: "Пользователь с таким email уже существует" };
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const isFirstUser = users.length === 0;
  const isAutoApproved = isSuperadmin || isFirstUser || !!tenantId;
  const user: User = {
    id: nextId(users),
    email: normalizedEmail,
    passwordHash,
    name: name.trim(),
    role: isSuperadmin ? "superadmin" : (tenantId ? "admin" : "user"),
    status: isAutoApproved ? "approved" : "pending",
    tenantId: isSuperadmin ? null : tenantId,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return { ok: true, user: toPublic(user) };
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function loginUser(
  email: string,
  password: string
): Promise<{ ok: true; token: string; user: UserPublic } | { ok: false; error: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  const pg = _pgUsers();
  const users: User[] = pg ? await pg.loadUsersPg() : loadUsers();
  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);

  if (!user) return { ok: false, error: "Неверный email или пароль" };

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return { ok: false, error: "Неверный email или пароль" };

  if (user.status === "pending") {
    return { ok: false, error: "Ваш аккаунт ожидает одобрения администратора" };
  }
  if (user.status === "rejected") {
    return { ok: false, error: "Ваш аккаунт был отклонён администратором" };
  }

  const token = signToken(user.id);
  return { ok: true, token, user: toPublic(user) };
}

// ── Get user by ID ────────────────────────────────────────────────────────────

export function getUserById(id: number): User | undefined {
  return loadUsers().find((u) => u.id === id);
}

export async function getUserByIdAsync(id: number): Promise<User | undefined> {
  const pg = _pgUsers();
  if (pg) {
    const users: User[] = await pg.loadUsersPg();
    return users.find((u: User) => u.id === id);
  }
  return loadUsers().find((u) => u.id === id);
}

// ── Admin: list all users ─────────────────────────────────────────────────────

export function getAllUsers(): UserPublic[] {
  return loadUsers().map(toPublic);
}

// ── Admin: approve / reject ───────────────────────────────────────────────────

export async function updateUserStatusAsync(
  targetId: number,
  status: UserStatus,
  adminEmail: string
): Promise<{ ok: boolean; error?: string }> {
  const pg = _pgUsers();
  if (pg) {
    const users: User[] = await pg.loadUsersPg();
    const user = users.find((u: User) => u.id === targetId);
    if (!user) return { ok: false, error: "Пользователь не найден" };
    const update: any = { status };
    if (status === "approved") {
      update.approvedAt = new Date().toISOString();
      update.approvedBy = adminEmail;
    }
    await pg.updateUserPg(targetId, update);
    return { ok: true };
  }
  // SQLite path
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === targetId);
  if (idx === -1) return { ok: false, error: "Пользователь не найден" };
  users[idx].status = status;
  if (status === "approved") {
    users[idx].approvedAt = new Date().toISOString();
    users[idx].approvedBy = adminEmail;
  }
  saveUsers(users);
  return { ok: true };
}

export function updateUserStatus(
  targetId: number,
  status: UserStatus,
  adminEmail: string
): { ok: boolean; error?: string } {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === targetId);
  if (idx === -1) return { ok: false, error: "Пользователь не найден" };
  users[idx].status = status;
  if (status === "approved") {
    users[idx].approvedAt = new Date().toISOString();
    users[idx].approvedBy = adminEmail;
  }
  saveUsers(users);
  return { ok: true };
}

// ── Admin: delete user ────────────────────────────────────────────────────────

export async function deleteUserAsync(targetId: number): Promise<{ ok: boolean; error?: string }> {
  const pg = _pgUsers();
  if (pg) {
    await pg.deleteUserPg(targetId);
    return { ok: true };
  }
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === targetId);
  if (idx === -1) return { ok: false, error: "Пользователь не найден" };
  users.splice(idx, 1);
  saveUsers(users);
  return { ok: true };
}

export function deleteUser(targetId: number): { ok: boolean; error?: string } {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === targetId);
  if (idx === -1) return { ok: false, error: "Пользователь не найден" };
  users.splice(idx, 1);
  saveUsers(users);
  return { ok: true };
}

// ── Express middleware ────────────────────────────────────────────────────────

export interface AuthRequest extends Request {
  user?: UserPublic;
  tenantId?: number;
}

// Async-aware auth middleware (works with both SQLite and PostgreSQL)
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Необходима авторизация" });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Недействительный токен" });
    return;
  }

  // Use async user lookup to support both SQLite and PostgreSQL
  getUserByIdAsync(payload.userId).then((user) => {
    if (!user || user.status !== "approved") {
      res.status(401).json({ error: "Доступ запрещён" });
      return;
    }
    req.user = toPublic(user);
    // Attach tenantId to request for downstream use
    req.tenantId = user.tenantId ?? undefined;
    next();
  }).catch(() => {
    res.status(500).json({ error: "Ошибка авторизации" });
  });
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const role = (req as AuthRequest).user?.role;
    if (role !== "admin" && role !== "superadmin") {
      res.status(403).json({ error: "Требуются права администратора" });
      return;
    }
    next();
  });
}

export function requireSuperadmin(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if ((req as AuthRequest).user?.role !== "superadmin") {
      res.status(403).json({ error: "Требуются права суперадмина" });
      return;
    }
    next();
  });
}

// ── Tenant helpers ────────────────────────────────────────────────────────────

// Returns tenantId from authenticated request.
// Superadmin has no tenant — throws if called for superadmin without explicit tenantId.
export function getTenantId(req: AuthRequest): number {
  if (req.tenantId !== undefined && req.tenantId !== null) return req.tenantId;
  throw new Error("Tenant не определён для данного пользователя");
}
