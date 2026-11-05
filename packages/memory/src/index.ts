import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync, inflateSync } from "node:zlib";

import { loadConfig } from "@openclaw/config";
import {
  createDocumentRepository,
  type DatabaseConnection,
  type DocumentChunkSearchRecord
} from "@openclaw/db";
import type { EmbeddingProvider } from "@openclaw/llm";
import { redactSensitiveText, type AppConfig } from "@openclaw/shared";

export type IngestOptions = {
  folder: string;
  config?: AppConfig;
  database: DatabaseConnection;
  embeddingProvider: EmbeddingProvider;
  chunkSize?: number;
  chunkOverlap?: number;
};

export type IngestedFile = {
  path: string;
  documentId: string;
  status: "created" | "updated" | "unchanged" | "skipped";
  chunks: number;
};

export type IngestResult = {
  workspaceRoot: string;
  folder: string;
  scanned: number;
  ingested: IngestedFile[];
  rejected: string[];
};

export type RetrieveOptions = {
  query: string;
  config?: AppConfig;
  database: DatabaseConnection;
  embeddingProvider: EmbeddingProvider;
  limit?: number;
};

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  citation: string;
  score: number;
  keywordScore: number;
  vectorScore: number;
};

export type RetrievalResult = {
  workspaceRoot: string;
  query: string;
  context: string;
  citations: string[];
  chunks: RetrievedChunk[];
  retrievedChunkIds: string[];
};

const supportedExtensions = new Set([".md", ".txt", ".pdf", ".docx", ".csv", ".json", ".html"]);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export async function ingestFolder(options: IngestOptions): Promise<IngestResult> {
  const config = options.config ?? loadConfig();
  const workspaceRoot = resolveWorkspaceRoot(config.workspace.root);
  const folder = resolveWorkspacePath(workspaceRoot, options.folder);

  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new WorkspacePathError(`Ingestion folder does not exist: ${folder}`);
  }

  const documents = createDocumentRepository(options.database);
  const files = scanFiles(folder, workspaceRoot);
  const ingested: IngestedFile[] = [];

  for (const filePath of files) {
    const sourceUri = pathToFileURL(filePath).href;
    const existing = documents.findBySourceUri(sourceUri);
    const extracted = extractText(filePath);
    const contentHash = hashText(extracted.text);
    const modelSafeText = redactSensitiveText(extracted.text);

    if (existing?.contentHash === contentHash) {
      ingested.push({
        path: filePath,
        documentId: existing.id,
        status: "unchanged",
        chunks: 0
      });
      continue;
    }

    if (modelSafeText.trim() === "") {
      options.database.exec("BEGIN;");
      let documentId: string;

      try {
        const document = documents.upsertDocument({
          title: basename(filePath),
          sourceUri,
          mimeType: extracted.mimeType,
          contentHash
        });

        documents.replaceChunks(document.id, []);
        options.database.exec("COMMIT;");
        documentId = document.id;
      } catch (error) {
        options.database.exec("ROLLBACK;");
        throw error;
      }

      ingested.push({
        path: filePath,
        documentId,
        status: existing ? "updated" : "created",
        chunks: 0
      });
      continue;
    }

    const chunks = chunkText(modelSafeText, {
      size: options.chunkSize ?? 1200,
      overlap: options.chunkOverlap ?? 160
    });
    const embeddings = await options.embeddingProvider.embed(chunks.map((chunk) => chunk.content));
    options.database.exec("BEGIN;");
    let documentId: string;

    try {
      const document = documents.upsertDocument({
        title: basename(filePath),
        sourceUri,
        mimeType: extracted.mimeType,
        contentHash
      });

      documents.replaceChunks(
        document.id,
        chunks.map((chunk, index) => ({
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          metadataJson: JSON.stringify({
            path: filePath,
            start: chunk.start,
            end: chunk.end
          }),
          embedding: embeddings[index] ?? [],
          provider: config.llm.provider,
          model: config.llm.embeddingModel ?? config.llm.chatModel
        }))
      );
      options.database.exec("COMMIT;");
      documentId = document.id;
    } catch (error) {
      options.database.exec("ROLLBACK;");
      throw error;
    }

    ingested.push({
      path: filePath,
      documentId,
      status: existing ? "updated" : "created",
      chunks: chunks.length
    });
  }

  return {
    workspaceRoot,
    folder,
    scanned: files.length,
    ingested,
    rejected: []
  };
}

