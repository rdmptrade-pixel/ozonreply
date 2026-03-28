import {
  type Review, type Response, type Settings, type Tenant,
  type InsertReview, type InsertResponse, type InsertSettings, type InsertTenant,
  type ReviewWithResponse,
  type Question, type QuestionResponse, type QuestionWithResponse,
  type InsertQuestion, type InsertQuestionResponse,
  reviews as reviewsTable,
  responses as responsesTable,
  questions as questionsTable,
  questionResponses as questionResponsesTable,
  tenants as tenantsTable,
} from "@shared/schema";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { eq, sql, and } from "drizzle-orm";
import { createRequire } from "module";
// Works in both ESM (tsx dev) and CJS (esbuild prod bundle)
const _require = typeof require !== "undefined"
  ? require
  : createRequire(/* @vite-ignore */ import.meta.url);

const DATA_DIR = join(process.cwd(), "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const DB_SQLITE_FILE = join(DATA_DIR, "reviews.db");
const PUBLISHED_IDS_FILE = join(DATA_DIR, "published_ids.json");

// ── Ensure data dir ────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// Settings per-tenant: data/settings-{tenantId}.json
function getSettingsFile(tenantId?: number): string {
  if (tenantId && tenantId !== 1) {
    return join(DATA_DIR, `settings-${tenantId}.json`);
  }
  return SETTINGS_FILE;
}

// ── SQLite setup (lazy — only initialized when DATABASE_URL is NOT set) ────────
let _sqlite: any = null;
let _db: any = null;

function getSqlite() {
  if (!_sqlite) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = _require("better-sqlite3");
    ensureDataDir();
    _sqlite = new Database(DB_SQLITE_FILE);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("synchronous = NORMAL");

    const { drizzle } = _require("drizzle-orm/better-sqlite3");
    _db = drizzle(_sqlite);

    // Create tables if they don't exist
    _sqlite.exec(`
      -- Tenants table
      CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        plan TEXT NOT NULL DEFAULT 'trial',
        status TEXT NOT NULL DEFAULT 'active',
        trial_ends_at TEXT,
        created_at TEXT NOT NULL DEFAULT ''
      );

      -- Insert default tenant (id=1) for backward compat if not exists
      INSERT OR IGNORE INTO tenants (id, name, plan, status, created_at)
      VALUES (1, 'Default', 'paid', 'active', '${new Date().toISOString()}');

      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        ozon_review_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL DEFAULT '',
        rating INTEGER NOT NULL DEFAULT 5,
        review_text TEXT NOT NULL DEFAULT '',
        review_date TEXT NOT NULL DEFAULT '',
        has_photos INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new',
        ozon_sku TEXT NOT NULL DEFAULT '',
        ozon_status TEXT NOT NULL DEFAULT '',
        is_answered INTEGER NOT NULL DEFAULT 0,
        auto_published INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        review_id INTEGER NOT NULL,
        response_text TEXT NOT NULL DEFAULT '',
        ai_generated INTEGER NOT NULL DEFAULT 1,
        sheets_row_id TEXT NOT NULL DEFAULT '',
        original_ai_text TEXT NOT NULL DEFAULT '',
        approved_at TEXT,
        published_at TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_reviews_tenant ON reviews(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_ozon_id ON reviews(ozon_review_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
      CREATE INDEX IF NOT EXISTS idx_responses_review_id ON responses(review_id);
      CREATE INDEX IF NOT EXISTS idx_responses_tenant ON responses(tenant_id);

      -- History of all published responses (persists across clearAllData)
      CREATE TABLE IF NOT EXISTS publish_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        ozon_review_id TEXT NOT NULL,
        ozon_sku TEXT NOT NULL DEFAULT '',
        product_name TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL DEFAULT '',
        rating INTEGER NOT NULL DEFAULT 5,
        review_text TEXT NOT NULL DEFAULT '',
        response_text TEXT NOT NULL DEFAULT '',
        original_ai_text TEXT NOT NULL DEFAULT '',
        auto_published INTEGER NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_publish_history_published_at ON publish_history(published_at);
      CREATE INDEX IF NOT EXISTS idx_publish_history_ozon_id ON publish_history(ozon_review_id);
      CREATE INDEX IF NOT EXISTS idx_publish_history_tenant ON publish_history(tenant_id);

      -- Questions module
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        ozon_question_id TEXT NOT NULL,
        product_id TEXT NOT NULL DEFAULT '',
        product_name TEXT NOT NULL DEFAULT '',
        ozon_sku TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL DEFAULT '',
        question_text TEXT NOT NULL DEFAULT '',
        question_date TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        is_answered INTEGER NOT NULL DEFAULT 0,
        auto_published INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS question_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        question_id INTEGER NOT NULL,
        response_text TEXT NOT NULL DEFAULT '',
        original_ai_text TEXT NOT NULL DEFAULT '',
        ai_generated INTEGER NOT NULL DEFAULT 1,
        approved_at TEXT,
        published_at TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_questions_ozon_id ON questions(ozon_question_id);
      CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
      CREATE INDEX IF NOT EXISTS idx_questions_tenant ON questions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_question_responses_question_id ON question_responses(question_id);
      CREATE INDEX IF NOT EXISTS idx_question_responses_tenant ON question_responses(tenant_id);
    `);

    // Migrations (run once, idempotent)
    try { _sqlite.exec("ALTER TABLE publish_history ADD COLUMN original_ai_text TEXT NOT NULL DEFAULT ''"); } catch {}
    try { _sqlite.exec("ALTER TABLE reviews ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { _sqlite.exec("ALTER TABLE responses ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { _sqlite.exec("ALTER TABLE questions ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { _sqlite.exec("ALTER TABLE question_responses ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { _sqlite.exec("ALTER TABLE publish_history ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1"); } catch {}
    // Remove unique constraint on ozon_review_id (now unique per tenant, not globally)
    // SQLite doesn't support DROP CONSTRAINT, but we recreate with index if needed
  }
  return { sqlite: _sqlite, db: _db };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function now(): string {
  return new Date().toISOString();
}

function rowToReview(row: any): Review {
  return {
    ...row,
    hasPhotos: Boolean(row.hasPhotos),
    isAnswered: Boolean(row.isAnswered),
    autoPublished: Boolean(row.autoPublished),
  };
}

function rowToResponse(row: any): Response {
  return {
    ...row,
    aiGenerated: Boolean(row.aiGenerated),
  };
}

// ── Published IDs (persist across clearAllData) ────────────────────────────────
export function loadPublishedIds(): Set<string> {
  try {
    if (existsSync(PUBLISHED_IDS_FILE)) {
      const raw = JSON.parse(readFileSync(PUBLISHED_IDS_FILE, "utf-8"));
      if (Array.isArray(raw)) return new Set<string>(raw);
    }
  } catch {}
  return new Set<string>();
}

export function markPublishedId(ozonReviewId: string): void {
  try {
    const ids = loadPublishedIds();
    ids.add(ozonReviewId);
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PUBLISHED_IDS_FILE, JSON.stringify([...ids], null, 2), "utf-8");
  } catch (e) {
    console.error("[markPublishedId] Failed:", e);
  }
}

// ── Storage interface ──────────────────────────────────────────────────────────
export interface IStorage {
  // Tenants
  getTenants(): Promise<Tenant[]>;
  getTenantById(id: number): Promise<Tenant | null>;
  createTenant(data: InsertTenant): Promise<Tenant>;
  updateTenant(id: number, data: Partial<Tenant>): Promise<Tenant>;

  // Settings (per-tenant)
  getSettings(tenantId?: number): Promise<Settings | null>;
  upsertSettings(data: InsertSettings, tenantId?: number): Promise<Settings>;

  // Reviews
  getReviews(tenantId: number, filters?: { status?: string; rating?: number }): Promise<ReviewWithResponse[]>;
  getReviewById(id: number, tenantId: number): Promise<ReviewWithResponse | null>;
  getReviewByOzonId(ozonReviewId: string, tenantId: number): Promise<ReviewWithResponse | null>;
  createReview(data: InsertReview): Promise<Review>;
  updateReviewStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<Review>;
  getResponseByReviewId(reviewId: number): Promise<Response | null>;
  createResponse(data: InsertResponse): Promise<Response>;
  updateResponse(id: number, data: Partial<InsertResponse & { originalAiText?: string }>): Promise<Response>;
  getStats(tenantId: number): Promise<{ total: number; new: number; pendingApproval: number; approved: number; published: number; rejected: number; autoPublished: number }>;
  clearAllData(tenantId?: number): Promise<void>;

  // Questions
  getQuestions(tenantId: number, filters?: { status?: string; productId?: string }): Promise<QuestionWithResponse[]>;
  getQuestionById(id: number, tenantId: number): Promise<QuestionWithResponse | null>;
  getQuestionByOzonId(ozonQuestionId: string, tenantId: number): Promise<QuestionWithResponse | null>;
  createQuestion(data: InsertQuestion): Promise<Question>;
  updateQuestionStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<Question>;
  getQuestionResponseByQuestionId(questionId: number): Promise<QuestionResponse | null>;
  createQuestionResponse(data: InsertQuestionResponse): Promise<QuestionResponse>;
  updateQuestionResponse(id: number, data: Partial<InsertQuestionResponse & { originalAiText?: string }>): Promise<QuestionResponse>;
  getQuestionStats(tenantId: number): Promise<{ total: number; new: number; pendingApproval: number; approved: number; published: number; rejected: number }>;
}

// ── Implementation ─────────────────────────────────────────────────────────────
class SqliteStorage implements IStorage {

  // ── Tenants ───────────────────────────────────────────────────────────────
  async getTenants(): Promise<Tenant[]> {
    const { sqlite } = getSqlite();
    const rows = sqlite.prepare("SELECT * FROM tenants ORDER BY created_at DESC").all();
    return rows as Tenant[];
  }

  async getTenantById(id: number): Promise<Tenant | null> {
    const { sqlite } = getSqlite();
    const row = sqlite.prepare("SELECT * FROM tenants WHERE id = ?").get(id);
    return row as Tenant | null;
  }

  async createTenant(data: InsertTenant): Promise<Tenant> {
    const { sqlite } = getSqlite();
    const ts = now();
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const result = sqlite.prepare(
      "INSERT INTO tenants (name, plan, status, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      data.name ?? "",
      data.plan ?? "trial",
      data.status ?? "active",
      data.trialEndsAt ?? trialEndsAt,
      ts
    );
    return { id: result.lastInsertRowid as number, name: data.name ?? "", plan: data.plan ?? "trial", status: data.status ?? "active", trialEndsAt: data.trialEndsAt ?? trialEndsAt, createdAt: ts };
  }

  async updateTenant(id: number, data: Partial<Tenant>): Promise<Tenant> {
    const { sqlite } = getSqlite();
    const fields: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(data)) {
      const col = k.replace(/([A-Z])/g, "_$1").toLowerCase();
      fields.push(`${col} = ?`);
      values.push(v);
    }
    values.push(id);
    if (fields.length > 0) {
      sqlite.prepare(`UPDATE tenants SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = sqlite.prepare("SELECT * FROM tenants WHERE id = ?").get(id);
    return row as Tenant;
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async getSettings(tenantId?: number): Promise<Settings | null> {
    const tid = tenantId ?? 1;
    const file = getSettingsFile(tid);
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        return { id: 1, tenantId: tid, ...raw } as Settings;
      }
    } catch {}
    return null;
  }

  async upsertSettings(data: InsertSettings, tenantId?: number): Promise<Settings> {
    const tid = tenantId ?? 1;
    ensureDataDir();
    const file = getSettingsFile(tid);
    writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    return { id: 1, tenantId: tid, ...data };
  }

  // ── Reviews ───────────────────────────────────────────────────────────────
  private attachResponse(review: Review): ReviewWithResponse {
    const { db } = getSqlite();
    const resp = db.select().from(responsesTable)
      .where(eq(responsesTable.reviewId, review.id))
      .get();
    return resp
      ? { ...review, response: rowToResponse(resp) }
      : review;
  }

  async getReviews(tenantId: number, filters?: { status?: string; rating?: number }): Promise<ReviewWithResponse[]> {
    const { sqlite } = getSqlite();
    const rows = sqlite.prepare(`
      SELECT * FROM reviews WHERE tenant_id = ? ORDER BY created_at DESC
    `).all(tenantId);
    const result = rows
      .map(rowToReview)
      .filter((r: Review) => {
        if (filters?.status && r.status !== filters.status) return false;
        if (filters?.rating && r.rating !== filters.rating) return false;
        return true;
      });
    return result.map((r: Review) => this.attachResponse(r));
  }

  async getReviewById(id: number, tenantId: number): Promise<ReviewWithResponse | null> {
    const { sqlite } = getSqlite();
    const row = sqlite.prepare("SELECT * FROM reviews WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    if (!row) return null;
    return this.attachResponse(rowToReview(row));
  }

  async getReviewByOzonId(ozonReviewId: string, tenantId: number): Promise<ReviewWithResponse | null> {
    const { sqlite } = getSqlite();
    const row = sqlite.prepare("SELECT * FROM reviews WHERE ozon_review_id = ? AND tenant_id = ?").get(ozonReviewId, tenantId);
    if (!row) return null;
    return this.attachResponse(rowToReview(row));
  }

  async createReview(data: InsertReview): Promise<Review> {
    const { sqlite } = getSqlite();
    const ts = now();
    const result = sqlite.prepare(`
      INSERT INTO reviews (tenant_id, ozon_review_id, product_id, product_name, author_name, rating, review_text, review_date, has_photos, status, ozon_sku, ozon_status, is_answered, auto_published, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (data as any).tenantId ?? 1,
      data.ozonReviewId,
      data.productId,
      data.productName ?? "",
      data.authorName ?? "",
      data.rating ?? 5,
      data.reviewText ?? "",
      data.reviewDate ?? "",
      data.hasPhotos ? 1 : 0,
      data.status ?? "new",
      data.ozonSku ?? "",
      data.ozonStatus ?? "",
      data.isAnswered ? 1 : 0,
      (data as any).autoPublished ? 1 : 0,
      ts, ts
    );
    const row = sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get(result.lastInsertRowid);
    return rowToReview(row);
  }

  async updateReviewStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<Review> {
    const { db } = getSqlite();
    // Convert booleans to integers for SQLite
    const clean: Record<string, unknown> = { status, updatedAt: now() };
    for (const [k, v] of Object.entries(extra ?? {})) {
      clean[k] = typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v;
    }
    const row = db.update(reviewsTable)
      .set(clean as any)
      .where(eq(reviewsTable.id, id))
      .returning()
      .get();
    if (!row) throw new Error(`Review ${id} not found`);
    return rowToReview(row);
  }

  // ── Responses ─────────────────────────────────────────────────────────────
  async getResponseByReviewId(reviewId: number): Promise<Response | null> {
    const { db } = getSqlite();
    const row = db.select().from(responsesTable)
      .where(eq(responsesTable.reviewId, reviewId))
      .get();
    return row ? rowToResponse(row) : null;
  }

  async createResponse(data: InsertResponse): Promise<Response> {
    const { sqlite } = getSqlite();
    const ts = now();
    const result = sqlite.prepare(`
      INSERT INTO responses (tenant_id, review_id, response_text, ai_generated, sheets_row_id, original_ai_text, approved_at, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (data as any).tenantId ?? 1,
      data.reviewId,
      data.responseText ?? "",
      data.aiGenerated ? 1 : 0,
      data.sheetsRowId ?? "",
      (data as any).originalAiText ?? data.responseText ?? "",
      data.approvedAt instanceof Date ? data.approvedAt.toISOString() : (data.approvedAt ?? null),
      data.publishedAt instanceof Date ? data.publishedAt.toISOString() : (data.publishedAt ?? null),
      ts, ts
    );
    const row = sqlite.prepare("SELECT * FROM responses WHERE id = ?").get(result.lastInsertRowid);
    return rowToResponse(row);
  }

  async updateResponse(id: number, data: Partial<InsertResponse & { originalAiText?: string }>): Promise<Response> {
    const { db } = getSqlite();
    // Convert any Date values to ISO strings for SQLite
    const clean: Record<string, unknown> = { updatedAt: now() };
    for (const [k, v] of Object.entries(data)) {
      clean[k] = v instanceof Date ? v.toISOString() : v;
    }
    const row = db.update(responsesTable)
      .set(clean as any)
      .where(eq(responsesTable.id, id))
      .returning()
      .get();
    if (!row) throw new Error(`Response ${id} not found`);
    return rowToResponse(row);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  async getStats(tenantId: number) {
    const { sqlite } = getSqlite();
    const all = sqlite.prepare("SELECT * FROM reviews WHERE tenant_id = ?").all(tenantId);
    return {
      total: all.length,
      new: all.filter((r: any) => r.status === "new").length,
      pendingApproval: all.filter((r: any) => r.status === "pending_approval").length,
      approved: all.filter((r: any) => r.status === "approved").length,
      published: all.filter((r: any) => r.status === "published").length,
      rejected: all.filter((r: any) => r.status === "rejected").length,
      autoPublished: all.filter((r: any) => Boolean(r.auto_published)).length,
    };
  }

  // ── Publish history ────────────────────────────────────────────────────────────
  recordPublishHistory(entry: {
    tenantId?: number;
    ozonReviewId: string;
    ozonSku: string;
    productName: string;
    authorName: string;
    rating: number;
    reviewText: string;
    responseText: string;
    originalAiText?: string;
    autoPublished: boolean;
    publishedAt: string;
  }): void {
    const { sqlite } = getSqlite();
    // Skip if already recorded for this tenant (idempotent)
    const exists = sqlite.prepare("SELECT id FROM publish_history WHERE ozon_review_id = ? AND tenant_id = ?").get(entry.ozonReviewId, entry.tenantId ?? 1);
    if (exists) return;
    sqlite.prepare(`
      INSERT INTO publish_history (tenant_id, ozon_review_id, ozon_sku, product_name, author_name, rating, review_text, response_text, original_ai_text, auto_published, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.tenantId ?? 1,
      entry.ozonReviewId,
      entry.ozonSku,
      entry.productName,
      entry.authorName,
      entry.rating,
      entry.reviewText,
      entry.responseText,
      entry.originalAiText ?? "",
      entry.autoPublished ? 1 : 0,
      entry.publishedAt,
    );
  }

  getPublishHistory(tenantId: number, from?: string, to?: string): any[] {
    const { sqlite } = getSqlite();
    let query = "SELECT * FROM publish_history WHERE tenant_id = ?";
    const params: any[] = [tenantId];
    if (from && to) {
      query += " AND published_at >= ? AND published_at <= ?";
      params.push(from, to);
    } else if (from) {
      query += " AND published_at >= ?";
      params.push(from);
    } else if (to) {
      query += " AND published_at <= ?";
      params.push(to);
    }
    query += " ORDER BY published_at DESC";
    return sqlite.prepare(query).all(...params) as any[];
  }

  // ── Clear ──────────────────────────────────────────────────────────────────
  async clearAllData(tenantId?: number): Promise<void> {
    const { sqlite } = getSqlite();
    if (tenantId) {
      sqlite.prepare("DELETE FROM responses WHERE tenant_id = ?").run(tenantId);
      sqlite.prepare("DELETE FROM reviews WHERE tenant_id = ?").run(tenantId);
    } else {
      sqlite.prepare("DELETE FROM responses").run();
      sqlite.prepare("DELETE FROM reviews").run();
    }
    console.log(`[clearAllData] DB cleared for tenant=${tenantId ?? "all"}.`);
  }

  // ── Questions ─────────────────────────────────────────────────────────────

  private _attachQuestionResponse(question: Question): QuestionWithResponse {
    const { db } = getSqlite();
    const resp = db.select().from(questionResponsesTable)
      .where(eq(questionResponsesTable.questionId, question.id))
      .get();
    return resp
      ? { ...question, response: this._rowToQR(resp) }
      : question;
  }

  private _rowToQ(row: any): Question {
    return { ...row, isAnswered: Boolean(row.isAnswered || row.is_answered), autoPublished: Boolean(row.autoPublished || row.auto_published) };
  }

  private _rowToQR(row: any): QuestionResponse {
    return { ...row, aiGenerated: Boolean(row.aiGenerated || row.ai_generated) };
  }

  async getQuestions(tenantId: number, filters?: { status?: string; productId?: string }): Promise<QuestionWithResponse[]> {
    const { sqlite } = getSqlite();
    const rows = sqlite.prepare("SELECT * FROM questions WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId);
    const result = rows.map((r: any) => this._rowToQ(r)).filter((q: Question) => {
      if (filters?.status && q.status !== filters.status) return false;
      if (filters?.productId && q.productId !== filters.productId) return false;
      return true;
    });
    return result.map((q: Question) => this._attachQuestionResponse(q));
  }

  async getQuestionById(id: number, tenantId: number): Promise<QuestionWithResponse | null> {
    const { sqlite } = getSqlite();
    const row = sqlite.prepare("SELECT * FROM questions WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    if (!row) return null;
    return this._attachQuestionResponse(this._rowToQ(row));
  }

  async getQuestionByOzonId(ozonQuestionId: string, tenantId: number): Promise<QuestionWithResponse | null> {
    const { sqlite } = getSqlite();
    const row = sqlite.prepare("SELECT * FROM questions WHERE ozon_question_id = ? AND tenant_id = ?").get(ozonQuestionId, tenantId);
    if (!row) return null;
    return this._attachQuestionResponse(this._rowToQ(row));
  }

  async createQuestion(data: InsertQuestion): Promise<Question> {
    const { sqlite } = getSqlite();
    const ts = now();
    const result = sqlite.prepare(`
      INSERT INTO questions (tenant_id, ozon_question_id, product_id, product_name, ozon_sku, author_name, question_text, question_date, status, is_answered, auto_published, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (data as any).tenantId ?? 1,
      data.ozonQuestionId,
      data.productId ?? "",
      data.productName ?? "",
      data.ozonSku ?? "",
      data.authorName ?? "",
      data.questionText ?? "",
      data.questionDate ?? "",
      data.status ?? "new",
      data.isAnswered ? 1 : 0,
      (data as any).autoPublished ? 1 : 0,
      ts, ts
    );
    const row = sqlite.prepare("SELECT * FROM questions WHERE id = ?").get(result.lastInsertRowid);
    return this._rowToQ(row);
  }

  async updateQuestionStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<Question> {
    const { db } = getSqlite();
    const clean: Record<string, unknown> = { status, updatedAt: now() };
    for (const [k, v] of Object.entries(extra ?? {})) {
      clean[k] = typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v;
    }
    const row = db.update(questionsTable).set(clean as any).where(eq(questionsTable.id, id)).returning().get();
    if (!row) throw new Error(`Question ${id} not found`);
    return this._rowToQ(row);
  }

  async getQuestionResponseByQuestionId(questionId: number): Promise<QuestionResponse | null> {
    const { db } = getSqlite();
    const row = db.select().from(questionResponsesTable)
      .where(eq(questionResponsesTable.questionId, questionId)).get();
    return row ? this._rowToQR(row) : null;
  }

  async createQuestionResponse(data: InsertQuestionResponse): Promise<QuestionResponse> {
    const { sqlite } = getSqlite();
    const ts = now();
    const result = sqlite.prepare(`
      INSERT INTO question_responses (tenant_id, question_id, response_text, original_ai_text, ai_generated, approved_at, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (data as any).tenantId ?? 1,
      data.questionId,
      data.responseText ?? "",
      (data as any).originalAiText ?? data.responseText ?? "",
      data.aiGenerated ? 1 : 0,
      data.approvedAt instanceof Date ? data.approvedAt.toISOString() : (data.approvedAt ?? null),
      data.publishedAt instanceof Date ? data.publishedAt.toISOString() : (data.publishedAt ?? null),
      ts, ts
    );
    const row = sqlite.prepare("SELECT * FROM question_responses WHERE id = ?").get(result.lastInsertRowid);
    return this._rowToQR(row);
  }

  async updateQuestionResponse(id: number, data: Partial<InsertQuestionResponse & { originalAiText?: string }>): Promise<QuestionResponse> {
    const { db } = getSqlite();
    const clean: Record<string, unknown> = { updatedAt: now() };
    for (const [k, v] of Object.entries(data)) {
      clean[k] = v instanceof Date ? v.toISOString() : v;
    }
    const row = db.update(questionResponsesTable).set(clean as any)
      .where(eq(questionResponsesTable.id, id)).returning().get();
    if (!row) throw new Error(`QuestionResponse ${id} not found`);
    return this._rowToQR(row);
  }

  async getQuestionStats(tenantId: number): Promise<{ total: number; new: number; pendingApproval: number; approved: number; published: number; rejected: number }> {
    const { sqlite } = getSqlite();
    const all = sqlite.prepare("SELECT * FROM questions WHERE tenant_id = ?").all(tenantId);
    return {
      total: all.length,
      new: all.filter((q: any) => q.status === "new").length,
      pendingApproval: all.filter((q: any) => q.status === "pending_approval").length,
      approved: all.filter((q: any) => q.status === "approved").length,
      published: all.filter((q: any) => q.status === "published").length,
      rejected: all.filter((q: any) => q.status === "rejected").length,
    };
  }

}

export const storage = new SqliteStorage();

// ── Auto-select storage backend ───────────────────────────────────────────────
// If PG_CONNECTION_STRING is set → use PostgreSQL (Timeweb App Platform)
// Otherwise → use SQLite (local / dev)
export let activeStorage: any = storage; // SQLite by default

export async function initStorage(): Promise<void> {
 if (process.env.PG_CONNECTION_STRING) {
    const { PgStorage, initPgDatabase, loadPublishedIdsPg, markPublishedIdPg,
            loadUsersPg, saveUserPg, updateUserPg, deleteUserPg } = await import("./storage-pg");
    const pgStore = new PgStorage();
    await initPgDatabase();
    await pgStore.resetStuckGenerating();
    await pgStore.backfillPublishedIds();
    activeStorage = pgStore;
    // Override the published ID functions to use PG
    (globalThis as any).__pgPublishedIds = { loadPublishedIdsPg, markPublishedIdPg };
    (globalThis as any).__pgUsers = { loadUsersPg, saveUserPg, updateUserPg, deleteUserPg };
    console.log("[storage] Using PostgreSQL backend");
  } else {
    // Only initialize SQLite when DATABASE_URL is NOT set
    getSqlite(); // triggers lazy init + backfill
    const { sqlite } = getSqlite();
    // Reset any reviews stuck in 'generating' on startup
    try {
      const stuck = sqlite.prepare("UPDATE reviews SET status='new', updated_at=? WHERE status='generating'").run(new Date().toISOString());
      if (stuck.changes > 0) {
        console.log(`[startup] Reset ${stuck.changes} stuck 'generating' review(s) to 'new'`);
      }
    } catch (e) {
      console.error("[startup] Failed to reset stuck reviews:", e);
    }
    // Backfill published IDs from existing DB on startup
    try {
      const pub = loadPublishedIds();
      const rows = sqlite.prepare("SELECT ozon_review_id, status FROM reviews WHERE status = 'published'").all();
      const before = pub.size;
      rows.forEach((r: any) => pub.add(r.ozon_review_id));
      if (pub.size > before) {
        writeFileSync(PUBLISHED_IDS_FILE, JSON.stringify([...pub], null, 2), "utf-8");
        console.log(`[backfill] Added ${pub.size - before} published IDs (total: ${pub.size})`);
      }
    } catch (e) {
      console.error("[backfill] Failed:", e);
    }
    console.log("[storage] Using SQLite backend");
  }
}
