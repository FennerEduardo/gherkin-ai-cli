// gherkin-ai-cli - Minimal glob matching for policy paths (no dependency).
//  - `*` matches within one path segment, `?` one character, `**` any depth
//    ("dir/**" also matches "dir" itself, "**/x" also matches "x").
//  - A pattern without a slash matches the basename at any depth (gitignore style).
//  - Matching is case-insensitive and uses forward slashes.

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p.includes('/')) p = `**/${p}`;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      const before = i === 0 || p[i - 1] === '/';
      const after = p[i + 2] === '/' || i + 2 === p.length;
      if (before && p[i + 2] === '/') {
        re += '(?:.*/)?'; // "**/" -> zero or more directories
        i += 2;
      } else if (before && after) {
        re = re.endsWith('/') ? `${re.slice(0, -1)}(?:/.*)?` : `${re}.*`; // trailing "/**" also matches the directory
        i += 1;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const compiled = new RegExp(`^${re}$`, 'i');
  cache.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(filePath.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/** The first pattern that matches, if any. */
export function firstMatch(filePath: string, patterns: readonly string[]): string | undefined {
  return patterns.find(p => matchesGlob(filePath, p));
}
