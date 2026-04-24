import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';

import { ChalkBagError } from '../types.js';

export type ParsedFrontmatterDocument = {
  body: string;
  data: unknown;
};

export function parseFrontmatterDocument(content: string, file: string): ParsedFrontmatterDocument {
  try {
    const document = matter(content);
    return {
      body: document.content,
      data: document.data,
    };
  } catch (error) {
    throw new ChalkBagError({
      kind: 'config',
      file,
      message: `invalid frontmatter: ${extractMessage(error)}`,
      cause: error,
      fix: 'ensure the YAML frontmatter block is valid (check for unescaped colons, tabs, or mismatched quotes)',
    });
  }
}

export function parseYamlDocument(content: string, file: string): unknown {
  try {
    return parseYaml(content);
  } catch (error) {
    throw new ChalkBagError({
      kind: 'config',
      file,
      message: `invalid YAML: ${extractMessage(error)}`,
      cause: error,
      fix: 'check for YAML syntax errors such as unescaped special characters or incorrect indentation',
    });
  }
}

function extractMessage(error: unknown): string {
  return error instanceof Error ? error.message.trim() : 'unable to parse file';
}
