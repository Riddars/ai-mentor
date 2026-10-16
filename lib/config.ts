import { readFileSync } from "node:fs";

export type SimMode = "manual" | "auto-approve" | "auto-block" | "offline";

const SIM_MODES: readonly SimMode[] = [
  "manual",
  "auto-approve",
  "auto-block",
  "offline",
];

// Кто выполняет разбор pull request: `simulate` — заглушка (режимы SimMode ниже),
// `llm` — реальный разбор языковой моделью. Провайдер и модель выбираются
// переменными LLM_PROVIDER / LLM_MODEL (см. lib/llm/chat.ts); провайдер не
// зафиксирован — сейчас provod.ai, возможен переход на Claude.
export type Reviewer = "simulate" | "llm";

const REVIEWERS: readonly Reviewer[] = ["simulate", "llm"];

// Как разбирается коммит при CURATOR_REVIEWER=llm: `diff` — один запрос по изменениям,
// `agent` — агент над копией репозитория (lib/agent). Ответы на комментарии всегда идут по diff.
export type ReviewMode = "diff" | "agent";

const REVIEW_MODES: readonly ReviewMode[] = ["diff", "agent"];

export function reviewMode(): ReviewMode {
  const raw = process.env.REVIEW_MODE ?? "agent";
  if (!REVIEW_MODES.includes(raw as ReviewMode)) {
    throw new Error(`Invalid REVIEW_MODE "${raw}", expected one of: ${REVIEW_MODES.join(", ")}`);
  }
  return raw as ReviewMode;
}

export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  reviewer: Reviewer;
  simMode: SimMode;
  simDelayMs: number;
  simAdminToken: string;
  databasePath: string;
}

let cached: Config | null = null;

/**
 * Database file path. Kept separate from getConfig() so the panel can open the
 * database without requiring the full GitHub App configuration.
 */
export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "./data/curator.db";
}

/**
 * Where project repositories live: the organization and its template repository. The panel
 * links to them when a supervisor sets up a new project; null when GITHUB_ORG is not set.
 */
export function projectsHome(): { org: string; template: string } | null {
  const org = process.env.GITHUB_ORG?.trim();
  return org ? { org, template: process.env.GITHUB_TEMPLATE_REPO?.trim() || "project-template" } : null;
}

function loadPrivateKey(): string {
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFileSync(path, "utf8");
  }
  const base64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (base64) {
    return Buffer.from(base64, "base64").toString("utf8");
  }
  throw new Error(
    "Missing private key: set GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY_BASE64",
  );
}

function parseSimMode(): SimMode {
  const raw = process.env.CURATOR_SIM_MODE ?? "manual";
  if (!SIM_MODES.includes(raw as SimMode)) {
    throw new Error(
      `Invalid CURATOR_SIM_MODE "${raw}", expected one of: ${SIM_MODES.join(", ")}`,
    );
  }
  return raw as SimMode;
}

function parseReviewer(): Reviewer {
  // The simulate default would leave every PR's required check in progress forever, so
  // a production server must choose the reviewer explicitly.
  if (!process.env.CURATOR_REVIEWER && process.env.NODE_ENV === "production") {
    throw new Error("CURATOR_REVIEWER must be set explicitly in production (llm or simulate)");
  }
  const raw = process.env.CURATOR_REVIEWER ?? "simulate";
  if (!REVIEWERS.includes(raw as Reviewer)) {
    throw new Error(
      `Invalid CURATOR_REVIEWER "${raw}", expected one of: ${REVIEWERS.join(", ")}`,
    );
  }
  return raw as Reviewer;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getConfig(): Config {
  if (cached) {
    return cached;
  }
  const reviewer = parseReviewer();
  if (reviewer === "llm" && !process.env.LLM_PROVIDER) {
    throw new Error("CURATOR_REVIEWER=llm requires LLM_PROVIDER to be set");
  }

  cached = {
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: loadPrivateKey(),
    webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
    reviewer,
    simMode: parseSimMode(),
    simDelayMs: Number(process.env.CURATOR_SIM_DELAY_MS ?? "8000"),
    // Guards only the stub reviewer's /api/simulate/conclude, which is closed with the llm reviewer.
    simAdminToken: reviewer === "simulate" ? requireEnv("SIM_ADMIN_TOKEN") : "",
    databasePath: databasePath(),
  };
  return cached;
}
