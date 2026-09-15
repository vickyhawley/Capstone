/**
 * Guide chunker. Takes markdown prose and emits one document with
 * many chunks: split on H2/H3 boundaries first (semantic split), then
 * further split any section over the target size with overlap between
 * successive chunks.
 *
 * Target size and overlap are placeholders pending ADR-0006 (chunking
 * strategy). The current values (800 chars, 100 chars overlap) are
 * chosen for readability with `text-embedding-3-small` and to preserve
 * fact-context across section boundaries; the numbers may shift once
 * ADR-0006 lands with a measured recommendation. `TARGET_CHARS` and
 * `OVERLAP_CHARS` below are the tuning surface.
 */

import { createHash } from 'node:crypto';

import type { ChunkInput, DocumentInput, DocumentWithChunks } from './types.js';

export const TARGET_CHARS = 800;
export const OVERLAP_CHARS = 100;

export interface GuideInput {
  readonly markdown: string;
  readonly slug: string;
  readonly title?: string;
}

interface Section {
  readonly headingPath: readonly string[];
  readonly text: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractH1Title(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  const captured = match?.[1];
  return captured ? captured.trim() : null;
}

/**
 * Split markdown into sections at H2 and H3 boundaries. Preamble
 * before the first H2 (typically the H1 title + intro) becomes its
 * own section with the H1 as the heading path.
 */
function splitIntoSections(markdown: string): readonly Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let currentH2: string | null = null;
  let currentH3: string | null = null;
  const preamble: string[] = [];
  const h1 = extractH1Title(markdown) ?? '';
  let currentSectionLines: string[] = preamble;
  let currentHeadingPath: string[] = h1 ? [h1] : [];

  const flush = (): void => {
    const text = currentSectionLines.join('\n').trim();
    if (text.length > 0) {
      sections.push({ headingPath: [...currentHeadingPath], text });
    }
    currentSectionLines = [];
  };

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+?)\s*$/);
    const h3Match = line.match(/^###\s+(.+?)\s*$/);
    const h2Text = h2Match?.[1]?.trim();
    const h3Text = h3Match?.[1]?.trim();
    if (h2Text) {
      flush();
      currentH2 = h2Text;
      currentH3 = null;
      currentHeadingPath = h1 ? [h1, currentH2] : [currentH2];
      currentSectionLines = [line];
    } else if (h3Text) {
      flush();
      currentH3 = h3Text;
      currentHeadingPath =
        h1 && currentH2
          ? [h1, currentH2, currentH3]
          : currentH2
            ? [currentH2, currentH3]
            : [currentH3];
      currentSectionLines = [line];
    } else {
      currentSectionLines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Split a section text into overlapping windows if it exceeds
 * `TARGET_CHARS`. Windows break on paragraph boundaries where
 * possible (double newline); if no paragraph boundary is available
 * inside the tail-region of a window, we accept a hard cut.
 */
function splitOversizedSection(text: string): readonly string[] {
  if (text.length <= TARGET_CHARS) {
    return [text];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + TARGET_CHARS, text.length);
    let cut = end;
    if (end < text.length) {
      // Prefer a paragraph boundary within the last 200 chars.
      const searchFrom = Math.max(cursor + TARGET_CHARS - 200, cursor + 1);
      const boundary = text.lastIndexOf('\n\n', end);
      if (boundary >= searchFrom) {
        cut = boundary;
      }
    }
    chunks.push(text.slice(cursor, cut).trim());
    if (cut >= text.length) {
      break;
    }
    cursor = Math.max(cut - OVERLAP_CHARS, cursor + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

export function chunkGuide(input: GuideInput): DocumentWithChunks {
  const { markdown, slug } = input;
  if (markdown.trim() === '') {
    throw new Error('chunkGuide called with empty markdown');
  }

  const h1Title = extractH1Title(markdown);
  const title = input.title ?? h1Title ?? slug;
  const sections = splitIntoSections(markdown);

  const chunks: ChunkInput[] = [];
  for (const section of sections) {
    const parts = splitOversizedSection(section.text);
    for (const partText of parts) {
      const ordinal = chunks.length;
      chunks.push({
        ordinal,
        parentOrdinal: null,
        text: partText,
        tokenCount: estimateTokens(partText),
        metadata: {
          guide_slug: slug,
          heading_path: section.headingPath,
          section_title: section.headingPath[section.headingPath.length - 1] ?? title,
        },
      });
    }
  }

  const document: DocumentInput = {
    source: 'markdown',
    sourceRef: `${slug}.md`,
    title,
    url: null,
    contentType: 'guide',
    language: 'en',
    contentHash: sha256(markdown),
    metadata: {
      guide_slug: slug,
      section_count: sections.length,
    },
  };

  return { document, chunks };
}
