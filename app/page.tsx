'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EditorContent,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
  useEditor,
} from '@tiptap/react';
import { InputRule, Mark, Node, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import 'katex/dist/katex.min.css';
import {
  Bold,
  BookOpen,
  CheckCircle2,
  Code2,
  Copy,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Heading3,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Monitor,
  Moon,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Quote,
  Redo2,
  Sigma,
  Strikethrough,
  Sun,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  mergeNotes,
  readLocalNotes,
  readRemoteNotes,
  removeLocalNote,
  removeRemoteNote,
  RemoteSyncUnavailableError,
  type NoteDocument,
  writeLocalNote,
  writeRemoteNote,
} from '@/lib/note-storage';

type ThemePreference = 'system' | 'light' | 'dark';
type SaveState = 'ready' | 'saving' | 'saved' | 'error';
type SyncState = 'checking' | 'disabled' | 'syncing' | 'synced' | 'offline' | 'error';
type PaletteKind = 'blocks' | 'math' | null;
type MathfieldLike = HTMLElement & {
  value: string;
  inlineShortcuts?: Record<string, string>;
  mathModeSpace?: string;
  position: number;
  lastOffset: number;
};

const THEME_KEY = 'mathpad-theme';
const FALLBACK_SHORTCUT_KEY = 'mathpad-fallback-shortcut';
const SIDEBAR_KEY = 'mathpad-sidebar-open';
const DEFAULT_FALLBACK_SHORTCUT = 'Cmd/Ctrl+Shift+M';
let pendingMathFocusId: string | null = null;
type MathFocusPosition = 'start' | 'end';
let pendingMathFocusPosition: MathFocusPosition = 'end';
const discreteSetShorthands: Record<string, string> = {
  N: '\\mathbb{N}',
  Z: '\\mathbb{Z}',
  Q: '\\mathbb{Q}',
  R: '\\mathbb{R}',
  C: '\\mathbb{C}',
};
const disabledDoubledSetShortcuts = ['NN', 'ZZ', 'QQ', 'RR'];
const MATHPAD_CLIPBOARD_TYPE = 'application/x-mathpad-content';

type MathPadClipboardPayload = {
  version: 1;
  openStart: number;
  openEnd: number;
  content: JSONContent[];
};

function normalizeMathShortcuts(latex: string) {
  const withExponents = latex.replace(/(^|[^A-Za-z\\])([a-z])(\d+)/g, (_match, prefix: string, letter: string, digits: string) => `${prefix}${letter}${digits.length === 1 ? `^${digits}` : `^{${digits}}`}`);
  const withNegation = withExponents.replace(/(^|[^A-Za-z\\])(?:neg|not)(?=\s|$)/g, (_match, prefix: string) => `${prefix}\\neg`);
  const protectedTokens: string[] = [];
  const masked = withNegation.replace(/\\(?:mathbb|Bbb|mathbf|mathrm)\{[NZQRC]\}/g, (token) => {
    protectedTokens.push(token);
    return `\uE000${protectedTokens.length - 1}\uE001`;
  });
  const converted = masked.replace(/(^|[^A-Za-z\\])([NZQRC])(?=$|[^A-Za-z])/g, (_match, prefix: string, symbol: string) => `${prefix}${discreteSetShorthands[symbol]}`);
  return converted.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => protectedTokens[Number(index)]);
}

function scriptInputRule(operator: '^' | '_', markName: string) {
  const find = operator === '^'
    ? /(^|[^A-Za-z0-9\\])([A-Za-z0-9]+)(\^)(?:\{([^{}]+)\}|([A-Za-z0-9]+))$/
    : /(^|[^A-Za-z0-9\\])([A-Za-z0-9]+)(_)(?:\{([^{}]+)\}|([A-Za-z0-9]+))$/;

  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const leading = match[1] ?? '';
      const base = match[2] ?? '';
      const script = match[4] ?? match[5] ?? '';
      if (!base || !script) return null;

      const operatorPosition = range.from + leading.length + base.length;
      const hasBraces = Boolean(match[4]);
      const transaction = state.tr;
      const markType = state.schema.marks[markName];
      if (!markType) return null;
      transaction.delete(operatorPosition, operatorPosition + (hasBraces ? 2 : 1));
      if (hasBraces) {
        const closingBracePosition = operatorPosition + script.length;
        transaction.delete(closingBracePosition, closingBracePosition + 1);
      }
      transaction.addMark(operatorPosition, operatorPosition + script.length, markType.create());
      transaction.removeStoredMark(markType);
    },
  });
}

const Superscript = Mark.create({
  name: 'superscript',
  inclusive: false,
  excludes: 'subscript',
  parseHTML() { return [{ tag: 'sup' }]; },
  renderHTML({ HTMLAttributes }) { return ['sup', mergeAttributes(HTMLAttributes), 0]; },
  addInputRules() { return [scriptInputRule('^', this.name)]; },
});

const Subscript = Mark.create({
  name: 'subscript',
  inclusive: false,
  excludes: 'superscript',
  parseHTML() { return [{ tag: 'sub' }]; },
  renderHTML({ HTMLAttributes }) { return ['sub', mergeAttributes(HTMLAttributes), 0]; },
  addInputRules() { return [scriptInputRule('_', this.name)]; },
});

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.at(-1);
  if (!key || event.key.toLowerCase() !== key) return false;
  const wantsMeta = parts.includes('cmd') || parts.includes('command') || parts.includes('meta');
  const wantsCtrl = parts.includes('ctrl') || parts.includes('control');
  const wantsAlt = parts.includes('alt') || parts.includes('option');
  const wantsShift = parts.includes('shift');
  if (wantsMeta && wantsCtrl ? !(event.metaKey || event.ctrlKey) : wantsMeta !== event.metaKey || wantsCtrl !== event.ctrlKey) return false;
  return wantsAlt === event.altKey && wantsShift === event.shiftKey;
}

function requestMathFocus(id: string, position: MathFocusPosition = 'end') {
  pendingMathFocusId = id;
  pendingMathFocusPosition = position;
  window.dispatchEvent(new CustomEvent('mathpad:focus-math', { detail: { id, position } }));
  window.requestAnimationFrame(() => {
    const field = [...document.querySelectorAll('math-field')].find((item) => item.getAttribute('data-math-id') === id) as MathfieldLike | undefined;
    if (!field) return;
    field.focus();
    field.position = position === 'start' ? 0 : field.lastOffset;
    pendingMathFocusId = null;
    pendingMathFocusPosition = 'end';
  });
}

