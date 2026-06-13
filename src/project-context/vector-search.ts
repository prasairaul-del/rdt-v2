import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProviderRouter } from '../router/provider-router';
import type { RepoMap } from './repo-map';

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'else',
  'then',
  'while',
  'for',
  'each',
  'in',
  'on',
  'at',
  'by',
  'of',
  'to',
  'from',
  'with',
  'about',
  'as',
  'into',
  'like',
  'through',
  'after',
  'before',
  'between',
  'under',
  'over',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'us',
  'me',
  'him',
  'them',
  'let',
  'const',
  'var',
  'function',
  'class',
  'import',
  'export',
  'from',
  'return',
  'try',
  'catch',
  'finally',
  'throw',
  'new',
  'type',
  'interface',
  'async',
  'await',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export interface VectorSearchResult {
  path: string;
  score: number;
  reason: string;
}

interface SqliteQuery<T> {
  all(): T[];
  get(...params: unknown[]): T | null;
}

interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): unknown;
  query<T = unknown>(sql: string): SqliteQuery<T>;
  close(): void;
}

interface TableInfoRow {
  name: string;
}

export class VectorSearch {
  private db?: SqliteDatabase;
  private projectRoot: string;
  private router?: ProviderRouter;

  constructor(projectRoot: string, router?: ProviderRouter) {
    this.projectRoot = projectRoot;
    this.router = router;
  }

  async init(): Promise<void> {
    const rdtDir = join(this.projectRoot, '.rdt');
    if (!existsSync(rdtDir)) {
      mkdirSync(rdtDir, { recursive: true });
    }
    const dbPath = join(rdtDir, 'vector-cache.db');
    const { Database } = await import('bun:sqlite');
    this.db = new Database(dbPath) as SqliteDatabase;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files_index (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        terms_freq TEXT NOT NULL,
        dense_vector TEXT,
        size INTEGER,
        mtime_ms REAL,
        last_indexed_at TEXT NOT NULL
      );
    `);

    // Backwards-compatible migration to add columns if they don't exist
    try {
      const tableInfo = this.db
        .query<TableInfoRow>('PRAGMA table_info(files_index)')
        .all();
      const columns = tableInfo.map((col) => col.name);
      if (!columns.includes('size')) {
        this.db.exec('ALTER TABLE files_index ADD COLUMN size INTEGER;');
      }
      if (!columns.includes('mtime_ms')) {
        this.db.exec('ALTER TABLE files_index ADD COLUMN mtime_ms REAL;');
      }
    } catch (err) {
      // Ignore migration errors
    }
  }

  async indexRepository(repoMap: RepoMap): Promise<number> {
    const db = this.requireDb();
    let indexedCount = 0;
    const fileEntries = repoMap.entries.filter((e) => e.type === 'file');

    // 1. Index new or modified files
    for (const entry of fileEntries) {
      const fullPath = resolve(this.projectRoot, entry.path);
      if (!existsSync(fullPath)) continue;

      // Skip files larger than 500KB to prevent indexing huge bundles
      if (entry.size > 500_000) continue;

      // Check cache using size and mtimeMs
      const cached = db
        .query('SELECT hash, size, mtime_ms FROM files_index WHERE path = ?')
        .get(entry.path) as {
        hash: string;
        size: number | null;
        mtime_ms: number | null;
      } | null;

      if (
        cached &&
        cached.size === entry.size &&
        entry.mtimeMs !== undefined &&
        cached.mtime_ms === entry.mtimeMs
      ) {
        continue;
      }

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const hash = createHash('sha256').update(content).digest('hex');

      if (cached && cached.hash === hash) {
        // If content is same but metadata differed, update metadata in DB to avoid reading next time
        db.run(
          'UPDATE files_index SET size = ?, mtime_ms = ? WHERE path = ?',
          entry.size,
          entry.mtimeMs ?? null,
          entry.path,
        );
        continue;
      }

      // Compute terms frequency
      const tokens = tokenize(content);
      const termsFreq: Record<string, number> = {};
      for (const token of tokens) {
        termsFreq[token] = (termsFreq[token] || 0) + 1;
      }

      // Optionally compute dense vector
      let denseVector: number[] | null = null;
      if (this.router) {
        try {
          // Truncate text for embedding if it's too long
          const embedText = content.substring(0, 8000);
          denseVector = await this.router.embed(embedText);
        } catch (err) {
          // Ignore embedding error, fall back to TF-IDF
        }
      }

      db.run(
        `INSERT OR REPLACE INTO files_index (path, hash, terms_freq, dense_vector, size, mtime_ms, last_indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        entry.path,
        hash,
        JSON.stringify(termsFreq),
        denseVector ? JSON.stringify(denseVector) : null,
        entry.size,
        entry.mtimeMs ?? null,
        new Date().toISOString(),
      );

      indexedCount++;
    }

