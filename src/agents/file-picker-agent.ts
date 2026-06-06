import { VectorSearch } from '../project-context/vector-search';
import type { ProviderRouter } from '../router/provider-router';
import { listFilesTool } from '../tools/list-files';
import { readFileTool } from '../tools/read-file';
import { searchFilesTool } from '../tools/search-files';
import type { AgentInput, AgentOutput, FileSelection } from './types';

export interface FilePickerAgentConfig {
  router?: ProviderRouter;
  policyName?: string;
}

export async function filePickerAgent(
  input: AgentInput,
  config?: FilePickerAgentConfig,
): Promise<AgentOutput<FileSelection>> {
  const { project } = input;
  const request = input.task.request;
  const toolCalls: AgentOutput['toolCalls'] = [];
  const errors: string[] = [];

  try {
    // 1. List the repo structure
    const listStart = performance.now();
    const listResult = await listFilesTool.execute({ maxDepth: 3 });
    const listDuration = performance.now() - listStart;
    toolCalls.push({
      toolName: 'list_files',
      input: { maxDepth: 3 },
      output: { totalCount: listResult.data?.totalCount ?? 0 },
      durationMs: Math.round(listDuration),
    });

    if (!listResult.success || !listResult.data) {
      return {
        success: false,
        error: {
          message: 'Failed to list project files',
          code: 'LIST_FILES_FAILED',
          recoverable: true,
        },
        modelUsed: 'none',
        providerUsed: 'none',
        toolCalls,
      };
    }

    const allFiles = listResult.data.files.map((f) => f.path);

    // 2. Build search queries from the request
    const searchTerms = extractSearchTerms(request);
    const searchQueries: string[] = [];

    // 3. Search for relevant files by name
    for (const term of searchTerms.slice(0, 5)) {
      const searchStart = performance.now();
      const searchResult = await searchFilesTool.execute({
        pattern: term,
        maxResults: 10,
      });
      const searchDuration = performance.now() - searchStart;
      toolCalls.push({
        toolName: 'search_files',
        input: { pattern: term, maxResults: 10 },
        output: { totalMatches: searchResult.data?.totalMatches ?? 0 },
        durationMs: Math.round(searchDuration),
      });
      if (searchResult.success && searchResult.data) {
        searchQueries.push(term);
        for (const r of searchResult.data.results) {
          if (!allFiles.includes(r.path)) {
            allFiles.push(r.path);
          }
        }
      }
    }

    // 4. Look for key project files
    const keyFiles = [
      'package.json',
      'tsconfig.json',
      'README.md',
      'AGENTS.md',
      'knowledge.md',
      '.rdt/config.yaml',
    ];

    const knownFiles = listResult.data.files
      .filter((f) => f.type === 'file')
      .map((f) => f.path);

    // 5. Perform vector/semantic search and merge results
    let vectorResults: Array<{ path: string; score: number; reason: string }> =
      [];
    const projectRoot = project.repoMap.root;
    if (projectRoot) {
      try {
        const vectorSearch = new VectorSearch(projectRoot, config?.router);
        await vectorSearch.init();
        vectorResults = await vectorSearch.search(request, 30);
      } catch (err) {
        errors.push(
          `Vector search failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const vectorMap = new Map(vectorResults.map((r) => [r.path, r]));

    // Score and select files
    const scoredFiles = scoreFiles(request, knownFiles, keyFiles, vectorMap);
    const selected = scoredFiles.slice(0, 15).map((sf) => ({
      path: sf.path,
      reason: sf.reason,
      priority: sf.priority as 'high' | 'medium' | 'low',
    }));

    // 6. Read top-priority files for context
    const topFiles = selected.filter((f) => f.priority === 'high').slice(0, 3);
    for (const file of topFiles) {
      const readStart = performance.now();
      const readResult = await readFileTool.execute({
        path: file.path,
        maxBytes: 8_000,
      });
      const readDuration = performance.now() - readStart;
      toolCalls.push({
        toolName: 'read_file',
        input: { path: file.path, maxBytes: 8_000 },
        output: { truncated: readResult.data?.truncated ?? false },
        durationMs: Math.round(readDuration),
      });
      if (!readResult.success) {
        errors.push(
          `Could not read ${file.path}: ${readResult.error?.message ?? 'unknown'}`,
        );
      }
    }

    let confidence =
      selected.length > 0
        ? Math.min(1, selected.length / 5) * (errors.length === 0 ? 1 : 0.8)
        : 0.3;

    // Fix #8 — LLM fallback when confidence is low (< 0.5) and router is available
    let modelUsed = 'heuristic';
    let providerUsed = 'none';
    if (confidence < 0.5 && config?.router) {
      try {
        const policy = config.policyName ?? 'cheap_fast';
        const fileListStr = knownFiles.slice(0, 300).join('\n');
        const messages = [
          {
            role: 'system' as const,
            content: `You are an AI file picker agent. Given a user request and a list of files in the project, identify which files are most relevant to inspect or edit to fulfill the request.
Return your response as a JSON object of this structure:
{
  "selectedFiles": [
    { "path": "src/utils.ts", "reason": "matches user request", "priority": "high" }
  ]
}
You can choose "high", "medium", or "low" priority for each selected file. Only select up to 5-10 files.`,
          },
          {
            role: 'user' as const,
            content: `Request: ${request}

Files in project:
${fileListStr}`,
          },
        ];

        const res = await config.router.route(
          policy,
          { model: '', messages, max_tokens: 1000, temperature: 0.1 },
          { needsTools: false, needsJson: true },
        );

        if (res.success && res.response?.content) {
          const text = res.response.content;
          const first = text.indexOf('{');
          const last = text.lastIndexOf('}');
          if (first !== -1 && last > first) {
            const parsed = JSON.parse(text.slice(first, last + 1)) as {
              selectedFiles?: Array<{
                path: string;
                reason: string;
                priority: string;
              }>;
            };
            if (parsed.selectedFiles && parsed.selectedFiles.length > 0) {
              const llmSelected = parsed.selectedFiles
                .filter((sf) => knownFiles.includes(sf.path))
                .map((sf) => ({
                  path: sf.path,
                  reason: sf.reason,
                  priority:
                    sf.priority === 'high' ||
                    sf.priority === 'medium' ||
                    sf.priority === 'low'
                      ? (sf.priority as 'high' | 'medium' | 'low')
                      : ('medium' as 'high' | 'medium' | 'low'),
                }));
              if (llmSelected.length > 0) {
                selected.push(...llmSelected);
                // Dedup by path
                const uniqueSelected = Array.from(
                  new Map(selected.map((item) => [item.path, item])).values(),
                );
                selected.length = 0;
                selected.push(...uniqueSelected);
                confidence = 0.8;
                modelUsed = res.response.model;
                providerUsed = res.response.provider;
              }
            }
          }
        }
      } catch (err) {
        errors.push(
          `LLM file picker fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      success: true,
      result: {
        files: selected,
        searchQueries,
        confidence,
      },
      modelUsed,
      providerUsed,
      toolCalls,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { message, code: 'FILE_PICKER_ERROR', recoverable: true },
      modelUsed: 'heuristic',
      providerUsed: 'none',
      toolCalls,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function extractSearchTerms(request: string): string[] {
  // Extract significant words, file paths, and identifiers from the request
  const words = request.split(/[\s,.;:!?()]+/);
  const terms = new Set<string>();

  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z0-9_./-]/g, '').trim();
    if (clean.length < 3) continue;
    if (
      [
        'the',
        'this',
        'that',
        'with',
        'from',
        'fix',
        'add',
        'make',
        'need',
        'want',
        'should',
      ].includes(clean.toLowerCase())
    )
      continue;
    terms.add(clean.toLowerCase());
  }

  // Extract file paths from the request
  const pathMatches = request.match(/[a-zA-Z0-9_./-]+\.[a-zA-Z]+/g);
  if (pathMatches) {
    for (const match of pathMatches) {
      terms.add(match);
    }
  }

  return Array.from(terms);
}

function scoreFiles(
  request: string,
  files: string[],
  keyFiles: string[],
  vectorMap?: Map<string, { score: number; reason: string }>,
): Array<{ path: string; reason: string; priority: string }> {
  const requestLower = request.toLowerCase();
  const requestWords = requestLower
    .split(/[\s,.;:!?()]+/)
    .filter((w) => w.length > 2);
  const scored: Array<{
    path: string;
    score: number;
    reason: string;
    priority: string;
  }> = [];

  // Combine files from directory scan and any extra files found only in vector search
  const allFiles = new Set(files);
  if (vectorMap) {
    for (const path of vectorMap.keys()) {
      allFiles.add(path);
    }
  }

  for (const file of allFiles) {
    const fileLower = file.toLowerCase();
    let score = 0;
    const reasonParts: string[] = [];

    // 1. Vector Search Boost
    const vectorMatch = vectorMap?.get(file);
    if (vectorMatch) {
      const vectorBoost = Math.round(vectorMatch.score * 15);
      score += vectorBoost;
      reasonParts.push(vectorMatch.reason);
    }

    // Boost key project files
    if (keyFiles.includes(file)) {
      score += 10;
      reasonParts.push('key project file');
    }

    // Boost source files over generated/dist
    if (file.startsWith('src/')) score += 3;
    if (file.startsWith('tests/') || file.startsWith('test/')) {
      score += 4;
      reasonParts.push('test file');
    }

    // Boost config files
    if (
      file.endsWith('.json') ||
      file.endsWith('.yaml') ||
      file.endsWith('.yml') ||
      file.endsWith('.toml')
    ) {
      score += 1;
    }

    // Match request words against file path
    for (const word of requestWords) {
      if (fileLower.includes(word)) {
        score += 5;
        reasonParts.push(`matches "${word}"`);
        break;
      }
    }

    // Match file extension relevance
    const ext = file.split('.').pop()?.toLowerCase();
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx')
      score += 2;

    if (score > 0) {
      scored.push({
        path: file,
        score,
        reason:
          reasonParts.length > 0
            ? reasonParts.slice(0, 2).join(', ')
            : 'source file',
        priority: score >= 12 ? 'high' : score >= 6 ? 'medium' : 'low',
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}
