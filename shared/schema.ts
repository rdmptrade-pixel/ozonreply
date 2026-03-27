import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Reviews ──────────────────────────────────────────────────────────────────
export const reviews = sqliteTable("reviews", {
  id:            integer("id").primaryKey({ autoIncrement: true }),
  ozonReviewId:  text("ozon_review_id").notNull().unique(),
  productId:     text("product_id").notNull(),
  productName:   text("product_name").notNull().default(""),
  authorName:    text("author_name").notNull().default(""),
  rating:        integer("rating").notNull().default(5),
  reviewText:    text("review_text").notNull().default(""),
  reviewDate:    text("review_date").notNull().default(""),
  hasPhotos:     integer("has_photos", { mode: "boolean" }).notNull().default(false),
  // new | generating | pending_approval | approved | published | rejected
  status:        text("status").notNull().default("new"),
  ozonSku:       text("ozon_sku").notNull().default(""),
  ozonStatus:    text("ozon_status").notNull().default(""),
  isAnswered:    integer("is_answered", { mode: "boolean" }).notNull().default(false),
  autoPublished: integer("auto_published", { mode: "boolean" }).notNull().default(false),
  createdAt:     text("created_at").notNull().default(""),
  updatedAt:     text("updated_at").notNull().default(""),
});

export const insertReviewSchema = createInsertSchema(reviews).omit({ id: true });
export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviews.$inferSelect;

// ── Responses ─────────────────────────────────────────────────────────────────
export const responses = sqliteTable("responses", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  reviewId:       integer("review_id").notNull(),
  responseText:   text("response_text").notNull().default(""),
  aiGenerated:    integer("ai_generated", { mode: "boolean" }).notNull().default(true),
  sheetsRowId:    text("sheets_row_id").notNull().default(""),
  originalAiText: text("original_ai_text").notNull().default(""),
  approvedAt:     text("approved_at"),
  publishedAt:    text("published_at"),
  createdAt:      text("created_at").notNull().default(""),
  updatedAt:      text("updated_at").notNull().default(""),
});

export const insertResponseSchema = createInsertSchema(responses).omit({ id: true });
export type InsertResponse = z.infer<typeof insertResponseSchema>;
export type Response = typeof responses.$inferSelect;

// ── Combined view ─────────────────────────────────────────────────────────────
export type ReviewWithResponse = Review & {
  response?: Response;
};

// ── Questions ─────────────────────────────────────────────────────────────────
export const questions = sqliteTable("questions", {
  id:            integer("id").primaryKey({ autoIncrement: true }),
  ozonQuestionId: text("ozon_question_id").notNull().unique(),
  productId:     text("product_id").notNull().default(""),
  productName:   text("product_name").notNull().default(""),
  ozonSku:       text("ozon_sku").notNull().default(""),
  authorName:    text("author_name").notNull().default(""),
  questionText:  text("question_text").notNull().default(""),
  questionDate:  text("question_date").notNull().default(""),
  // new | generating | pending_approval | approved | published | rejected
  status:        text("status").notNull().default("new"),
  isAnswered:    integer("is_answered", { mode: "boolean" }).notNull().default(false),
  autoPublished: integer("auto_published", { mode: "boolean" }).notNull().default(false),
  createdAt:     text("created_at").notNull().default(""),
  updatedAt:     text("updated_at").notNull().default(""),
});

export const insertQuestionSchema = createInsertSchema(questions).omit({ id: true });
export type InsertQuestion = z.infer<typeof insertQuestionSchema>;
export type Question = typeof questions.$inferSelect;

// ── Question Responses ────────────────────────────────────────────────────────
export const questionResponses = sqliteTable("question_responses", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  questionId:     integer("question_id").notNull(),
  responseText:   text("response_text").notNull().default(""),
  originalAiText: text("original_ai_text").notNull().default(""),
  aiGenerated:    integer("ai_generated", { mode: "boolean" }).notNull().default(true),
  approvedAt:     text("approved_at"),
  publishedAt:    text("published_at"),
  createdAt:      text("created_at").notNull().default(""),
  updatedAt:      text("updated_at").notNull().default(""),
});

export const insertQuestionResponseSchema = createInsertSchema(questionResponses).omit({ id: true });
export type InsertQuestionResponse = z.infer<typeof insertQuestionResponseSchema>;
export type QuestionResponse = typeof questionResponses.$inferSelect;

export type QuestionWithResponse = Question & {
  response?: QuestionResponse;
};

// ── Settings (kept in JSON file — unchanged) ──────────────────────────────────
// Settings are still stored in data/settings.json via MemStorage
export interface InsertSettings {
  ozonClientId: string;
  ozonApiKey: string;
  questionApiKey: string;
  openaiApiKey: string;
  deepseekApiKey: string;
  perplexityApiKey: string;
  aiProvider: string;
  googleSheetsId: string;
  responseTemplate: string;
  questionTemplate: string;
  autoPublish: boolean;
  syncInterval: number;
}
export type Settings = InsertSettings & { id: number };

// ── Product Cache (описания товаров из Ozon, по SKU) ──────────────────────────
export interface ProductCache {
  id: number;
  ozonSku: string;
  productId: string;
  name: string;
  description: string;
  attributes: string;
  updatedAt: string;
}
