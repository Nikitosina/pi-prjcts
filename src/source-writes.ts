import type { ToolDiagnostic } from "@earendil-works/pi-durable";

/** How a shell command edits files in place: sed or perl in-place, or an inline python or node script that writes. */
export type SourceWriteVia = "sed -i" | "perl -i" | "python" | "node";
export type SourceWriteCheck = { kind: "none" } | { kind: "source-write"; via: [SourceWriteVia, ...SourceWriteVia[]] };

/** A written target that is unknown until run time: a variable, `{}`, or files piped in. */
const UNKNOWN = "?";
const SCRATCH_PREFIX = /^(?:\/tmp\/|\/private\/tmp\/|\/dev\/)/;
const SCRATCH_NAME = /PI_WORKSPACE_CACHE|TMPDIR|gettempdir|mkdtemp|tmpdir\(\)/;
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "timeout", "xargs", "stdbuf", "caffeinate"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

type Segment = { words: string[]; heredocs: string[] };

/**
 * Split a shell command into simple commands: unquoted words (expansions kept as text, redirect targets dropped) and the bodies of
 * their heredocs and here-strings. A light reader for warnings, not a shell: malformed input yields what it could read.
 */
function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let segment: Segment = { words: [], heredocs: [] };
  let word: string | null = null,
    redirect = false;
  const pending: { delimiter: string; segment: Segment }[] = [];
  const endWord = () => {
    if (word !== null && !redirect) segment.words.push(word);
    if (word !== null) redirect = false;
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (segment.words.length || segment.heredocs.length) out.push(segment);
    segment = { words: [], heredocs: [] };
  };
  const append = (text: string) => (word = (word ?? "") + text);
  const readQuoted = (from: number, quote: string): [string, number] => {
    let text = "",
      i = from;
    for (; i < command.length && command[i] !== quote; i++) {
      if (quote === '"' && command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) i++;
      text += command[i];
    }
    return [text, i + 1];
  };
  const readDelimiter = (from: number): [string, number] => {
    let i = from;
    while (command[i] === " " || command[i] === "\t") i++;
    let text = "";
    while (i < command.length && !/[\s;&|<>()]/.test(command[i]!)) {
      if (command[i] === "'" || command[i] === '"') {
        const [quoted, next] = readQuoted(i + 1, command[i]!);
        text += quoted;
        i = next;
      } else text += command[i++];
    }
    return [text, i];
  };
  for (let i = 0; i < command.length;) {
    const char = command[i]!;
    if (char === "\n") {
      const owners = pending.splice(0);
      endSegment();
      i++;
      for (const { delimiter, segment: owner } of owners) {
        const lines: string[] = [];
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end + 1;
          if (line.trim() === delimiter) break;
          lines.push(line);
        }
        owner.heredocs.push(lines.join("\n"));
      }
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      i++;
    } else if (char === "'" || char === '"') {
      const [quoted, next] = readQuoted(i + 1, char);
      append(quoted);
      i = next;
    } else if (char === "\\") {
      if (command[i + 1] !== "\n") append(command[i + 1] ?? "");
      i += 2;
    } else if (char === "#" && word === null) {
      while (i < command.length && command[i] !== "\n") i++;
    } else if (command.startsWith("<<<", i)) {
      endWord();
      const [text, next] = command[i + 3] === "'" || command[i + 3] === '"' ? readQuoted(i + 4, command[i + 3]!) : readDelimiter(i + 3);
      segment.heredocs.push(text);
      i = next;
    } else if (command.startsWith("<<", i)) {
      endWord();
      const [delimiter, next] = readDelimiter(i + (command[i + 2] === "-" ? 3 : 2));
      pending.push({ delimiter, segment });
      i = next;
    } else if (char === ">" || char === "<" || (char === "&" && command[i + 1] === ">")) {
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      i++;
      while (command[i] === ">" || command[i] === "&" || command[i] === "|") i++;
      redirect = true;
    } else if (";&|()`".includes(char) || command.startsWith("$(", i)) {
      endSegment();
      i += command.startsWith("$(", i) ? 2 : 1;
    } else {
      append(char);
      i++;
    }
  }
  endSegment();
  return out;
}

