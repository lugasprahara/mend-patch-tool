// mend: one patch tool for every AI edit format (MIT). It reads SPEC.md's four patch formats — unified diffs,
// SEARCH/REPLACE blocks, V4A patches and JSON edit objects — finds the lines each edit names at the first of three
// matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-trimmed), and writes every change or
// none, printing what changed or why each edit failed. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]` with the working directory as the root of the tree.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A text file as lines: its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function toModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, final: fin };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** SPEC.md section 5: the three matching tiers. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchAt(lines: string[], o: string[], i: number, tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) if (!lineEq(lines[i + k]!, o[k]!, tier)) return false;
  return true;
}

/** Every occurrence of O in lines at the first tier that has one, at or after `from`; eofOnly keeps only
 *  occurrences that end at the file's last line. Null when O occurs at no tier. */
function occurrences(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      if (matchAt(lines, o, i, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of N at tier 2, re-indented: a non-blank line starting with O's first line's indent P gets the file's
 *  first matched line's indent F instead. At tiers 0 and 1, and for blank lines, the line is written as it is. */
function reindent(s: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return s;
  if (/^[ \t]*$/.test(s)) return s;
  if (s.startsWith(p)) return f + s.slice(p.length);
  return s;
}

/** One body line of a unified hunk or a V4A chunk: context, old-only, new-only, or a `\` marker line. */
interface Item {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

function itemOf(line: string): Item {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'del', text: line.slice(1) };
  if (c === '+') return { kind: 'add', text: line.slice(1) };
  return { kind: 'bs', text: line.slice(1) };
}

/** The lines a match of O is replaced by: context lines are the file's own matched lines, the rest come from the
 *  patch (re-indented at tier 2). */
function replacementFor(lines: string[], start: number, o: string[], items: Item[], tier: number): string[] {
  const f = lead(lines[start] ?? '');
  const p = lead(o[0] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(lines[start + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else if (it.kind === 'add') {
      out.push(reindent(it.text, tier, f, p));
    }
  }
  return out;
}

/** Whether a `\` line immediately follows the body's last context or `+` line. */
function bsAfterLastCtxAdd(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const k = items[i]!.kind;
    if (k === 'ctx' || k === 'add') return items[i + 1]?.kind === 'bs';
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const fin = before !== '' && before.endsWith(br);
      if (fin) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (fin ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** SPEC.md section 6: unified diffs. */
interface UHunk {
  a: number;
  items: Item[];
}

interface USection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path a `--- `/`+++ ` header line names: up to the first tab, spaces removed, `/dev/null` is no file,
 *  a leading `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = {
      gitOld: undefined,
      gitNew: undefined,
      hasPair: false,
      pairOld: null,
      pairNew: null,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
    } else if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      i += 1;
      const raw: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      cur.hunks.push({ a, items: raw.map(itemOf) });
    } else if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
          cur.hasPair = true;
        } else {
          const s = newSection();
          s.pairOld = headerPath(line);
          s.pairNew = headerPath(next);
          s.hasPair = true;
        }
        i += 2;
      } else {
        if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
      }
    } else {
      if (cur !== null && cur.hunks.length === 0) {
        if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
        else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
        else if (line.startsWith('new file mode')) cur.newFile = true;
        else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      }
      i += 1;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    let oldPath: string | null | undefined;
    let newPath: string | null | undefined;
    if (sec.hasPair) {
      oldPath = sec.pairOld;
      newPath = sec.pairNew;
    } else {
      oldPath = sec.renameFrom ?? sec.gitOld;
      newPath = sec.renameTo ?? sec.gitNew;
    }
    if (oldPath === null || sec.newFile) {
      // A creation: the file is the `+` lines of all the section's hunks.
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const made: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') made.push(it.text);
      let noBreak = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const items = sec.hunks[hi]!.items;
        for (let ii = items.length - 1; ii >= 0; ii -= 1) {
          if (items[ii]!.kind === 'add') {
            noBreak = items[ii + 1]?.kind === 'bs';
            break outer;
          }
        }
      }
      tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (newPath === null || sec.deletedFile) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldPath ?? '';
    const n = newPath ?? '';
    if (!safe(o)) throw new Fail('unsafe', o);
    if (o !== n && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (o !== n && tree.get(n) !== null) throw new Fail('exists', n);
    const model = toModel(before);
    let d = 0;
    for (const h of sec.hunks) {
      const oLines: string[] = [];
      const nLines: string[] = [];
      for (const it of h.items) {
        if (it.kind === 'ctx' || it.kind === 'del') oLines.push(it.text);
        if (it.kind === 'ctx' || it.kind === 'add') nLines.push(it.text);
      }
      if (oLines.length === 0) {
        const adds = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const pos = Math.max(0, Math.min(h.a + d, model.lines.length));
        const atEnd = pos === model.lines.length;
        model.lines.splice(pos, 0, ...adds);
        if (atEnd) model.final = !bsAfterLastCtxAdd(h.items);
        d += adds.length;
      } else {
        const occ = occurrences(model.lines, oLines, strict);
        if (occ === null) throw new Fail('no-match', o);
        const target = h.a - 1 + d;
        let best = occ.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of occ.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const rep = replacementFor(model.lines, best, oLines, h.items, occ.tier);
        const runsToEnd = best + oLines.length === model.lines.length;
        model.lines.splice(best, oLines.length, ...rep);
        if (runsToEnd) model.final = !bsAfterLastCtxAdd(h.items);
        d += nLines.length - oLines.length;
      }
    }
    const text = fromModel(model);
    if (o !== n) {
      tree.now.set(o, null);
      tree.now.set(n, text);
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, text);
    }
  };
}

/** SPEC.md section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map(
    (b): Edit =>
      (tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.oldLines.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
          return;
        }
        const before = tree.get(b.path);
        if (before === null) throw new Fail('missing', b.path);
        const model = toModel(before);
        const occ = occurrences(model.lines, b.oldLines, strict);
        if (occ === null) throw new Fail('no-match', b.path);
        if (occ.positions.length > 1) throw new Fail('ambiguous', b.path);
        const start = occ.positions[0]!;
        const f = lead(model.lines[start]!);
        const p = lead(b.oldLines[0]!);
        const repLines = b.newLines.map((l) => reindent(l, occ.tier, f, p));
        model.lines.splice(start, b.oldLines.length, ...repLines);
        tree.now.set(b.path, fromModel(model));
      },
  );
}

/** SPEC.md section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

type VSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; line: number; moveTo: string | null; chunks: VChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const secs: VSection[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    const kind = line.startsWith('*** Add File:') ? 'add' : line.startsWith('*** Delete File:') ? 'del' : 'upd';
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'del' ? '*** Delete File:' : '*** Update File:';
    const path = line.slice(prefix.length).trim();
    i += 1;
    const start = i;
    while (i < lastNB && !isHeader(lines[i]!)) i += 1;
    const body = lines.slice(start, i).map((text, k) => ({ text, no: start + k + 1 }));
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, no } of body) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
      secs.push({ kind: 'add', path, fileLines });
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      secs.push({ kind: 'del', path });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let first = true;
      for (const { text, no } of body) {
        if (first && text.startsWith('*** Move to:')) {
          moveTo = text.slice('*** Move to:'.length).trim();
          first = false;
          continue;
        }
        first = false;
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
        } else if (text.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          cur = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          cur.items.push(itemOf(text));
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      secs.push({ kind: 'upd', path, line: secLine, moveTo, chunks });
    }
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const tier of tiers) {
          for (let j = cursor; j < model.lines.length; j += 1) {
            if (lineEq(model.lines[j]!, ch.anchor, tier)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const oLines: string[] = [];
      for (const it of ch.items) if (it.kind === 'ctx' || it.kind === 'del') oLines.push(it.text);
      if (oLines.length === 0) {
        const adds = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
      } else {
        const occ = occurrences(model.lines, oLines, strict, cursor, ch.eof);
        if (occ === null) throw new Fail('no-match', p);
        const start = occ.positions[0]!;
        const rep = replacementFor(model.lines, start, oLines, ch.items, occ.tier);
        model.lines.splice(start, oLines.length, ...rep);
        cursor = start + rep.length;
      }
    }
    const text = fromModel(model);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const consumed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