export async function retrieveContext(options: RetrieveOptions): Promise<RetrievalResult> {
  const config = options.config ?? loadConfig();
  const workspaceRoot = resolveWorkspaceRoot(config.workspace.root);
  const query = normalizeWhitespace(redactSensitiveText(options.query));
  const limit = options.limit ?? 6;

  if (query === "" || limit <= 0) {
    return emptyRetrievalResult(workspaceRoot, query);
  }

  const documents = createDocumentRepository(options.database);
  const rows = documents
    .listChunksWithEmbeddings()
    .map((row) => toRetrievableRow(row, workspaceRoot))
    .filter((row): row is RetrievableRow => row !== null);

  if (rows.length === 0) {
    return emptyRetrievalResult(workspaceRoot, query);
  }

  const keywordMatches = keywordSearch(rows, query, limit * 4);
  const queryEmbedding = (await options.embeddingProvider.embed([query]))[0] ?? [];
  const vectorMatches = vectorSearch(rows, queryEmbedding, limit * 4);
  const chunks = mergeAndRerank(keywordMatches, vectorMatches, limit);
  const citations = unique(chunks.map((chunk) => chunk.citation));

  return {
    workspaceRoot,
    query,
    context: buildRetrievalContext(chunks),
    citations,
    chunks,
    retrievedChunkIds: chunks.map((chunk) => chunk.chunkId)
  };
}

export function formatCitations(citations: string[]): string {
  const uniqueCitations = unique(citations);

  if (uniqueCitations.length === 0) {
    return "";
  }

  return `Sources:\n${uniqueCitations.map((citation) => `- ${citation}`).join("\n")}`;
}

export function scanFiles(folder: string, workspaceRoot = folder): string[] {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const scanRoot = resolveWorkspacePath(root, folder);
  const files: string[] = [];

  for (const entry of readdirSync(scanRoot, { withFileTypes: true })) {
    const fullPath = resolveWorkspacePath(root, resolve(scanRoot, entry.name));

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...scanFiles(fullPath, root));
      }

      continue;
    }

    if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