const base = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const scratch = (target: string) =>
  target !== UNKNOWN && (SCRATCH_PREFIX.test(target.replace(/^[rbfu]*['"`]/i, "")) || SCRATCH_NAME.test(target));

/** sed with -i/-I/--in-place: the files it rewrites, or null when it does not edit in place. */
function sedTargets(args: string[]): string[] | null {
  let inPlace = false,
    script = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      if (arg === "--in-place" || arg.startsWith("--in-place=")) inPlace = true;
      else if (arg === "--expression" || arg === "--file") ((script = true), i++);
      else if (arg.startsWith("--expression=") || arg.startsWith("--file=")) script = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at++) {
        const flag = arg[at]!;
        if (flag === "i" || flag === "I") {
          inPlace = true;
          // BSD sed takes the backup suffix as the next word: `-i ''` or `-i .bak`.
          if (at === arg.length - 1 && (args[i + 1] === "" || /^\.\w+$/.test(args[i + 1] ?? ""))) i++;
          break;
        }
        if (flag === "e" || flag === "f") {
          script = true;
          if (at === arg.length - 1) i++;
          break;
        }
        if (flag === "l") {
          if (at === arg.length - 1) i++;
          break;
        }
      }
      continue;
    }
    operands.push(arg);
  }
  if (!inPlace) return null;
  const files = script ? operands : operands.slice(1);
  return files.length ? files : [UNKNOWN];
}

/** perl with -i in a switch cluster: the files it rewrites, or null when it does not edit in place. */
function perlTargets(args: string[]): string[] | null {
  let inPlace = false,
    script = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg.length === 1) {
      operands.push(arg);
      continue;
    }
    for (let at = 1; at < arg.length; at++) {
      const flag = arg[at]!;
      if (flag === "i") {
        inPlace = true;
        break;
      }
      // These switches take the rest of the cluster (or, for -e/-E, the next word) as their argument.
      if ("eE".includes(flag)) {
        script = true;
        if (at === arg.length - 1) i++;
        break;
      }
      if ("FIMmdDxC".includes(flag)) break;
      if (flag === "0" || flag === "l") while (/[0-7]/.test(arg[at + 1] ?? "")) at++;
    }
  }
  if (!inPlace) return null;
  const files = script ? operands : operands.slice(1);
  return files.length ? files : [UNKNOWN];
}

