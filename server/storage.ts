import {
  type Review, type Response, type Settings,
  type InsertReview, type InsertResponse, type InsertSettings,
  type ReviewWithResponse,
  reviews as reviewsTable,
  responses as responsesTable,
} from "@shared/schema";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { eq, sql } from "drizzle-orm";

const DATA_DIR = join(process.cwd(), "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const DB_SQLITE_FILE = join(DATA_DIR, "reviews.db");
const PUBLISHED_IDS_FILE = join(DATA_DIR, "published_ids.json");

// ── Ensure data dir ────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ── SQLite setup (lazy — only initialized when DATABASE_URL is NOT set) ────────
let _sqlite: any = null;
let _db: any = null;

function getSqlite() {
  if (!_sqlite) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    ensureDataDir();
    _sqlite = new Database(DB_SQLITE_FILE);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("synchronous = NORMAL");

    const { drizzle } = require("drizzle-orm/better-sqlite3");
    _db = drizzle(_sqlite);

    // Create tables if they don't exist
    _sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ozon_review_id TEXT NOT NULL UNIQUE,
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

      CREATE INDEX IF NOT EXISTS idx_reviews_ozon_id ON reviews(ozon_review_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
      CREATE INDEX IF NOT EXISTS idx_responses_review_id ON responses(review_id);

      -- History of all published responses (persists across clearAllData)
      CREATE TABLE IF NOT EXISTS publish_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    `);

    // Migrations (run once, idempotent)
    try { _sqlite.exec("ALTER TABLE publish_history ADD COLUMN original_ai_text TEXT NOT NULL DEFAULT ''"); } catch {}
  }
  return { sqlite: _sqlite, db: _db };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function now(): string {
  return new Date().toISOString();
}

function rowToReview(row: typeof reviewsTable.$inferSelect): Review {
  return {
    ...row,
    hasPhotos: Boolean(row.hasPhotos),
    isAnswered: Boolean(row.isAnswered),
    autoPublished: Boolean(row.autoPublished),
  };
}

function rowToResponse(row: typeof responsesTable.$inferSelect): Response {
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
  getSettings(): Promise<Settings | null>;
  upsertSettings(data: InsertSettings): Promise<Settings>;
  getReviews(filters?: { status?: string; rating?: number }): Promise<ReviewWithResponse[]>;
  getReviewById(id: number): Promise<ReviewWithResponse | null>;
  getReviewByOzonId(ozonReviewId: string): Promise<ReviewWithResponse | null>;
  createReview(data: InsertReview): Promise<Review>;
  updateReviewStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<Review>;
  getResponseByReviewId(reviewId: number): Promise<Response | null>;
  createResponse(data: InsertResponse): Promise<Response>;
  updateResponse(id: number, data: Partial<InsertResponse & { originalAiText?: string }>): Promise<Response>;
  getStats(): Promise<{ total: number; new: number; pendingApproval: number; approved: number; published: number; rejected: number; autoPublished: number }>;
  clearAllData(): Promise<void>;
}

// ── Implementation ─────────────────────────────────────────────────────────────
class SqliteStorage implements IStorage {

  // ── Settings ──────────────────────────────────────────────────────────────
  async getSettings(): Promise<Settings | null> {
    try {
      if (existsSync(SETTINGS_FILE)) {
        const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
        return { id: 1, ...raw } as Settings;
      }
    } catch {}
    return null;
  }

  async upsertSettings(data: InsertSettings): Promise<Settings> {
    ensureDataDir();
    writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
    return { id: 1, ...data };
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

  async getReviews(filters?: { status?: string; rating?: number }): Promise<ReviewWithResponse[]> {
    const { db } = getSqlite();
    const query = db.select().from(reviewsTable);
    const rows = query.orderBy(sql`${reviewsTable.createdAt} DESC`).all();
    const result = rows
      .map(rowToReview)
      .filter(r => {
        if (filters?.status && r.status !== filters.status) return false;
        if (filters?.rating && r.rating !== filters.rating) return false;
        return true;
      });
    return result.map(r => this.attachResponse(r));
  }

  async getReviewById(id: number): Promise<ReviewWithResponse | null> {
    const { db } = getSqlite();
    const row = db.select().from(reviewsTable).where(eq(reviewsTable.id, id)).get();
    if (!row) return null;
    return this.attachResponse(rowToReview(row));
  }

  async getReviewByOzonId(ozonReviewId: string): Promise<ReviewWithResponse | null> {
    const { db } = getSqlite();
    const row = db.select().from(reviewsTable)
      .where(eq(reviewsTable.ozonReviewId, ozonReviewId))
      .get();
    if (!row) return null;
    return this.attachResponse(rowToReview(row));
  }

  async createReview(data: InsertReview): Promise<Review> {
    const { db } = getSqlite();
    const ts = now();
    const row = db.insert(reviewsTable).values({
      ...data,
      // SQLite stores booleans as 0/1
      hasPhotos: data.hasPhotos ? 1 : 0,
      isAnswered: data.isAnswered ? 1 : 0,
      autoPublished: (data as any).autoPublished ? 1 : 0,
      createdAt: ts,
      updatedAt: ts,
    } as any).returning().get();
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
    const { db } = getSqlite();
    const ts = now();
    const row = db.insert(responsesTable).values({
      ...data,
      originalAiText: (data as any).originalAiText ?? data.responseText ?? "",
      approvedAt: data.approvedAt instanceof Date ? data.approvedAt.toISOString() : (data.approvedAt ?? null),
      publishedAt: data.publishedAt instanceof Date ? data.publishedAt.toISOString() : (data.publishedAt ?? null),
      createdAt: ts,
      updatedAt: ts,
    }).returning().get();
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
  async getStats() {
    const { db } = getSqlite();
    const all = db.select().from(reviewsTable).all();
    return {
      total: all.length,
      new: all.filter(r => r.status === "new").length,
      pendingApproval: all.filter(r => r.status === "pending_approval").length,
      approved: all.filter(r => r.status === "approved").length,
      published: all.filter(r => r.status === "published").length,
      rejected: all.filter(r => r.status === "rejected").length,
      autoPublished: all.filter(r => Boolean(r.autoPublished)).length,
    };
  }

  // ── Publish history ────────────────────────────────────────────────────────────
  recordPublishHistory(entry: {
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
    // Skip if already recorded (idempotent)
    const exists = sqlite.prepare("SELECT id FROM publish_history WHERE ozon_review_id = ?").get(entry.ozonReviewId);
    if (exists) return;
    sqlite.prepare(`
      INSERT INTO publish_history (ozon_review_id, ozon_sku, product_name, author_name, rating, review_text, response_text, original_ai_text, auto_published, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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

  getPublishHistory(from?: string, to?: string): any[] {
    const { sqlite } = getSqlite();
    let query = "SELECT * FROM publish_history";
    const params: string[] = [];
    if (from && to) {
      query += " WHERE published_at >= ? AND published_at <= ?";
      params.push(from, to);
    } else if (from) {
      query += " WHERE published_at >= ?";
      params.push(from);
    } else if (to) {
      query += " WHERE published_at <= ?";
      params.push(to);
    }
    query += " ORDER BY published_at DESC";
    return sqlite.prepare(query).all(...params) as any[];
  }

  // ── Clear ──────────────────────────────────────────────────────────────────
  async clearAllData(): Promise<void> {
    const { db } = getSqlite();
    db.delete(responsesTable).run();
    db.delete(reviewsTable).run();
    // publish_history is intentionally NOT cleared — it's the permanent archive
    console.log("[clearAllData] DB cleared. published_ids.json and publish_history preserved.");
  }
}

export const storage = new SqliteStorage();

// ── Auto-select storage backend ───────────────────────────────────────────────
// If DATABASE_URL is set → use PostgreSQL (Timeweb App Platform)
// Otherwise → use SQLite (local / dev)
export let activeStorage: any = storage; // SQLite by default

export async function initStorage(): Promise<void> {
  if (process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL) {
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
      const { db } = getSqlite();
      const pub = loadPublishedIds();
      const rows = db.select({
        ozonReviewId: reviewsTable.ozonReviewId,
        status: reviewsTable.status,
      }).from(reviewsTable).all();
      const before = pub.size;
      rows.filter((r: any) => r.status === "published").forEach((r: any) => pub.add(r.ozonReviewId));
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
