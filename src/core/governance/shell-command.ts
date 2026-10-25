/* ==========================================================================
   gherkin-ai-cli - What a shell command line does, for the agent firewall

   The firewall used to match prefixes on the raw string, so `cat .env`,
   `cat a > src/x.ts`, `ls $(touch x)` and a second command after a newline
   were all allowed. This parses the line the way a POSIX shell splits it
   (quotes, escapes, separators) into simple commands with their argv, and
   reports every construct a prefix cannot vouch for: command and process
   substitution, variable expansion, redirection to a file, here-documents,
   background jobs and unterminated quotes.
   ========================================================================== */

export interface ShellAnalysis {
  /** One argv per simple command (separated by ; && || | & or a newline), quotes removed. */
  commands: string[][];
  /** Constructs that make the line more than its commands' argv. Empty when it is plain. */
  hazards: string[];
  /** Files written or read through redirections (`> f`, `>> f`, `< f`). */
  redirectTargets: string[];
}

const SAFE_REDIRECT_TARGET = /^(\/dev\/null|&\d|&-)$/;

export function analyzeShell(line: string): ShellAnalysis {
  const commands: string[][] = [];
  const hazards = new Set<string>();
  const redirectTargets: string[] = [];
  let argv: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '' | "'" | '"' = '';
  let pendingRedirect = false;

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      if (!SAFE_REDIRECT_TARGET.test(word)) {
        redirectTargets.push(word);
        hazards.add(`redirection to a file (${word})`);
      }
      pendingRedirect = false;
    } else {
      argv.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (pendingRedirect) hazards.add('redirection without a target');
    pendingRedirect = false;
    if (argv.length) commands.push(argv);
    argv = [];
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];

    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') { i++; continue; } // line continuation
      if (next !== undefined) { word += next; inWord = true; i++; }
      continue;
    }
    if (c === '`') { hazards.add('command substitution (`...`)'); word += c; inWord = true; continue; }
    if (c === '$') {
      if (next === '(') hazards.add(line[i + 2] === '(' ? 'arithmetic expansion $((...))' : 'command substitution $(...)');
      else if (next === '{' || (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next))) hazards.add('variable expansion ($...)');
      word += c;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '#' && !inWord) {
      while (i < line.length && line[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === '\r' || c === ';') { endCommand(); continue; }
    if (c === '&') {
      if (next === '&') { i++; endCommand(); continue; }
      if (next === '>') { // &> file
        endWord();
        pendingRedirect = true;
        i++;
        continue;
      }
      // A lone & runs the command in the background, out of sight of the caller.
      hazards.add('background job (&)');
      endCommand();
      continue;
    }
    if (c === '|') {
      if (next === '|' || next === '&') i++;
      endCommand();
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') { hazards.add('process substitution'); word += c; inWord = true; continue; }
    if (c === '<' || c === '>') {
      // "2>" / "1>>": the digits before the operator are a file descriptor, not a word.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
      if (c === '<' && next === '<') {
        hazards.add('here-document (<<)');
        while (line[i + 1] === '<') i++;
        pendingRedirect = true;
        continue;
      }
      if (next === '>' || next === '|') i++;
      if (line[i + 1] === '&') { // >&2, 2>&1
        let j = i + 2;
        while (j < line.length && /[\d-]/.test(line[j])) j++;
        i = j - 1;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    // Unquoted *, ? and [ expand to file names the line never spells out (`cat .*` reads .env).
    if (c === '*' || c === '?' || c === '[') hazards.add('pathname expansion (*, ?, [...])');
    word += c;
    inWord = true;
  }
  if (quote) hazards.add('unterminated quote');
  endCommand();
  return { commands, hazards: [...hazards], redirectTargets };
}

/** argv without the wrappers that only set up the environment: `env A=1 cmd`, `A=1 cmd`, `command cmd`. */
export function unwrapCommand(argv: string[]): string[] {
  let rest = argv;
  for (;;) {
    if (rest[0] === 'env') {
      rest = rest.slice(1);
      // env's own options: -i, -0, -u NAME, --unset=NAME ...
      while (rest[0]?.startsWith('-')) rest = rest.slice(rest[0] === '-u' || rest[0] === '--unset' || rest[0] === '-C' || rest[0] === '--chdir' ? 2 : 1);
    } else if (rest[0] === 'command' || rest[0] === 'builtin') {
      rest = rest.slice(1);
    } else if (rest.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
      rest = rest.slice(1);
    } else {
      return rest;
    }
  }
}
