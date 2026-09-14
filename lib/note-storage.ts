import type { JSONContent } from '@tiptap/core';

export type NoteDocument = {
  version: 1;
  id: string;
  title: string;
  content: JSONContent;
  updatedAt: number;
};

export type RemoteNotes = {
  notes: NoteDocument[];
  deleted: { id: string; deletedAt: number }[];
};

export function mergeNotes(localNotes: NoteDocument[], remoteNotes: NoteDocument[]) {
  const merged = new Map(localNotes.map((note) => [note.id, note]));
  for (const remoteNote of remoteNotes) {
    const localNote = merged.get(remoteNote.id);
    if (!localNote || remoteNote.updatedAt >= localNote.updatedAt) merged.set(remoteNote.id, remoteNote);
  }
  return sortNotes([...merged.values()]);
}

export class RemoteSyncUnavailableError extends Error {
  constructor(message = 'Cloud sync is not configured') {
    super(message);
    this.name = 'RemoteSyncUnavailableError';
  }
}

const DB_NAME = 'mathpad-db';
const DB_VERSION = 1;
const DB_STORE = 'notes';
const FALLBACK_STORAGE_KEY = 'mathpad-notes-fallback';
const REMOTE_ENDPOINT = '/api/notes';
const REQUEST_TIMEOUT_MS = 4500;

function sortNotes(notes: NoteDocument[]) {
  return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

function isNoteDocument(value: unknown): value is NoteDocument {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<NoteDocument>;
  return note.version === 1 && typeof note.id === 'string' && typeof note.title === 'string' && typeof note.updatedAt === 'number' && Boolean(note.content && typeof note.content === 'object');
}

function parseNotes(value: unknown): NoteDocument[] {
  if (!Array.isArray(value)) return [];
  return sortNotes(value.filter(isNoteDocument).map((note) => ({ ...note, version: 1 })));
}

function readFallbackNotes(): NoteDocument[] {
  try {
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    return raw ? parseNotes(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeFallbackNotes(notes: NoteDocument[]) {
  localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(sortNotes([...notes])));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open note storage'));
  });
}

export async function readLocalNotes(): Promise<NoteDocument[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
      request.onsuccess = () => {
        db.close();
        resolve(parseNotes(request.result));
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error('Could not read notes'));
      };
    });
  } catch {
    return readFallbackNotes();
  }
}

export async function writeLocalNote(note: NoteDocument): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(note);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error('Could not save note'));
      };
    });
  } catch {
    const notes = await readLocalNotes();
    writeFallbackNotes([...notes.filter((item) => item.id !== note.id), note]);
  }
}

export async function removeLocalNote(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(id);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error('Could not delete note'));
      };
    });
  } finally {
    try {
      const notes = await readLocalNotes();
      writeFallbackNotes(notes.filter((note) => note.id !== id));
    } catch {
      // IndexedDB remains the primary local store.
    }
  }
}

async function remoteRequest<T>(init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(REMOTE_ENDPOINT, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const payload = await response.json().catch(() => null) as { error?: string; code?: string } & T | null;
    if (response.status === 503 && payload && 'code' in payload && payload.code === 'not_configured') throw new RemoteSyncUnavailableError();
    if (!response.ok) throw new Error(payload && 'error' in payload && payload.error ? payload.error : `Cloud sync failed (${response.status})`);
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function readRemoteNotes(): Promise<RemoteNotes> {
  const payload = await remoteRequest<RemoteNotes>();
  const deleted = Array.isArray(payload.deleted)
    ? payload.deleted.filter((item) => item && typeof item.id === 'string' && typeof item.deletedAt === 'number')
    : [];
  return { notes: parseNotes(payload.notes), deleted };
}

export async function writeRemoteNote(note: NoteDocument): Promise<void> {
  await remoteRequest({ method: 'PUT', body: JSON.stringify(note) });
}

export async function removeRemoteNote(id: string): Promise<void> {
  await remoteRequest({ method: 'DELETE', body: JSON.stringify({ id }) });
}