function hasRecoverableMathIssue(latex: string) {
  const braces = (latex.match(/\{/g) ?? []).length - (latex.match(/\}/g) ?? []).length;
  const environments = (latex.match(/\\begin\{/g) ?? []).length - (latex.match(/\\end\{/g) ?? []).length;
  return braces !== 0 || environments !== 0;
}

function hasMultilineMath(latex: string) {
  return /\\displaylines\{|\\begin\{(?:aligned|align|gather|multline|cases)\}/.test(latex);
}

function unwrapAutoWrappedMath(latex: string) {
  const match = latex.trim().match(/^\\displaylines\{([\s\S]*)\}$/);
  return match ? match[1].replace(/\\\\(?:\[[^\]]*\])?/g, '') : latex;
}

function splitTopLevelMath(latex: string) {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  const commands = /\\(?:land|lor|implies|iff|Rightarrow|Leftrightarrow|to|mapsto|in|notin|subseteq|subset|supseteq|cup|cap|leq|geq|neq|mid|therefore|because)(?![A-Za-z])/y;

  for (let index = 0; index < latex.length; index += 1) {
    const character = latex[index];
    if (character === '{') { depth += 1; continue; }
    if (character === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;

    let end = index + 1;
    if ('=+-;,'.includes(character)) {
      // Keep the operator at the end of the line so the proof still reads naturally.
    } else if (character === '\\') {
      commands.lastIndex = index;
      const command = commands.exec(latex);
      if (!command) continue;
      end = index + command[0].length;
    } else {
      continue;
    }

    parts.push(latex.slice(start, end));
    start = end;
    index = end - 1;
  }

  if (start === 0) return [latex];
  parts.push(latex.slice(start));
  return parts.filter((part) => part.length > 0);
}

function estimateMathWidth(latex: string, fontSize: number) {
  const visible = latex
    .replace(/\\[A-Za-z]+/g, 'xx')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ');
  return visible.length * fontSize * 0.58 + fontSize;
}

function wrapDisplayMath(latex: string, availableWidth: number, fontSize: number) {
  const raw = unwrapAutoWrappedMath(latex);
  if (!raw.trim() || hasMultilineMath(raw)) return raw;
  const parts = splitTopLevelMath(raw);
  if (parts.length < 2) return raw;

  const lines: string[] = [];
  let current = '';
  const targetWidth = Math.max(190, availableWidth - 22);
  for (const part of parts) {
    const candidate = current + part;
    if (current && estimateMathWidth(candidate, fontSize) > targetWidth) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 1 ? `\\displaylines{${lines.join('\\\\')}}` : raw;
}

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const timestampNow = () => Date.now();

const emptyContent = (): JSONContent => ({ type: 'doc', content: [{ type: 'paragraph' }] });

function cloneContentWithFreshMathIds(node: JSONContent): JSONContent {
  const cloned: JSONContent = { ...node };
  if (node.attrs) cloned.attrs = { ...node.attrs };
  if (node.type === 'mathInline' || node.type === 'mathBlock') {
    cloned.attrs = { ...cloned.attrs, id: makeId() };
  }
  if (node.content) cloned.content = node.content.map(cloneContentWithFreshMathIds);
  return cloned;
}

function formatNoteDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const isToday = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (isToday) return `Today · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const starterContent: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Logic & proof patterns' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A clean proof names the idea, then makes each step visible. Try the math toggle in the next sentence.' }] },
    {
      type: 'noteBlock',
      attrs: { kind: 'theorem', title: 'Theorem' },
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'If ' },
        { type: 'mathInline', attrs: { id: 'seed-n-even', latex: 'n=2k' } },
        { type: 'text', text: ' for some ' },
        { type: 'mathInline', attrs: { id: 'seed-k-in-z', latex: 'k\\in\\mathbb{Z}' } },
        { type: 'text', text: ', then ' },
        { type: 'mathInline', attrs: { id: 'seed-n2', latex: 'n^2=4k^2' } },
        { type: 'text', text: ' is even.' },
      ] }],
    },
    {
      type: 'noteBlock',
      attrs: { kind: 'proof', title: 'Proof' },
      content: [{ type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Assume ' }, { type: 'mathInline', attrs: { id: 'seed-assume', latex: 'n=2k' } }, { type: 'text', text: '.' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Then ' }, { type: 'mathInline', attrs: { id: 'seed-square', latex: 'n^2=(2k)^2=2(2k^2)' } }, { type: 'text', text: '.' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Therefore the square has a factor of 2, so it is even. ∎' }] }] },
      ] }],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Quick checklist' }] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name the claim' }] }] },
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Show the key implication' }] }] },
    ] },
    { type: 'paragraph' },
  ],
};

function textWithMarks(node: JSONContent): string {
  let text = node.text ?? '';
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') text = `**${text}**`;
    if (mark.type === 'italic') text = `*${text}*`;
    if (mark.type === 'underline') text = `<u>${text}</u>`;
    if (mark.type === 'strike') text = `~~${text}~~`;
    if (mark.type === 'code') text = `\`${text}\``;
    if (mark.type === 'superscript') text = `^{${text}}`;
    if (mark.type === 'subscript') text = `_{${text}}`;
  }
  return text;
}

function nodeToMarkdown(node: JSONContent): string {
  const children = (node.content ?? []).map((child) => nodeToMarkdown(child)).join('');
  switch (node.type) {
    case 'text': return textWithMarks(node);
    case 'mathInline': return `\\(${node.attrs?.latex ?? ''}\\)`;
    case 'mathBlock': return `\n\\[\n${node.attrs?.latex ?? ''}\n\\]\n`;
    case 'paragraph': return `${children}\n\n`;
    case 'heading': return `${'#'.repeat(node.attrs?.level ?? 1)} ${children.trim()}\n\n`;
    case 'bulletList': return `${(node.content ?? []).map((item) => `- ${nodeToMarkdown(item).trim()}\n`).join('')}\n`;
    case 'orderedList': return `${(node.content ?? []).map((item, index) => `${index + 1}. ${nodeToMarkdown(item).trim()}\n`).join('')}\n`;
    case 'taskList': return `${(node.content ?? []).map((item) => `- [${item.attrs?.checked ? 'x' : ' '}] ${nodeToMarkdown(item).trim()}\n`).join('')}\n`;
    case 'taskItem':
    case 'listItem': return children;
    case 'blockquote': return `${children.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
    case 'horizontalRule': return '---\n\n';
    case 'noteBlock': return `> **${node.attrs?.title || node.attrs?.kind || 'Note'}**\n\n${children}`;
    case 'hardBreak': return '  \n';
    default: return children;
  }
}

function contentToMarkdown(content: JSONContent[]) {
  return nodeToMarkdown({ type: 'doc', content }).trim();
}

function parseMathPadClipboardPayload(value: string): MathPadClipboardPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<MathPadClipboardPayload>;
    if (parsed.version !== 1 || !Array.isArray(parsed.content)) return null;
    if (typeof parsed.openStart !== 'number' || typeof parsed.openEnd !== 'number') return null;
    if (!Number.isInteger(parsed.openStart) || !Number.isInteger(parsed.openEnd)) return null;
    return {
      version: 1,
      openStart: parsed.openStart,
      openEnd: parsed.openEnd,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function markdownInline(text: string): JSONContent[] {
  const pieces = text.split(/(\\\([^\n]*?\\\)|\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return pieces.map((piece) => {
    const math = piece.match(/^\\\(([\s\S]*)\\\)$/);
    if (math) return { type: 'mathInline', attrs: { id: makeId(), latex: math[1] } };
    if (piece.startsWith('**') && piece.endsWith('**')) return { type: 'text', text: piece.slice(2, -2), marks: [{ type: 'bold' }] };
    if (piece.startsWith('~~') && piece.endsWith('~~')) return { type: 'text', text: piece.slice(2, -2), marks: [{ type: 'strike' }] };
    if (piece.startsWith('`') && piece.endsWith('`')) return { type: 'text', text: piece.slice(1, -1), marks: [{ type: 'code' }] };
    if (piece.startsWith('*') && piece.endsWith('*')) return { type: 'text', text: piece.slice(1, -1), marks: [{ type: 'italic' }] };
    return { type: 'text', text: piece };
  });
}

function markdownToContent(markdown: string): JSONContent {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const content: JSONContent[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { content.push({ type: 'heading', attrs: { level: heading[1].length }, content: markdownInline(heading[2]) }); index += 1; continue; }
    if (/^\s*---+\s*$/.test(line)) { content.push({ type: 'horizontalRule' }); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote: JSONContent[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push({ type: 'paragraph', content: markdownInline(lines[index].replace(/^>\s?/, '')) }); index += 1; }
      content.push({ type: 'blockquote', content: quote });
      continue;
    }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      const items: JSONContent[] = [];
      while (index < lines.length) {
        const next = lines[index].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
        if (!next) break;
        items.push({ type: 'taskItem', attrs: { checked: next[1].toLowerCase() === 'x' }, content: [{ type: 'paragraph', content: markdownInline(next[2]) }] });
        index += 1;
      }
      content.push({ type: 'taskList', content: items });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      const items: JSONContent[] = [];
      while (index < lines.length) {
        const next = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!next || /^\s*[-*+]\s+\[([ xX])\]/.test(lines[index])) break;
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: markdownInline(next[1]) }] });
        index += 1;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: JSONContent[] = [];
      while (index < lines.length) {
        const next = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!next) break;
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: markdownInline(next[1]) }] });
        index += 1;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }
    content.push({ type: 'paragraph', content: markdownInline(line) });
    index += 1;
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

function MathFieldView({ node, updateAttributes, selected, editor, getPos }: NodeViewProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const fieldRef = useRef<MathfieldLike | null>(null);
  const initialLatexRef = useRef(node.attrs.latex ?? '');
  const autoWrappedRef = useRef(Boolean(node.attrs.autoWrapped));
  const wrappingRef = useRef(false);
  const exitingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const display = node.type.name === 'mathBlock';
  const latex = node.attrs.latex ?? '';
  const hasIssue = hasRecoverableMathIssue(latex);

  const exitMath = useCallback((direction: 'before' | 'after' = 'after') => {
    if (exitingRef.current) return;
    const position = typeof getPos === 'function' ? getPos() : undefined;
    const field = fieldRef.current;
    if (position === undefined || !field) return;
    exitingRef.current = true;
    const latex = field.value.trim();
    try {
      if (!latex) {
        editor.commands.deleteRange({ from: position, to: position + 1 });
        editor.commands.focus();
        return;
      }
      updateAttributes({ latex: field.value });
      editor.chain().focus().setTextSelection(direction === 'before' ? position : position + 1).run();
    } catch {
      // The node can disappear while MathLive is handing focus back to Tiptap.
    } finally {
      window.setTimeout(() => { exitingRef.current = false; }, 0);
    }
  }, [editor, getPos, updateAttributes]);

  useEffect(() => {
    let cancelled = false;
    let field: MathfieldLike | null = null;
    let cleanup: (() => void) | undefined;
    const mount = async () => {
      await import('mathlive');
      if (cancelled || !hostRef.current || fieldRef.current) return;
      field = document.createElement('math-field') as MathfieldLike;
      field.className = 'mathlive-field';
      field.value = initialLatexRef.current;
      field.setAttribute('default-mode', 'math');
      field.setAttribute('smart-mode', 'true');
      field.setAttribute('virtual-keyboard-mode', 'manual');
      field.setAttribute('aria-label', display ? 'Display math expression' : 'Inline math expression');
      field.setAttribute('data-math-id', node.attrs.id ?? '');
      hostRef.current.appendChild(field);
      fieldRef.current = field;
      field.shadowRoot?.querySelectorAll<HTMLElement>('[part="virtual-keyboard-toggle"], [part="menu-toggle"]').forEach((control) => {
        control.style.display = 'none';
      });
      if (field.inlineShortcuts) {
        field.inlineShortcuts = Object.fromEntries(Object.entries(field.inlineShortcuts).filter(([shortcut]) => !disabledDoubledSetShortcuts.includes(shortcut)));
      }
      field.mathModeSpace = '\\:';
      let wrapFrame: number | null = null;

      const fitDisplayMath = () => {
        if (!display || cancelled || !field || wrappingRef.current || !field.isConnected) return;
        const hostWidth = hostRef.current?.clientWidth ?? field.clientWidth;
        if (hostWidth < 120) return;
        const raw = autoWrappedRef.current ? unwrapAutoWrappedMath(field.value) : field.value;
        const fontSize = Number.parseFloat(window.getComputedStyle(field).fontSize) || 18;
        const next = wrapDisplayMath(raw, hostWidth, fontSize);
        if (next === field.value) return;

        const wasAtEnd = field.position >= field.lastOffset - 1;
        wrappingRef.current = true;
        field.value = next;
        autoWrappedRef.current = next !== raw;
        updateAttributes({ latex: next, autoWrapped: autoWrappedRef.current });
        window.requestAnimationFrame(() => {
          if (field && fieldRef.current === field && field.isConnected) {
            field.position = wasAtEnd ? field.lastOffset : Math.min(field.position, field.lastOffset);
          }
          wrappingRef.current = false;
        });
      };

      const scheduleDisplayFit = () => {
        if (!display || wrapFrame !== null) return;
        wrapFrame = window.requestAnimationFrame(() => {
          wrapFrame = null;
          fitDisplayMath();
        });
      };

      const safelyFocusField = (position: MathFocusPosition = 'end') => {
        let attempts = 0;
        const attemptFocus = () => {
          if (!field || cancelled) return;
          try {
            field.focus();
            field.position = position === 'start' ? 0 : field.lastOffset;
            pendingMathFocusId = null;
            pendingMathFocusPosition = 'end';
          } catch {
            attempts += 1;
            if (attempts < 4) window.requestAnimationFrame(attemptFocus);
          }
        };
        window.requestAnimationFrame(attemptFocus);
      };

      let disposed = false;
      const persistLatex = () => {
        if (disposed || !field || fieldRef.current !== field || !field.isConnected) return;
        try {
          updateAttributes(display ? { latex: field.value, autoWrapped: autoWrappedRef.current } : { latex: field.value });
        } catch { /* the node may have just been removed */ }
      };
      const handleInput = () => {
        if (field) {
          const normalized = normalizeMathShortcuts(field.value);
          if (normalized !== field.value) field.value = normalized;
        }
        persistLatex();
        scheduleDisplayFit();
      };
      const handleFocus = () => {
        setEditing(true);
        window.dispatchEvent(new CustomEvent('mathpad:mode', { detail: 'math' }));
      };
      const handleBlur = () => {
        setEditing(false);
        persistLatex();
        window.setTimeout(() => {
          if (document.activeElement !== field) window.dispatchEvent(new CustomEvent('mathpad:mode', { detail: 'text' }));
        }, 0);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Tab' || event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          exitMath(event.key === 'Tab' && event.shiftKey ? 'before' : 'after');
        }
      };
      const handleDocumentKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Tab' && event.key !== 'Escape') return;
        if (!field) return;
        const path = event.composedPath();
        if (document.activeElement !== field && !path.includes(field)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        exitMath(event.key === 'Tab' && event.shiftKey ? 'before' : 'after');
      };
      const handleToggle = () => {
        if (document.activeElement === field) exitMath('after');
      };
      const handleRequestedFocus = (event: Event) => {
        const detail = (event as CustomEvent<string | { id?: string; position?: MathFocusPosition }>).detail;
        const requestedId = typeof detail === 'string' ? detail : detail?.id;
        if (requestedId === node.attrs.id) safelyFocusField(typeof detail === 'object' ? detail.position : 'end');
      };

      const resizeObserver = display && hostRef.current ? new ResizeObserver(scheduleDisplayFit) : null;
      resizeObserver?.observe(hostRef.current as HTMLSpanElement);

      field.addEventListener('input', handleInput);
      field.addEventListener('focus', handleFocus);
      field.addEventListener('blur', handleBlur);
      field.addEventListener('keydown', handleKeyDown);
      // MathLive renders its editing surface inside a shadow root. Capture
      // here so Tab cannot fall through to browser focus navigation before
      // the field's own keydown listener sees it.
      document.addEventListener('keydown', handleDocumentKeyDown, true);
      window.addEventListener('mathpad:toggle-math', handleToggle);
      window.addEventListener('mathpad:focus-math', handleRequestedFocus);
      if (pendingMathFocusId === node.attrs.id) {
        safelyFocusField(pendingMathFocusPosition);
      }
      scheduleDisplayFit();
      cleanup = () => {
        if (!field) return;
        disposed = true;
        if (wrapFrame !== null) window.cancelAnimationFrame(wrapFrame);
        resizeObserver?.disconnect();
        field.removeEventListener('input', handleInput);
        field.removeEventListener('focus', handleFocus);
        field.removeEventListener('blur', handleBlur);
        field.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keydown', handleDocumentKeyDown, true);
        window.removeEventListener('mathpad:toggle-math', handleToggle);
        window.removeEventListener('mathpad:focus-math', handleRequestedFocus);
        field.remove();
        fieldRef.current = null;
      };
    };
    void mount().catch(() => {
      if (!cancelled) window.dispatchEvent(new CustomEvent('mathpad:mode', { detail: 'text' }));
    });
    return () => {
      cancelled = true;
      cleanup?.();
      fieldRef.current = null;
    };
  }, [display, exitMath, node.attrs.id, updateAttributes]);

  useEffect(() => {
    if (fieldRef.current && fieldRef.current.value !== (node.attrs.latex ?? '') && document.activeElement !== fieldRef.current) fieldRef.current.value = node.attrs.latex ?? '';
  }, [node.attrs.latex]);

  return (
    <NodeViewWrapper as={display ? 'div' : 'span'} className={`math-node ${display ? 'math-node-display' : 'math-node-inline'} ${selected ? 'is-selected' : ''}`} data-display={display ? 'block' : 'inline'} data-math-id={node.attrs.id ?? ''} data-invalid={hasIssue ? 'true' : undefined} data-editing={editing ? 'true' : 'false'}>
      <span className="math-node-badge">MATH</span>
      {hasIssue && <span className="math-node-error" title="Recoverable LaTeX issue" aria-label="Recoverable LaTeX issue">!</span>}
      <span ref={hostRef} className="math-field-host" />
      <span className="math-node-hint">Tab / Escape to finish</span>
    </NodeViewWrapper>
  );
}

const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { id: { default: null }, latex: { default: '' } }; },
  parseHTML() { return [{ tag: 'span[data-math-node="inline"]', getAttrs: (element) => ({ id: element.getAttribute('data-math-id'), latex: element.getAttribute('data-latex') ?? '' }) }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-math-node': 'inline', 'data-math-id': HTMLAttributes.id ?? '', 'data-latex': HTMLAttributes.latex ?? '' })]; },
  addNodeView() { return ReactNodeViewRenderer(MathFieldView); },
});

const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() { return { id: { default: null }, latex: { default: '' }, autoWrapped: { default: false } }; },
  parseHTML() { return [{ tag: 'div[data-math-node="block"]', getAttrs: (element) => ({ id: element.getAttribute('data-math-id'), latex: element.getAttribute('data-latex') ?? '', autoWrapped: element.getAttribute('data-auto-wrapped') === 'true' }) }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-math-node': 'block', 'data-math-id': HTMLAttributes.id ?? '', 'data-latex': HTMLAttributes.latex ?? '', 'data-auto-wrapped': HTMLAttributes.autoWrapped ? 'true' : undefined })]; },
  addNodeView() { return ReactNodeViewRenderer(MathFieldView); },
});

const NoteBlock = Node.create({
  name: 'noteBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() { return { kind: { default: 'proof' }, title: { default: 'Proof' } }; },
  parseHTML() { return [{ tag: 'section[data-note-block]' }]; },
  renderHTML({ HTMLAttributes }) { return ['section', mergeAttributes(HTMLAttributes, { 'data-note-block': 'true' }), 0]; },
  addNodeView() { return ReactNodeViewRenderer(NoteBlockView); },
});

function NoteBlockView({ node, updateAttributes }: NodeViewProps) {
  const kind = node.attrs.kind ?? 'proof';
  return (
    <NodeViewWrapper className={`note-block note-block-${kind}`}>
      <div className="note-block-header">
        <span className="note-block-mark">{kind === 'proof' ? '∎' : kind === 'theorem' ? '◆' : '◇'}</span>
        <input className="note-block-title" defaultValue={node.attrs.title ?? kind} aria-label={`${kind} block title`} onChange={(event) => updateAttributes({ title: event.target.value })} />
      </div>
      <NodeViewContent className="note-block-content" />
    </NodeViewWrapper>
  );
}

type PaletteItem = {
  id: string;
  label: string;
  detail: string;
  shortcut?: string;
  icon: string;
  action: { kind: 'inlineMath' | 'mathBlock' | 'noteBlock'; latex?: string; blockKind?: string };
};

const blockItems: PaletteItem[] = [
  { id: 'inline-math', label: 'Inline math', detail: 'Continue a sentence with an editable expression', shortcut: '/', icon: '∑', action: { kind: 'inlineMath' } },
  { id: 'display-math', label: 'Display math', detail: 'Center a larger equation on its own line', icon: '∫', action: { kind: 'mathBlock', latex: '' } },
  { id: 'proof', label: 'Proof', detail: 'A labeled proof container with normal text and math', icon: '∎', action: { kind: 'noteBlock', blockKind: 'proof' } },
  { id: 'theorem', label: 'Theorem', detail: 'State a claim before proving it', icon: '◆', action: { kind: 'noteBlock', blockKind: 'theorem' } },
  { id: 'definition', label: 'Definition', detail: 'Give a concept a clear name and meaning', icon: '◇', action: { kind: 'noteBlock', blockKind: 'definition' } },
  { id: 'cases', label: 'Cases', detail: 'Start a piecewise or case-based expression', icon: '{}', action: { kind: 'mathBlock', latex: '\\begin{cases} & \\text{if } \\\\ & \\text{otherwise} \\end{cases}' } },
  { id: 'matrix', label: 'Matrix', detail: 'Start a small matrix or array', icon: '▦', action: { kind: 'mathBlock', latex: '\\begin{bmatrix} & \\\\ & \\end{bmatrix}' } },
  { id: 'divider', label: 'Divider', detail: 'Separate sections of your notes', icon: '—', action: { kind: 'noteBlock', blockKind: 'divider' } },
];

const mathItems: PaletteItem[] = [
  { id: 'negation', label: 'Not / negation', detail: 'Logical negation', shortcut: 'neg', icon: '¬', action: { kind: 'inlineMath', latex: '\\neg ' } },
  { id: 'forall', label: 'For all', detail: 'Universal quantifier', shortcut: 'forall', icon: '∀', action: { kind: 'inlineMath', latex: '\\forall ' } },
  { id: 'exists', label: 'There exists', detail: 'Existential quantifier', shortcut: 'exists', icon: '∃', action: { kind: 'inlineMath', latex: '\\exists ' } },
  { id: 'implies', label: 'Implies', detail: 'Logical implication', shortcut: 'implies', icon: '⇒', action: { kind: 'inlineMath', latex: '\\implies ' } },
  { id: 'iff', label: 'If and only if', detail: 'Logical equivalence', shortcut: 'iff', icon: '⇔', action: { kind: 'inlineMath', latex: '\\iff ' } },
  { id: 'and', label: 'And', detail: 'Logical conjunction', shortcut: 'land', icon: '∧', action: { kind: 'inlineMath', latex: '\\land ' } },
  { id: 'or', label: 'Or', detail: 'Logical disjunction', shortcut: 'lor', icon: '∨', action: { kind: 'inlineMath', latex: '\\lor ' } },
  { id: 'in', label: 'Element of', detail: 'Set membership', shortcut: 'in', icon: '∈', action: { kind: 'inlineMath', latex: '\\in ' } },
  { id: 'not-in', label: 'Not an element of', detail: 'Negated set membership', shortcut: 'notin', icon: '∉', action: { kind: 'inlineMath', latex: '\\notin ' } },
  { id: 'subseteq', label: 'Subset or equal', detail: 'Set inclusion', shortcut: 'subseteq', icon: '⊆', action: { kind: 'inlineMath', latex: '\\subseteq ' } },
  { id: 'union', label: 'Union', detail: 'Combine two sets', shortcut: 'cup', icon: '∪', action: { kind: 'inlineMath', latex: '\\cup ' } },
  { id: 'intersection', label: 'Intersection', detail: 'Common elements of two sets', shortcut: 'cap', icon: '∩', action: { kind: 'inlineMath', latex: '\\cap ' } },
  { id: 'naturals', label: 'Natural numbers', detail: 'The set ℕ', shortcut: 'NN', icon: 'ℕ', action: { kind: 'inlineMath', latex: '\\mathbb{N}' } },
  { id: 'integers', label: 'Integers', detail: 'The set ℤ', shortcut: 'ZZ', icon: 'ℤ', action: { kind: 'inlineMath', latex: '\\mathbb{Z}' } },
  { id: 'therefore', label: 'Therefore', detail: 'Proof conclusion marker', shortcut: 'therefore', icon: '∴', action: { kind: 'inlineMath', latex: '\\therefore ' } },
  { id: 'binomial', label: 'Binomial coefficient', detail: 'Choose k from n', shortcut: 'choose', icon: '()()', action: { kind: 'inlineMath', latex: '\\binom{n}{k}' } },
  { id: 'sqrt', label: 'Square root', detail: 'Radical with an editable placeholder', shortcut: 'sqrt', icon: '√', action: { kind: 'inlineMath', latex: '\\sqrt{}' } },
];

function IconButton({ label, children, onClick, active = false, disabled = false }: { label: string; children: React.ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <Button type="button" variant="ghost" size="icon-sm" className={`toolbar-button ${active ? 'is-active' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</Button>;
}

export default function Home() {
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState('Logic & proof patterns');
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [fallbackShortcut, setFallbackShortcut] = useState(DEFAULT_FALLBACK_SHORTCUT);
  const [systemDark, setSystemDark] = useState(false);
  const [mode, setMode] = useState<'text' | 'math'>('text');
  const [saveState, setSaveState] = useState<SaveState>('ready');
  const [syncState, setSyncState] = useState<SyncState>('checking');
  const [palette, setPalette] = useState<PaletteKind>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [noteMenuId, setNoteMenuId] = useState<string | null>(null);
  const [renameNoteId, setRenameNoteId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const hydratedRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const activeNoteRef = useRef<string | null>(null);
  const noteOperationRef = useRef(0);
  const sidebarPreferenceLoadedRef = useRef(false);
  const titleRef = useRef(title);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef(false);
  const remoteSyncEnabledRef = useRef<boolean | null>(null);
  const remoteSyncChainRef = useRef(Promise.resolve());
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    const applyStoredSettings = () => {
      const savedTheme = localStorage.getItem(THEME_KEY);
      if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);
      const savedShortcut = localStorage.getItem(FALLBACK_SHORTCUT_KEY);
      if (savedShortcut) setFallbackShortcut(savedShortcut);
      update();
    };
    const settingsTimer = window.setTimeout(applyStoredSettings, 0);
    media.addEventListener('change', update);
    return () => {
      window.clearTimeout(settingsTimer);
      media.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const settingsTimer = window.setTimeout(() => {
      const savedSidebarState = window.localStorage.getItem(SIDEBAR_KEY);
      if (savedSidebarState === 'open' || savedSidebarState === 'closed') setSidebarOpen(savedSidebarState === 'open');
      sidebarPreferenceLoadedRef.current = true;
    }, 0);
    return () => window.clearTimeout(settingsTimer);
  }, []);

  useEffect(() => {
    if (sidebarPreferenceLoadedRef.current) window.localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? 'open' : 'closed');
  }, [sidebarOpen]);

  useEffect(() => {
    if (!noteMenuId && !renameNoteId && sidebarOpen) return;
    const closeTransientUi = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('.note-item-actions')) return;
      setNoteMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (noteMenuId) {
        event.preventDefault();
        setNoteMenuId(null);
      } else if (renameNoteId) {
        event.preventDefault();
        setRenameNoteId(null);
      } else if (window.innerWidth <= 640 && sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('mousedown', closeTransientUi);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', closeTransientUi);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [noteMenuId, renameNoteId, sidebarOpen]);

  useEffect(() => {
    if (!renameNoteId) return;
    const focusTimer = window.requestAnimationFrame(() => {
      const input = document.querySelector('.note-rename-input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
    return () => window.cancelAnimationFrame(focusTimer);
  }, [renameNoteId]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (!palette) return;
    window.requestAnimationFrame(() => paletteInputRef.current?.focus());
  }, [palette]);

  const queueRemoteOperation = useCallback((operation: () => Promise<void>) => {
    if (remoteSyncEnabledRef.current === false) return;
    remoteSyncChainRef.current = remoteSyncChainRef.current.then(async () => {
      setSyncState('syncing');
      try {
        await operation();
        remoteSyncEnabledRef.current = true;
        setSyncState('synced');
      } catch (error) {
        if (error instanceof RemoteSyncUnavailableError) {
          remoteSyncEnabledRef.current = false;
          setSyncState('disabled');
        } else {
          setSyncState(navigator.onLine ? 'error' : 'offline');
        }
      }
    });
  }, []);

  const syncRemoteNote = useCallback((note: NoteDocument) => queueRemoteOperation(() => writeRemoteNote(note)), [queueRemoteOperation]);
  const syncRemoteDelete = useCallback((id: string) => queueRemoteOperation(() => removeRemoteNote(id)), [queueRemoteOperation]);

  const queueSave = useCallback(() => {
    if (!hydratedRef.current || !editorRef.current || !activeNoteRef.current) return;
    pendingSaveRef.current = true;
    setSaveState('saving');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(async () => {
      saveTimerRef.current = null;
      if (!pendingSaveRef.current) return;
      pendingSaveRef.current = false;
      const editor = editorRef.current;
      const id = activeNoteRef.current;
      if (!editor || !id) return;
      const next: NoteDocument = { version: 1, id, title: titleRef.current.trim() || 'Untitled note', content: editor.getJSON(), updatedAt: Date.now() };
      try {
        await writeLocalNote(next);
        setNotes((current) => [next, ...current.filter((note) => note.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt));
        setSaveState('saved');
        syncRemoteNote(next);
      } catch { setSaveState('error'); }
    }, 450);
  }, [syncRemoteNote]);

  const flushSave = useCallback(async () => {
    if (!pendingSaveRef.current) return;
    pendingSaveRef.current = false;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const editor = editorRef.current;
    const id = activeNoteRef.current;
    if (!editor || !id || !hydratedRef.current) return;
    const next: NoteDocument = { version: 1, id, title: titleRef.current.trim() || 'Untitled note', content: editor.getJSON(), updatedAt: Date.now() };
    try {
      await writeLocalNote(next);
      setNotes((current) => [next, ...current.filter((note) => note.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt));
      setSaveState('saved');
      syncRemoteNote(next);
    } catch { setSaveState('error'); }
  }, [syncRemoteNote]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, bulletList: { keepMarks: true }, orderedList: { keepMarks: true } }),
      Superscript,
      Subscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start with a thought… Press / for inline math.' }),
      MathInline,
      MathBlock,
      NoteBlock,
    ],
    content: starterContent,
    editorProps: {
      attributes: { class: 'note-editor-content', spellcheck: 'true', 'aria-label': 'MathPad note editor' },
      handleDOMEvents: {
        copy: (view, event) => {
          const clipboardEvent = event as ClipboardEvent;
          const clipboard = clipboardEvent.clipboardData;
          if (!clipboard || view.state.selection.empty) return false;

          const slice = view.state.selection.content();
          const content = slice.content.toJSON() as JSONContent[];
          const serialized = view.serializeForClipboard(slice);
          const fallbackText = contentToMarkdown(content) || serialized.text;

          clipboard.clearData();
          try {
            clipboard.setData(MATHPAD_CLIPBOARD_TYPE, JSON.stringify({
              version: 1,
              openStart: slice.openStart,
              openEnd: slice.openEnd,
              content,
            } satisfies MathPadClipboardPayload));
          } catch {
            // Some browsers reject custom clipboard MIME types. HTML and text
            // remain available as the portable fallbacks.
          }
          clipboard.setData('text/html', serialized.dom.innerHTML);
          clipboard.setData('text/plain', fallbackText);
          try {
            clipboard.setData('text/markdown', fallbackText);
          } catch {
            // text/markdown is an optional browser clipboard flavor.
          }
          clipboardEvent.preventDefault();
          return true;
        },
      },
      handleKeyDown: (view, event) => {
        if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && view.state.selection.empty) {
          const adjacentNode = event.key === 'ArrowLeft' ? view.state.selection.$from.nodeBefore : view.state.selection.$from.nodeAfter;
          if (adjacentNode?.type.name === 'mathInline' && adjacentNode.attrs.id) {
            event.preventDefault();
            setMode('math');
            requestMathFocus(adjacentNode.attrs.id, event.key === 'ArrowLeft' ? 'end' : 'start');
            return true;
          }
        }
        if (event.key === '/') {
          event.preventDefault();
          const id = makeId();
          editorRef.current?.chain().focus().insertContent({ type: 'mathInline', attrs: { id, latex: '' } }).run();
          setPalette(null);
          setPaletteQuery('');
          setMode('math');
          requestMathFocus(id);
          return true;
        }
        if (event.key === '\\') {
          event.preventDefault();
          setPalette('math');
          setPaletteQuery('');
          return true;
        }
        if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          let listItem: 'taskItem' | 'listItem' | null = null;
          for (let depth = view.state.selection.$from.depth; depth > 0; depth -= 1) {
            const nodeName = view.state.selection.$from.node(depth).type.name;
            if (nodeName === 'taskItem' || nodeName === 'listItem') {
              listItem = nodeName;
              break;
            }
          }
          // Tab is indentation only inside a list. Outside a list, leave the
          // browser's normal focus behavior alone instead of hijacking it.
          if (!listItem) return false;
          const commandHandled = event.shiftKey
            ? editorRef.current?.commands.liftListItem(listItem)
            : editorRef.current?.commands.sinkListItem(listItem);
          event.preventDefault();
          return commandHandled || true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const mathPadClipboard = event.clipboardData?.getData(MATHPAD_CLIPBOARD_TYPE);
        const markdown = event.clipboardData?.getData('text/markdown');
        const activeEditor = editorRef.current;
        if (!activeEditor) return false;
        const payload = mathPadClipboard ? parseMathPadClipboardPayload(mathPadClipboard) : null;
        if (payload) {
          event.preventDefault();
          activeEditor.commands.insertContent(payload.content);
          return true;
        }
        if (!markdown) return false;
        event.preventDefault();
        activeEditor.commands.insertContent(markdownToContent(markdown).content ?? []);
        return true;
      },
    },
    onUpdate: () => queueSave(),
  });

  useEffect(() => { editorRef.current = editor; }, [editor]);

  useEffect(() => {
    const onMode = (event: Event) => setMode((event as CustomEvent<'text' | 'math'>).detail);
    const onFocus = (event: FocusEvent) => setMode((event.target as HTMLElement | null)?.tagName === 'MATH-FIELD' ? 'math' : 'text');
    window.addEventListener('mathpad:mode', onMode);
    document.addEventListener('focusin', onFocus);
    return () => { window.removeEventListener('mathpad:mode', onMode); document.removeEventListener('focusin', onFocus); };
  }, []);

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    const hydrate = async () => {
      const localNotes = await readLocalNotes();
      if (cancelled) return;
      let stored = localNotes;
      try {
        const remote = await readRemoteNotes();
        remoteSyncEnabledRef.current = true;
        const deletedAtById = new Map(remote.deleted.map((item) => [item.id, item.deletedAt]));
        const localNotesToKeep = localNotes.filter((note) => {
          const deletedAt = deletedAtById.get(note.id);
          if (deletedAt && deletedAt >= note.updatedAt) {
            void removeLocalNote(note.id);
            return false;
          }
          return true;
        });
        stored = mergeNotes(localNotesToKeep, remote.notes);
        if (stored.length > 0) {
          setSyncState('syncing');
          await Promise.all(stored.map((note) => writeLocalNote(note)));
          await Promise.all(stored.map((note) => writeRemoteNote(note)));
          setSyncState('synced');
        }
      } catch (error) {
        if (error instanceof RemoteSyncUnavailableError) {
          remoteSyncEnabledRef.current = false;
          setSyncState('disabled');
        } else {
          setSyncState(navigator.onLine ? 'error' : 'offline');
        }
      }
      if (cancelled) return;
      if (stored.length > 0) {
        const initial = stored[0];
        setNotes(stored);
        setActiveNoteId(initial.id);
        activeNoteRef.current = initial.id;
        setTitle(initial.title);
        titleRef.current = initial.title;
        editor.commands.setContent(initial.content, { emitUpdate: false });
      } else {
        const initial: NoteDocument = { version: 1, id: makeId(), title: 'Logic & proof patterns', content: starterContent, updatedAt: Date.now() };
        setNotes([initial]);
        setActiveNoteId(initial.id);
        activeNoteRef.current = initial.id;
        setTitle(initial.title);
        titleRef.current = initial.title;
        editor.commands.setContent(initial.content, { emitUpdate: false });
        await writeLocalNote(initial);
        setSaveState('saved');
        syncRemoteNote(initial);
      }
      hydratedRef.current = true;
    };
    void hydrate();
    return () => { cancelled = true; };
  }, [editor, syncRemoteNote]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') void flushSave(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [flushSave]);

  const focusMath = useCallback((id: string, position: MathFocusPosition = 'end') => requestMathFocus(id, position), []);

  const insertMath = useCallback((display = false, latex = '') => {
    if (!editor) return;
    const id = makeId();
    if (display) editor.chain().focus().insertContent([{ type: 'mathBlock', attrs: { id, latex } }, { type: 'paragraph' }]).run();
    else editor.chain().focus().insertContent({ type: 'mathInline', attrs: { id, latex } }).run();
    setPalette(null);
    setPaletteQuery('');
    setMode('math');
    focusMath(id);
  }, [editor, focusMath]);

  const insertBlock = useCallback((kind: string) => {
    if (!editor) return;
    if (kind === 'divider') editor.chain().focus().setHorizontalRule().run();
    else editor.chain().focus().insertContent({ type: 'noteBlock', attrs: { kind, title: kind[0].toUpperCase() + kind.slice(1) }, content: [{ type: 'paragraph' }] }).run();
    setPalette(null);
    setPaletteQuery('');
    editor.commands.focus();
  }, [editor]);

  const selectPaletteItem = (item: PaletteItem) => {
    if (item.action.kind === 'inlineMath') insertMath(false, item.action.latex ?? '');
    if (item.action.kind === 'mathBlock') insertMath(true, item.action.latex ?? '');
    if (item.action.kind === 'noteBlock') insertBlock(item.action.blockKind ?? 'proof');
  };

  const createNote = async () => {
    const operation = ++noteOperationRef.current;
    await flushSave();
    if (operation !== noteOperationRef.current) return;
    const note: NoteDocument = { version: 1, id: makeId(), title: 'New discrete math note', content: emptyContent(), updatedAt: Date.now() };
    await writeLocalNote(note);
    syncRemoteNote(note);
    setNotes((current) => [note, ...current].sort((a, b) => b.updatedAt - a.updatedAt));
    setActiveNoteId(note.id);
    activeNoteRef.current = note.id;
    setTitle(note.title);
    titleRef.current = note.title;
    editor?.commands.setContent(note.content, { emitUpdate: false });
    editor?.commands.focus('start');
    setNoteMenuId(null);
  };

  const openNote = async (note: NoteDocument) => {
    if (note.id === activeNoteRef.current) {
      setNoteMenuId(null);
      return;
    }
    const operation = ++noteOperationRef.current;
    await flushSave();
    if (operation !== noteOperationRef.current) return;
    setActiveNoteId(note.id);
    activeNoteRef.current = note.id;
    setTitle(note.title);
    titleRef.current = note.title;
    editor?.commands.setContent(note.content, { emitUpdate: false });
    editor?.commands.focus('start');
    setSaveState('saved');
    setNoteMenuId(null);
  };

  const getCurrentNoteSnapshot = (note: NoteDocument): NoteDocument => {
    if (note.id !== activeNoteRef.current || !editorRef.current) return note;
    return {
      ...note,
      title: titleRef.current.trim() || 'Untitled note',
      content: editorRef.current.getJSON(),
    };
  };

  const duplicateNote = async (source: NoteDocument) => {
    const operation = ++noteOperationRef.current;
    await flushSave();
    if (operation !== noteOperationRef.current) return;
    const currentSource = getCurrentNoteSnapshot(source);
    const duplicate: NoteDocument = {
      version: 1,
      id: makeId(),
      title: `${currentSource.title || 'Untitled note'} (copy)`,
      content: cloneContentWithFreshMathIds(currentSource.content),
      updatedAt: timestampNow(),
    };
    await writeLocalNote(duplicate);
    syncRemoteNote(duplicate);
    setNotes((current) => [duplicate, ...current.filter((note) => note.id !== duplicate.id)].sort((a, b) => b.updatedAt - a.updatedAt));
    setActiveNoteId(duplicate.id);
    activeNoteRef.current = duplicate.id;
    setTitle(duplicate.title);
    titleRef.current = duplicate.title;
    editor?.commands.setContent(duplicate.content, { emitUpdate: false });
    editor?.commands.focus('start');
    setSaveState('saved');
    setNoteMenuId(null);
  };

  const commitRename = async (note: NoteDocument) => {
    if (renameNoteId !== note.id) return;
    const nextTitle = renameValue.trim() || 'Untitled note';
    setRenameNoteId(null);
    setRenameValue('');
    if (nextTitle === note.title) return;

    const operation = ++noteOperationRef.current;
    await flushSave();
    if (operation !== noteOperationRef.current) return;
    const renamed: NoteDocument = {
      ...getCurrentNoteSnapshot(note),
      title: nextTitle,
      updatedAt: timestampNow(),
    };
    await writeLocalNote(renamed);
    syncRemoteNote(renamed);
    setNotes((current) => [renamed, ...current.filter((item) => item.id !== renamed.id)].sort((a, b) => b.updatedAt - a.updatedAt));
    if (renamed.id === activeNoteRef.current) {
      setTitle(renamed.title);
      titleRef.current = renamed.title;
    }
  };

  const beginRename = (note: NoteDocument) => {
    setNoteMenuId(null);
    setRenameNoteId(note.id);
    setRenameValue(note.title);
  };

  const deleteNote = async (noteId: string) => {
    const note = notes.find((item) => item.id === noteId);
    if (!note) return;
    if (!window.confirm(`Delete “${note.title}”?`)) return;
    const operation = ++noteOperationRef.current;
    await flushSave();
    if (operation !== noteOperationRef.current) return;

    await removeLocalNote(noteId);
    syncRemoteDelete(noteId);
    let remaining = notes.filter((item) => item.id !== noteId);
    if (remaining.length === 0) {
      const replacement: NoteDocument = { version: 1, id: makeId(), title: 'New discrete math note', content: emptyContent(), updatedAt: timestampNow() };
      await writeLocalNote(replacement);
      syncRemoteNote(replacement);
      remaining = [replacement];
    }
    const next = remaining[0];
    setNotes(remaining);
    setNoteMenuId(null);
    setRenameNoteId(null);
    if (noteId === activeNoteRef.current) {
      setActiveNoteId(next.id);
      activeNoteRef.current = next.id;
      setTitle(next.title);
      titleRef.current = next.title;
      editor?.commands.setContent(next.content, { emitUpdate: false });
      editor?.commands.focus('start');
    }
  };

  const deleteCurrentNote = async () => {
    if (!activeNoteId) return;
    await deleteNote(activeNoteId);
  };

  const toggleMath = useCallback(() => {
    if (document.activeElement?.tagName === 'MATH-FIELD') window.dispatchEvent(new Event('mathpad:toggle-math'));
    else insertMath(false);
  }, [insertMath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const fallback = matchesShortcut(event, fallbackShortcut);
      if (fallback) { event.preventDefault(); toggleMath(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [fallbackShortcut, toggleMath]);

  const updateTheme = (value: string | null) => {
    if (!value) return;
    const next = value as ThemePreference;
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  const updateFallbackShortcut = (value: string) => {
    const next = value.trim() || DEFAULT_FALLBACK_SHORTCUT;
    setFallbackShortcut(next);
    localStorage.setItem(FALLBACK_SHORTCUT_KEY, next);
  };

  const exportCurrentNote = () => {
    if (!editor) return;
    downloadFile(`${(title || 'math-note').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`, nodeToMarkdown(editor.getJSON()), 'text/markdown');
  };

  const activeNote = notes.find((note) => note.id === activeNoteId);
  const filteredItems = useMemo(() => (palette === 'blocks' ? blockItems : mathItems), [palette]);
  const syncStatusText = syncState === 'checking' ? 'Checking cloud' : syncState === 'disabled' ? 'Cloud sync off' : syncState === 'syncing' ? 'Syncing cloud' : syncState === 'synced' ? 'Synced to cloud' : syncState === 'offline' ? 'Offline · local only' : 'Cloud sync issue';

  return (
    <main className="mathpad-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark"><NotebookPen size={18} /></div>
          <div><div className="brand-name">MathPad</div><div className="brand-subtitle">Discrete math, without the friction</div></div>
        </div>
        <div className="header-actions">
          <div className={`save-indicator save-${saveState}`} aria-live="polite"><span className="save-dot" />{saveState === 'saving' ? 'Saving locally' : saveState === 'error' ? 'Save issue' : saveState === 'saved' ? 'Saved locally' : 'Ready'}</div>
          <Select value={theme} onValueChange={updateTheme}>
            <SelectTrigger className="theme-select" aria-label="Theme"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="system"><Monitor size={14} /> System</SelectItem><SelectItem value="light"><Sun size={14} /> Light</SelectItem><SelectItem value="dark"><Moon size={14} /> Dark</SelectItem></SelectContent>
          </Select>
          <details className="settings-menu"><summary className="settings-trigger">⌘M</summary><div className="settings-popover"><span className="eyebrow">Keyboard</span><label htmlFor="math-shortcut">Math toggle shortcut</label><input id="math-shortcut" value={fallbackShortcut} onChange={(event) => updateFallbackShortcut(event.target.value)} onBlur={(event) => updateFallbackShortcut(event.target.value)} /><small>Use a format like Cmd/Ctrl+Shift+M as an alternate math toggle.</small></div></details>
          <Button type="button" variant="outline" size="sm" onClick={exportCurrentNote} title="Download Markdown with LaTeX"><Download size={15} /> Export</Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? 'Hide notes sidebar' : 'Show notes sidebar'} title={sidebarOpen ? 'Hide notes sidebar' : 'Show notes sidebar'}><BookOpen size={17} /></Button>
        </div>
      </header>

      <div className={`app-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        {!sidebarOpen && <button type="button" className="sidebar-reopen" onClick={() => setSidebarOpen(true)} aria-label="Show notes sidebar" title="Show notes sidebar"><ChevronRight size={16} /></button>}
        {sidebarOpen && <>
          <button type="button" className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close notes sidebar" />
          <aside className="note-sidebar">
          <div className="sidebar-heading"><div><span className="eyebrow">Your workspace</span><h2>Notes</h2></div><div className="sidebar-heading-actions"><Button type="button" variant="ghost" size="icon-sm" onClick={() => void createNote()} aria-label="New note" title="New note"><Plus size={17} /></Button><Button type="button" variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(false)} aria-label="Hide notes sidebar" title="Hide notes sidebar"><ChevronLeft size={17} /></Button></div></div>
          <div className="note-list">{notes.map((note) => {
            const isCurrent = note.id === activeNoteId;
            const isRenaming = note.id === renameNoteId;
            return <div key={note.id} className={`note-list-item ${isCurrent ? 'is-current' : ''}`}>
              {isRenaming ? <div className="note-rename-row"><span className="note-list-icon"><FileText size={15} /></span><input className="note-rename-input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={() => void commitRename(note)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void commitRename(note); } if (event.key === 'Escape') { event.preventDefault(); setRenameNoteId(null); } }} aria-label={`Rename ${note.title}`} /></div> : <button type="button" className="note-open-button" onClick={() => void openNote(note)} aria-current={isCurrent ? 'page' : undefined}><span className="note-list-icon"><FileText size={15} /></span><span className="note-list-copy"><strong>{note.title}</strong><small>{formatNoteDate(note.updatedAt)}</small></span></button>}
              <div className="note-item-actions">
                <button type="button" className="note-actions-trigger" onClick={() => setNoteMenuId((current) => current === note.id ? null : note.id)} aria-label={`More actions for ${note.title}`} aria-haspopup="menu" aria-expanded={noteMenuId === note.id}><MoreHorizontal size={16} /></button>
                {noteMenuId === note.id && <div className="note-actions-menu" role="menu"><button type="button" role="menuitem" onClick={() => beginRename(note)}><Pencil size={14} /> Rename</button><button type="button" role="menuitem" onClick={() => void duplicateNote(note)}><Copy size={14} /> Duplicate</button><button type="button" role="menuitem" className="is-destructive" onClick={() => void deleteNote(note.id)}><Trash2 size={14} /> Delete</button></div>}
              </div>
            </div>;
          })}</div>
          <div className="sidebar-footer"><span className="local-lock"><CheckCircle2 size={14} /> Stored on this device</span><span className="sidebar-tip">Tip: press <kbd>/</kbd> to enter math</span></div>
          </aside>
        </>}

        <section className="workspace">
          <div className="workspace-bar"><div className="breadcrumb"><span>MathPad</span><span>/</span><span>{activeNote?.title || 'New note'}</span></div><div className="workspace-hints"><span className={`mode-pill mode-${mode}`}><span className="mode-dot" /> {mode === 'math' ? 'Math' : 'Text'}</span><span className={`sync-pill sync-${syncState}`} aria-live="polite" title={syncState === 'disabled' ? 'Add DATABASE_URL to your Vercel project and redeploy to enable Neon sync.' : undefined}><span className="save-dot" />{syncStatusText}</span><span className="hint-chip"><kbd>/</kbd> math</span><span className="hint-chip"><kbd>+</kbd> blocks</span><span className="hint-chip"><kbd>\\</kbd> symbols</span></div></div>

          <div className="paper-wrap"><article className="paper">
            <div className="paper-topline"><input className="note-title-input" value={title} onChange={(event) => { setTitle(event.target.value); titleRef.current = event.target.value; queueSave(); }} aria-label="Note title" placeholder="Untitled note" /><div className="paper-actions"><IconButton label="Undo" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()}><Undo2 size={16} /></IconButton><IconButton label="Redo" onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()}><Redo2 size={16} /></IconButton><IconButton label="Print or save PDF" onClick={() => window.print()}><FileText size={16} /></IconButton><IconButton label="Delete note" onClick={() => void deleteCurrentNote()}><Trash2 size={16} /></IconButton></div></div>

            <div className="editor-toolbar" aria-label="Formatting toolbar"><span className="toolbar-label">Write</span><IconButton label="Bold (Cmd/Ctrl+B)" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></IconButton><IconButton label="Italic (Cmd/Ctrl+I)" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></IconButton><IconButton label="Underline (Cmd/Ctrl+U)" active={editor?.isActive('underline')} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UnderlineIcon size={16} /></IconButton><IconButton label="Strikethrough" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></IconButton><IconButton label="Inline code" active={editor?.isActive('code')} onClick={() => editor?.chain().focus().toggleCode().run()}><Code2 size={16} /></IconButton><span className="toolbar-divider" /><span className="toolbar-label">Structure</span><IconButton label="Bullet list" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></IconButton><IconButton label="Numbered list" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></IconButton><IconButton label="Checklist" active={editor?.isActive('taskList')} onClick={() => editor?.chain().focus().toggleTaskList().run()}><ListChecks size={16} /></IconButton><IconButton label="Blockquote" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16} /></IconButton><IconButton label="Heading 3" active={editor?.isActive('heading', { level: 3 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></IconButton><span className="toolbar-divider" /><IconButton label="Inline math (/ or Cmd/Ctrl+Shift+M)" active={mode === 'math'} onClick={toggleMath}><Sigma size={17} /></IconButton><IconButton label="Insert block menu" onClick={() => { setPalette('blocks'); setPaletteQuery(''); }}><Plus size={17} /></IconButton></div>

            <div className="editor-shell">{palette && <dialog open className="palette-panel" aria-label={palette === 'blocks' ? 'Blocks and structure' : 'Math symbols'} onKeyDown={(event) => { if (event.key === 'Escape') { setPalette(null); editor?.commands.focus(); } }}><div className="palette-header"><div><span className="eyebrow">Quick insert</span><strong>{palette === 'blocks' ? 'Blocks & structure' : 'Math symbols'}</strong></div><Button type="button" variant="ghost" size="icon-xs" onClick={() => { setPalette(null); editor?.commands.focus(); }} aria-label="Close palette"><X size={15} /></Button></div><Command value={paletteQuery} onValueChange={setPaletteQuery} shouldFilter><CommandInput ref={paletteInputRef} placeholder={palette === 'blocks' ? 'Search blocks…' : 'Search symbols…'} /><CommandList><CommandEmpty>No matching insert.</CommandEmpty><CommandGroup heading={palette === 'blocks' ? 'Insert' : 'Discrete math first'}>{filteredItems.map((item) => <CommandItem key={item.id} value={`${item.label} ${item.detail} ${item.shortcut ?? ''}`} onSelect={() => selectPaletteItem(item)}><span className="palette-icon">{item.icon}</span><span className="palette-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>{item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}</CommandItem>)}</CommandGroup></CommandList></Command></dialog>}
              <EditorContent editor={editor} />
            </div>
            <footer className="paper-footer"><span>Press <kbd>/</kbd> for math · <kbd>Tab</kbd> exits math or indents lists · <kbd>Enter</kbd> continues lists</span><span className="footer-mark">MathPad · local-first</span></footer>
          </article></div>
        </section>
      </div>
    </main>
  );
}
