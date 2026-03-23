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

// First account — automatically admin
const ADMIN_EMAIL = "rd.mptrade@gmail.com";

export type UserStatus = "pending" | "approved" | "rejected";
export type UserRole = "admin" | "user";

export interface User {
  id: number;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  status: UserStatus;
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
// All auth functions below call these wrappers to remain sync-compatible.

function _pgUsers(): any { return (globalThis as any).__pgUsers; }

export function getAllUsersSync(): User[] {
  // PG version is async — callers in routes will use getAllUsers() async version
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
  name: string
): Promise<{ ok: true; user: UserPublic } | { ok: false; error: string }> {
  const users = loadUsers();
  const normalizedEmail = email.toLowerCase().trim();

  if (users.find((u) => u.toLowerCase?.() === normalizedEmail || u.email.toLowerCase() === normalizedEmail)) {
    return { ok: false, error: "Пользователь с таким email уже существует" };
  }

  if (password.length < 6) {
    return { ok: false, error: "Пароль должен быть не менее 6 символов" };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const isFirstUser = users.length === 0;
  const isAdminEmail = normalizedEmail === ADMIN_EMAIL.toLowerCase();

  const user: User = {
    id: nextId(users),
    email: normalizedEmail,
    passwordHash,
    name: name.trim(),
    role: isAdminEmail || isFirstUser ? "admin" : "user",
    // Admin email or first user — auto-approved; others wait
    status: isAdminEmail || isFirstUser ? "approved" : "pending",
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
  const users = loadUsers();
  const normalizedEmail = email.toLowerCase().trim();
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

// ── Admin: list all users ─────────────────────────────────────────────────────

export function getAllUsers(): UserPublic[] {
  return loadUsers().map(toPublic);
}

// ── Admin: approve / reject ───────────────────────────────────────────────────

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
}

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

  const user = getUserById(payload.userId);
  if (!user || user.status !== "approved") {
    res.status(401).json({ error: "Доступ запрещён" });
    return;
  }

  req.user = toPublic(user);
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if ((req as AuthRequest).user?.role !== "admin") {
      res.status(403).json({ error: "Требуются права администратора" });
      return;
    }
    next();
  });
}