    // 2. Remove files that no longer exist in the repository
    const dbPaths = (
      db.query('SELECT path FROM files_index').all() as Array<{
        path: string;
      }>
    ).map((r) => r.path);
    const repoPaths = new Set(fileEntries.map((e) => e.path));
    for (const dbPath of dbPaths) {
      if (!repoPaths.has(dbPath)) {
        db.run('DELETE FROM files_index WHERE path = ?', dbPath);
      }
    }

    return indexedCount;
  }

  async search(query: string, limit = 10): Promise<VectorSearchResult[]> {
    const db = this.requireDb();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // 1. Try dense vector search if available
    if (this.router) {
      try {
        const queryVector = await this.router.embed(query);
        const rows = db
          .query(
            'SELECT path, dense_vector FROM files_index WHERE dense_vector IS NOT NULL',
          )
          .all() as Array<{
          path: string;
          dense_vector: string;
        }>;

        if (rows.length > 0) {
          const results: VectorSearchResult[] = [];
          for (const row of rows) {
            const docVector = JSON.parse(row.dense_vector) as number[];
            if (docVector.length !== queryVector.length) continue;

            const score = this.cosineSimilarity(queryVector, docVector);
            if (score > 0) {
              results.push({
                path: row.path,
                score,
                reason: `semantic match (score: ${score.toFixed(2)})`,
              });
            }
          }

          return results.sort((a, b) => b.score - a.score).slice(0, limit);
        }
      } catch (err) {
        // Fall back to TF-IDF
      }
    }

    // 2. TF-IDF sparse similarity search
    const rows = db
      .query('SELECT path, terms_freq FROM files_index')
      .all() as Array<{
      path: string;
      terms_freq: string;
    }>;

    if (rows.length === 0) return [];

    const totalDocs = rows.length;

    // Build document frequency map across all indexed documents
    const docFrequency: Record<string, number> = {};
    const parsedDocs = rows.map((row) => {
      const terms = JSON.parse(row.terms_freq) as Record<string, number>;
      const totalTerms = Object.values(terms).reduce(
        (sum, count) => sum + count,
        0,
      );
      for (const term of Object.keys(terms)) {
        docFrequency[term] = (docFrequency[term] || 0) + 1;
      }
      return { path: row.path, terms, totalTerms };
    });

    // Helper to calculate IDF for a term
    const getIdf = (term: string): number => {
      const df = docFrequency[term] || 0;
      return Math.log(1 + totalDocs / (df + 1)) + 1;
    };

    // Calculate query weights
    const queryCounts: Record<string, number> = {};
    for (const token of queryTokens) {
      queryCounts[token] = (queryCounts[token] || 0) + 1;
    }

    const queryWeights: Record<string, number> = {};
    let queryMagnitudeSq = 0;
    for (const token of Object.keys(queryCounts)) {
      const tf = queryCounts[token] / queryTokens.length;
      const idf = getIdf(token);
      const weight = tf * idf;
      queryWeights[token] = weight;
      queryMagnitudeSq += weight * weight;
    }
    const queryMagnitude = Math.sqrt(queryMagnitudeSq);
    if (queryMagnitude === 0) return [];

    const results: VectorSearchResult[] = [];

    // Calculate cosine similarity for each document
    for (const doc of parsedDocs) {
      if (doc.totalTerms === 0) continue;

      // Compute document magnitude across all its terms
      let docMagnitudeSq = 0;
      for (const [term, count] of Object.entries(doc.terms)) {
        const tf = count / doc.totalTerms;
        const idf = getIdf(term);
        const weight = tf * idf;
        docMagnitudeSq += weight * weight;
      }
      const docMagnitude = Math.sqrt(docMagnitudeSq);
      if (docMagnitude === 0) continue;

      // Compute dot product (only query terms contribute)
      let dotProduct = 0;
      let matchesQuery = false;
      for (const [token, queryWeight] of Object.entries(queryWeights)) {
        const docCount = doc.terms[token] || 0;
        if (docCount > 0) {
          const docTf = docCount / doc.totalTerms;
          const docIdf = getIdf(token);
          const docWeight = docTf * docIdf;
          dotProduct += queryWeight * docWeight;
          matchesQuery = true;
        }
      }

      if (matchesQuery && dotProduct > 0) {
        const score = dotProduct / (queryMagnitude * docMagnitude);
        results.push({
          path: doc.path,
          score,
          reason: `semantic match (score: ${score.toFixed(2)})`,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('VectorSearch database has not been initialized');
    }
    return this.db;
  }
}