export function extractText(filePath: string): { text: string; mimeType: string } {
  const extension = extname(filePath).toLowerCase();

  switch (extension) {
    case ".md":
      return { text: readText(filePath), mimeType: "text/markdown" };
    case ".txt":
      return { text: readText(filePath), mimeType: "text/plain" };
    case ".csv":
      return { text: extractCsv(readText(filePath)), mimeType: "text/csv" };
    case ".json":
      return { text: extractJson(readText(filePath)), mimeType: "application/json" };
    case ".html":
      return { text: extractHtml(readText(filePath)), mimeType: "text/html" };
    case ".docx":
      return { text: extractDocx(readFileSync(filePath)), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    case ".pdf":
      return { text: extractPdf(readFileSync(filePath)), mimeType: "application/pdf" };
    default:
      return { text: "", mimeType: "application/octet-stream" };
  }
}

export function chunkText(text: string, options: { size: number; overlap: number }) {
  const normalized = normalizeWhitespace(text);
  const chunks: Array<{ content: string; start: number; end: number; tokenCount: number }> = [];
  let start = 0;

  while (start < normalized.length) {
    const hardEnd = Math.min(start + options.size, normalized.length);
    const end = findChunkEnd(normalized, start, hardEnd);
    const content = normalized.slice(start, end).trim();

    if (content.length > 0) {
      chunks.push({
        content,
        start,
        end,
        tokenCount: estimateTokenCount(content)
      });
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(end - options.overlap, start + 1);
  }

  return chunks;
}

export function resolveWorkspaceRoot(workspaceRoot: string): string {
  assertValidPathInput(workspaceRoot);

  if (isAbsolute(workspaceRoot)) {
    return canonicalizePath(resolve(workspaceRoot));
  }

  const monorepoRoot = findMonorepoRoot(process.cwd());

  return canonicalizePath(resolve(monorepoRoot ?? process.cwd(), workspaceRoot));
}

export function resolveWorkspacePath(workspaceRoot: string, targetPath: string): string {
  assertValidPathInput(targetPath);

  const root = resolveWorkspaceRoot(workspaceRoot);
  const target = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);

  assertInsideWorkspace(target, root);

  return target;
}

export function assertInsideWorkspace(targetPath: string, workspaceRoot: string): void {
  assertValidPathInput(targetPath);
  assertValidPathInput(workspaceRoot);

  const root = canonicalizePath(resolve(workspaceRoot));
  const target = canonicalizePath(resolve(targetPath));

  if (isPathInside(root, target)) {
    return;
  }

  throw new WorkspacePathError(`Path is outside configured workspace: ${target}`);
}

function assertValidPathInput(pathValue: string): void {
  if (pathValue.trim() === "" || pathValue.includes("\0")) {
    throw new WorkspacePathError("Path is empty or contains invalid characters.");
  }
}

function canonicalizePath(pathValue: string): string {
  if (existsSync(pathValue)) {
    return realpathSync.native(pathValue);
  }

  const parent = nearestExistingParent(pathValue);
  const canonicalParent = existsSync(parent) ? realpathSync.native(parent) : resolve(parent);

  return resolve(canonicalParent, relative(parent, pathValue));
}

function nearestExistingParent(pathValue: string): string {
  let current = dirname(pathValue);

  while (!existsSync(current)) {
    const parent = dirname(current);

    if (parent === current) {
      return current;
    }

    current = parent;
  }

  return current;
}

function isPathInside(root: string, target: string): boolean {
  const relation = relative(root, target);

  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

type RetrievableRow = {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  citation: string;
  searchText: string;
  embedding: number[];
};

type ScoredRetrievalRow = {
  row: RetrievableRow;
  keywordScore: number;
  vectorScore: number;
};

function emptyRetrievalResult(workspaceRoot: string, query: string): RetrievalResult {
  return {
    workspaceRoot,
    query,
    context: "",
    citations: [],
    chunks: [],
    retrievedChunkIds: []
  };
}

function toRetrievableRow(row: DocumentChunkSearchRecord, workspaceRoot: string): RetrievableRow | null {
  const filePath = sourceUriToFilePath(row.sourceUri);

  if (!filePath) {
    return null;
  }

  try {
    assertInsideWorkspace(filePath, workspaceRoot);
    assertMetadataPathInsideWorkspace(row.metadataJson, workspaceRoot);
  } catch {
    return null;
  }

  const content = redactSensitiveText(row.content);

  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    chunkIndex: row.chunkIndex,
    content,
    citation: toWorkspaceCitation(filePath, workspaceRoot),
    searchText: `${row.documentTitle}\n${filePath}\n${content}`.toLowerCase(),
    embedding: parseEmbedding(row.embeddingJson)
  };
}

function keywordSearch(rows: RetrievableRow[], query: string, limit: number): ScoredRetrievalRow[] {
  const terms = tokenize(query);

  if (terms.length === 0) {
    return [];
  }

  return rows
    .map((row) => ({
      row,
      keywordScore: scoreKeywordMatch(row.searchText, terms),
      vectorScore: 0
    }))
    .filter((candidate) => candidate.keywordScore > 0)
    .sort((left, right) => right.keywordScore - left.keywordScore || left.row.chunkIndex - right.row.chunkIndex)
    .slice(0, limit);
}

function vectorSearch(rows: RetrievableRow[], queryEmbedding: number[], limit: number): ScoredRetrievalRow[] {
  if (queryEmbedding.length === 0) {
    return [];
  }

  return rows
    .map((row) => ({
      row,
      keywordScore: 0,
      vectorScore: cosineSimilarity(queryEmbedding, row.embedding)
    }))
    .filter((candidate) => candidate.vectorScore > 0)
    .sort((left, right) => right.vectorScore - left.vectorScore || left.row.chunkIndex - right.row.chunkIndex)
    .slice(0, limit);
}

function mergeAndRerank(
  keywordMatches: ScoredRetrievalRow[],
  vectorMatches: ScoredRetrievalRow[],
  limit: number
): RetrievedChunk[] {
  const byChunk = new Map<string, ScoredRetrievalRow>();

  for (const candidate of [...keywordMatches, ...vectorMatches]) {
    const existing = byChunk.get(candidate.row.chunkId);

    byChunk.set(candidate.row.chunkId, {
      row: candidate.row,
      keywordScore: Math.max(existing?.keywordScore ?? 0, candidate.keywordScore),
      vectorScore: Math.max(existing?.vectorScore ?? 0, candidate.vectorScore)
    });
  }

  const candidates = Array.from(byChunk.values());
  const maxKeywordScore = Math.max(1, ...candidates.map((candidate) => candidate.keywordScore));
  const maxVectorScore = Math.max(1, ...candidates.map((candidate) => candidate.vectorScore));

  return candidates
    .map((candidate) => {
      const keywordScore = candidate.keywordScore / maxKeywordScore;
      const vectorScore = candidate.vectorScore / maxVectorScore;
      const score = keywordScore * 0.45 + vectorScore * 0.55 + (keywordScore > 0 && vectorScore > 0 ? 0.1 : 0);

      return {
        chunkId: candidate.row.chunkId,
        documentId: candidate.row.documentId,
        chunkIndex: candidate.row.chunkIndex,
        content: candidate.row.content,
        citation: candidate.row.citation,
        score,
        keywordScore,
        vectorScore
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.keywordScore - left.keywordScore ||
        right.vectorScore - left.vectorScore ||
        left.chunkIndex - right.chunkIndex
    )
    .slice(0, limit);
}

function buildRetrievalContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] Source: ${chunk.citation}\nChunk ID: ${chunk.chunkId}\n${redactSensitiveText(chunk.content)}`
    )
    .join("\n\n");
}

function tokenize(value: string): string[] {
  return unique(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []).slice(0, 32);
}

function scoreKeywordMatch(searchText: string, terms: string[]): number {
  let score = 0;

  for (const term of terms) {
    score += countOccurrences(searchText, term);
  }

  return score;
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let index = value.indexOf(term);

  while (index >= 0) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }

  return count;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const dimensions = Math.min(left.length, right.length);

  if (dimensions === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function parseEmbedding(value: string | null): number[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : [];
  } catch {
    return [];
  }
}

function sourceUriToFilePath(sourceUri: string | null): string | null {
  if (!sourceUri) {
    return null;
  }

  try {
    const url = new URL(sourceUri);

    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

function assertMetadataPathInsideWorkspace(metadataJson: string, workspaceRoot: string): void {
  try {
    const metadata = JSON.parse(metadataJson) as { path?: unknown };

    if (typeof metadata.path === "string") {
      assertInsideWorkspace(
        isAbsolute(metadata.path) ? metadata.path : resolve(workspaceRoot, metadata.path),
        workspaceRoot
      );
    }
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw error;
    }
  }
}

function toWorkspaceCitation(filePath: string, workspaceRoot: string): string {
  const relativePath = relative(workspaceRoot, filePath).split(/[\\/]/).join("/");

  return redactSensitiveText(`workspace/${relativePath}`);
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function extractCsv(value: string): string {
  return parseCsvRows(value)
    .map((row) => row.join(" "))
    .join("\n");
}

function extractJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function extractHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractDocx(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const documentXml = entries.get("word/document.xml") ?? "";

  return decodeHtmlEntities(
    documentXml
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractPdf(buffer: Buffer): string {
  const source = buffer.toString("latin1");
  const streamText = extractPdfStreams(source);
  const directText = extractPdfTextOperators(source);

  return `${streamText}\n${directText}`;
}

function extractPdfStreams(source: string): string {
  const parts: string[] = [];
  const streamRegex = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(source)) !== null) {
    const dictionary = match[1] ?? "";
    const raw = Buffer.from(match[2] ?? "", "latin1");
    let stream = raw;

    if (dictionary.includes("/FlateDecode")) {
      try {
        stream = inflateSync(raw);
      } catch {
        try {
          stream = inflateRawSync(raw);
        } catch {
          continue;
        }
      }
    }

    parts.push(extractPdfTextOperators(stream.toString("latin1")));
  }

  return parts.join("\n");
}

function extractPdfTextOperators(source: string): string {
  const parts: string[] = [];
  const textBlocks = source.match(/BT[\s\S]*?ET/g) ?? [source];

  for (const block of textBlocks) {
    for (const match of block.matchAll(/\((?:\\.|[^\\()])*\)\s*T[jJ]/g)) {
      parts.push(unescapePdfString(match[0].replace(/\)\s*T[jJ]$/, "").slice(1)));
    }

    for (const arrayMatch of block.matchAll(/\[((?:\s*\((?:\\.|[^\\()])*\)\s*-?\d*)+)\]\s*TJ/g)) {
      for (const textMatch of (arrayMatch[1] ?? "").matchAll(/\((?:\\.|[^\\()])*\)/g)) {
        parts.push(unescapePdfString(textMatch[0].slice(1, -1)));
      }
    }
  }

  return parts.join(" ");
}

function readZipEntries(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

  if (eocdOffset < 0) {
    return entries;
  }

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end && buffer.readUInt32LE(offset) === 0x02014b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

    if (compressionMethod === 0) {
      entries.set(fileName, compressed.toString("utf8"));
    }

    if (compressionMethod === 8) {
      entries.set(fileName, inflateRawSync(compressed).toString("utf8"));
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function parseCsvRows(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field.trim());

  if (row.some((cell) => cell !== "")) {
    rows.push(row);
  }

  return rows;
}

function findChunkEnd(text: string, start: number, hardEnd: number): number {
  if (hardEnd >= text.length) {
    return text.length;
  }

  const slice = text.slice(start, hardEnd);
  const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));

  if (sentenceEnd > 200) {
    return start + sentenceEnd + 1;
  }

  const whitespace = slice.lastIndexOf(" ");

  return whitespace > 200 ? start + whitespace : hardEnd;
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function unescapePdfString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([\\()])/g, "$1");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function findMonorepoRoot(start: string): string | null {
  let current = resolve(start);

  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}