/** The arguments of the call whose open paren is at `from`, split at top-level commas; an unclosed call gives what it read. */
function callArgs(text: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0,
    current = "",
    quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      current += char;
      if (char === "\\") current += text[++i] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if ("([{".includes(char) && ++depth === 1) continue;
    else if (")]}".includes(char) && --depth === 0) break;
    else if (char === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  return [...args, current.trim()].filter(Boolean);
}

/** The paths an inline python or node script writes (UNKNOWN for a path computed at run time); empty when it only reads. */
function scriptTargets(script: string): string[] {
  const targets: string[] = [];
  for (const match of script.matchAll(/\bopen\s*\(/g)) {
    const args = callArgs(script, match.index + match[0].length - 1);
    const keyword = args.find((arg) => /^mode\s*=/.test(arg))?.replace(/^mode\s*=\s*/, "");
    const mode = keyword ?? (args[1] !== undefined && !/^\w+\s*=/.test(args[1]) ? args[1] : undefined);
    if (mode !== undefined && /['"][^'"]*[wax+][^'"]*['"]/.test(mode)) targets.push(args[0] ?? UNKNOWN);
  }
  for (const match of script.matchAll(/(?:\bPath\s*\(([^()]*)\)|[\w.\]\[]+)\s*\.\s*write_(?:text|bytes)\s*\(/g))
    targets.push(match[1] ?? UNKNOWN);
  for (const match of script.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(/g))
    targets.push(callArgs(script, match.index + match[0].length - 1)[0] ?? UNKNOWN);
  return targets.map((target) => (/^[rbfu]*['"`]/i.test(target) || SCRATCH_NAME.test(target) ? target : UNKNOWN));
}

/** The inline script of a python or node call: its -c/-e argument, or the heredoc it reads from stdin. */
function inlineScript(program: "python" | "node", args: string[], heredocs: string[]): string | null {
  const flags = program === "python" ? ["-c"] : ["-e", "--eval", "-p", "--print"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags.includes(arg)) return args[i + 1] ?? null;
    if (program === "node" && /^--(?:eval|print)=/.test(arg)) return arg.slice(arg.indexOf("=") + 1);
    if (program === "python" && /^-[A-Za-z]*c$/.test(arg) && !arg.startsWith("--")) return args[i + 1] ?? null;
    if (arg === "-m") return null;
    if (arg === "-") break;
    if (!arg.startsWith("-")) return null;
  }
  return heredocs.length ? heredocs.join("\n") : null;
}

type Found = { via: SourceWriteVia; targets: string[] };

/** Writes of the simple command that starts at `words[from]`, following wrappers, `find -exec` and `bash -c`. */
function commandWrites(words: string[], heredocs: string[], from: number, depth: number): Found[] {
  let at = from;
  while (at < words.length && /^[A-Za-z_]\w*=/.test(words[at]!)) at++;
  const word = words[at];
  if (word === undefined) return [];
  const name = base(word),
    args = words.slice(at + 1);
  if (WRAPPERS.has(name)) {
    const next = args.findIndex((arg) => !arg.startsWith("-") && !/^\d+[smhd]?$/.test(arg) && !/^[A-Za-z_]\w*=/.test(arg));
    return next === -1 ? [] : commandWrites(words, heredocs, at + 1 + next, depth);
  }
  if (name === "find") {
    const exec = args.findIndex((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok");
    return exec === -1 ? [] : commandWrites(words, heredocs, at + 2 + exec, depth);
  }
  if (SHELLS.has(name)) {
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = flag === -1 ? undefined : args[flag + 1];
    return script === undefined || depth > 2 ? [] : writesOf(script, depth + 1);
  }
  if (name === "sed" || name === "gsed") {
    const targets = sedTargets(args);
    return targets ? [{ via: "sed -i", targets }] : [];
  }
  if (name === "perl") {
    const targets = perlTargets(args);
    return targets ? [{ via: "perl -i", targets }] : [];
  }
  const program = /^python(?:\d+(?:\.\d+)?)?$/.test(name) ? "python" : name === "node" ? "node" : null;
  if (!program) return [];
  const script = inlineScript(program, args, heredocs);
  const targets = script === null ? [] : scriptTargets(script);
  return targets.length ? [{ via: program, targets }] : [];
}

function writesOf(command: string, depth: number): Found[] {
  return segments(command).flatMap((segment) => commandWrites(segment.words, segment.heredocs, 0, depth));
}

/** Whether `command` edits files through sed/perl in place or an inline python/node script, outside clearly scratch folders. */
export function sourceWrites(command: string): SourceWriteCheck {
  const via = [...new Set(writesOf(command, 0).flatMap((found) => (found.targets.every(scratch) ? [] : [found.via])))];
  const [first, ...rest] = via;
  return first === undefined ? { kind: "none" } : { kind: "source-write", via: [first, ...rest] };
}

/** The model-visible warning for a command that edits source through bash; the command itself runs unchanged. */
export function sourceWriteDiagnostic(command: string): ToolDiagnostic | null {
  const check = sourceWrites(command);
  if (check.kind === "none") return null;
  return {
    severity: "warn",
    code: "projects.bash-source-write",
    message: `This command edits files through bash (${check.via.join(", ")}). Use the edit tool for source edits: it fails when the old text is absent, while sed and str.replace silently do nothing.`,
  };
}
