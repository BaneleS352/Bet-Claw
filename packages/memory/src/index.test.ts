import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "@openclaw/db";
import type { AppConfig } from "@openclaw/shared";

import { ingestFolder, retrieveContext, WorkspacePathError } from "./index.js";

function createConfig(root: string): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 3001
    },
    llm: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "test",
      chatModel: "chat",
      embeddingModel: "embed"
    },
    network: {
      mode: "offline",
      allowLoopback: true,
      allowedHosts: ["127.0.0.1", "localhost"]
    },
    workspace: {
      root
    },
    agentOs: {
      enabled: false,
      heartbeatIntervalMs: 30_000,
      jobsPerHeartbeat: 5,
      jobRetryDelayMs: 1_000
    }
  };
}

const embeddingProvider = {
  async embed(input: string[]) {
    return input.map((item, index) => [index, item.length]);
  }
};

const semanticEmbeddingProvider = {
  async embed(input: string[]) {
    return input.map((item) => {
      const normalized = item.toLowerCase();

      return [
        normalized.includes("security") || normalized.includes("access") ? 1 : 0,
        normalized.includes("quarter") || normalized.includes("q1") ? 1 : 0,
        0.1
      ];
    });
  }
};

describe("memory ingestion", () => {
  it("ingests supported local files into document, chunk, and embedding rows", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-${Date.now()}`);
    const folder = join(workspace, "docs");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "notes.md"), "# Notes\nLocal memory matters.");
    writeFileSync(join(folder, "plain.txt"), "Plain text file.");
    writeFileSync(join(folder, "table.csv"), "name,value\nalpha,1");
    writeFileSync(join(folder, "data.json"), JSON.stringify({ title: "JSON doc" }));
    writeFileSync(join(folder, "page.html"), "<html><body><h1>HTML title</h1></body></html>");
    writeFileSync(join(folder, "paper.pdf"), "BT (PDF text) Tj ET");
    writeFileSync(
      join(folder, "word.docx"),
      createDocxBuffer("<w:document><w:body><w:p><w:r><w:t>DOCX text</w:t></w:r></w:p></w:body></w:document>")
    );
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      const result = await ingestFolder({
        folder: "docs",
        config: createConfig(workspace),
        database,
        embeddingProvider
      });
      const documentCount = countRows(database, "documents");
      const chunkCount = countRows(database, "document_chunks");
      const embeddingCount = countRows(database, "document_embeddings");

      expect(result.scanned).toBe(7);
      expect(result.ingested.every((item) => item.status === "created")).toBe(true);
      expect(documentCount).toBe(7);
      expect(chunkCount).toBeGreaterThan(0);
      expect(embeddingCount).toBe(chunkCount);
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("skips unchanged files and updates changed files on re-ingestion", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-${Date.now()}`);
    const folder = join(workspace, "docs");
    const file = join(folder, "notes.txt");
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, "first version");
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      await ingestFolder({
        folder: "docs",
        config: createConfig(workspace),
        database,
        embeddingProvider
      });
      const unchanged = await ingestFolder({
        folder: "docs",
        config: createConfig(workspace),
        database,
        embeddingProvider
      });
      writeFileSync(file, "second version with new words");
      const updated = await ingestFolder({
        folder: "docs",
        config: createConfig(workspace),
        database,
        embeddingProvider
      });

      expect(unchanged.ingested[0]?.status).toBe("unchanged");
      expect(updated.ingested[0]?.status).toBe("updated");
      expect(countRows(database, "documents")).toBe(1);
      expect(
        database.prepare("SELECT content FROM document_chunks LIMIT 1").get() as
          | { content: string }
          | undefined
      ).toMatchObject({ content: "second version with new words" });
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects folders outside the configured workspace", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-${Date.now()}`);
    const outside = join(tmpdir(), `openclaw-outside-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const database = openDatabase(":memory:");

    try {
      migrate(database);

      await expect(
        ingestFolder({
          folder: outside,
          config: createConfig(workspace),
          database,
          embeddingProvider
        })
      ).rejects.toBeInstanceOf(WorkspacePathError);
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("redacts sensitive values before chunk storage and embedding", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-${Date.now()}`);
    const folder = join(workspace, "docs");
    const embeddedInputs: string[][] = [];
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "secrets.txt"), "api_key=abc123 Bearer sk-local-secret should stay local.");
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      await ingestFolder({
        folder: "docs",
        config: createConfig(workspace),
        database,
        embeddingProvider: {
          async embed(input) {
            embeddedInputs.push(input);

            return input.map((item, index) => [index, item.length]);
          }
        }
      });
      const chunk = database.prepare("SELECT content FROM document_chunks LIMIT 1").get() as
        | { content: string }
        | undefined;

      expect(chunk?.content).toContain("api_key=[REDACTED]");
      expect(chunk?.content).toContain("Bearer [REDACTED]");
      expect(chunk?.content).not.toContain("abc123");
      expect(chunk?.content).not.toContain("sk-local-secret");
      expect(JSON.stringify(embeddedInputs)).not.toContain("abc123");
      expect(JSON.stringify(embeddedInputs)).not.toContain("sk-local-secret");
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("memory retrieval", () => {
  it("retrieves local context with citations and chunk IDs", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-rag-${Date.now()}`);
    mkdirSync(join(workspace, "policies"), { recursive: true });
    mkdirSync(join(workspace, "notes"), { recursive: true });
    writeFileSync(
      join(workspace, "policies", "security.md"),
      "# Security\nAccess to production requires local approval."
    );
    writeFileSync(join(workspace, "notes", "q1.md"), "# Q1\nQuarter planning uses a separate budget.");
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      await ingestFolder({
        folder: ".",
        config: createConfig(workspace),
        database,
        embeddingProvider: semanticEmbeddingProvider
      });

      const result = await retrieveContext({
        query: "What is the security access policy?",
        config: createConfig(workspace),
        database,
        embeddingProvider: semanticEmbeddingProvider,
        limit: 2
      });

      expect(result.retrievedChunkIds.length).toBeGreaterThan(0);
      expect(result.citations[0]).toBe("workspace/policies/security.md");
      expect(result.context).toContain("workspace/policies/security.md");
      expect(result.context).toContain(result.retrievedChunkIds[0]);
      expect(result.context).not.toContain(workspace);
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("filters stored document rows outside the configured workspace before building context", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-rag-${Date.now()}`);
    const outside = join(tmpdir(), `openclaw-memory-outside-${Date.now()}`);
    const outsideFile = join(outside, "leak.txt");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, "Outside secret leak.");
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      database
        .prepare(
          `
          INSERT INTO documents (id, title, source_uri, mime_type, content_hash)
          VALUES ('outside-doc', 'leak.txt', ?, 'text/plain', 'hash')
        `
        )
        .run(pathToFileURL(outsideFile).href);
      database
        .prepare(
          `
          INSERT INTO document_chunks (id, document_id, chunk_index, content, token_count, metadata_json)
          VALUES ('outside-chunk', 'outside-doc', 0, 'Outside secret leak.', 4, ?)
        `
        )
        .run(JSON.stringify({ path: outsideFile }));
      database
        .prepare(
          `
          INSERT INTO document_embeddings (id, chunk_id, provider, model, dimensions, embedding_json)
          VALUES ('outside-embedding', 'outside-chunk', 'openai-compatible', 'embed', 3, '[1,0,0.1]')
        `
        )
        .run();

      const result = await retrieveContext({
        query: "outside secret leak",
        config: createConfig(workspace),
        database,
        embeddingProvider: semanticEmbeddingProvider
      });

      expect(result.retrievedChunkIds).not.toContain("outside-chunk");
      expect(result.context).not.toContain("Outside secret leak.");
      expect(result.context).toBe("");
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("redacts sensitive values from retrieved model context", async () => {
    const workspace = join(tmpdir(), `openclaw-memory-rag-${Date.now()}`);
    mkdirSync(join(workspace, "policies"), { recursive: true });
    writeFileSync(
      join(workspace, "policies", "security.md"),
      "# Security\nThe fallback credential is api_key=abc123 and Bearer sk-local-secret."
    );
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      await ingestFolder({
        folder: ".",
        config: createConfig(workspace),
        database,
        embeddingProvider: semanticEmbeddingProvider
      });

      const result = await retrieveContext({
        query: "security api_key=abc123",
        config: createConfig(workspace),
        database,
        embeddingProvider: semanticEmbeddingProvider
      });

      expect(result.context).toContain("api_key=[REDACTED]");
      expect(result.context).toContain("Bearer [REDACTED]");
      expect(result.context).not.toContain("abc123");
      expect(result.context).not.toContain("sk-local-secret");
      expect(result.query).not.toContain("abc123");
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function countRows(database: ReturnType<typeof openDatabase>, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };

  return row.count;
}

function createDocxBuffer(documentXml: string): Buffer {
  const fileName = Buffer.from("word/document.xml");
  const content = Buffer.from(documentXml);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(0, 10);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const centralHeader = Buffer.alloc(46);
  const localRecord = Buffer.concat([localHeader, fileName, content]);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(0, 12);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  const centralRecord = Buffer.concat([centralHeader, fileName]);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(1, 8);
  endOfCentralDirectory.writeUInt16LE(1, 10);
  endOfCentralDirectory.writeUInt32LE(centralRecord.length, 12);
  endOfCentralDirectory.writeUInt32LE(localRecord.length, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([localRecord, centralRecord, endOfCentralDirectory]);
}
