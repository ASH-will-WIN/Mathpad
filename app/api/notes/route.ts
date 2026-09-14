import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

type NoteDocument = {
  version: 1;
  id: string;
  title: string;
  content: Record<string, unknown>;
  updatedAt: number;
};

let schemaReady: Promise<void> | null = null;

function getDatabase() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    return null;
  }
  return neon(url);
}

async function ensureSchema(sql: NeonQueryFunction<false, false>) {
  if (!schemaReady) {
    schemaReady = sql`
      CREATE TABLE IF NOT EXISTS mathpad_notes (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        content JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1,
        deleted_at BIGINT
      )
    `.then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(body, {
    ...init,
    headers,
  });
}

function notConfigured() {
  return jsonResponse({ code: 'not_configured', error: 'Cloud sync is not configured yet.' }, { status: 503 });
}

function isNoteDocument(value: unknown): value is NoteDocument {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<NoteDocument>;
  return note.version === 1 && typeof note.id === 'string' && note.id.length <= 200 && typeof note.title === 'string' && note.title.length <= 500 && typeof note.updatedAt === 'number' && Number.isFinite(note.updatedAt) && Boolean(note.content && typeof note.content === 'object');
}

function isNoteId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

export async function GET() {
  const sql = getDatabase();
  if (!sql) return notConfigured();
  try {
    await ensureSchema(sql);
    const rows = await sql`
      SELECT id, version, title, content, updated_at
      FROM mathpad_notes
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC
    `;
    const deletedRows = await sql`
      SELECT id, deleted_at
      FROM mathpad_notes
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
    `;
    return jsonResponse({
      notes: rows.map((row) => ({ id: row.id, version: 1, title: row.title, content: row.content, updatedAt: Number(row.updated_at) })),
      deleted: deletedRows.map((row) => ({ id: row.id, deletedAt: Number(row.deleted_at) })),
    });
  } catch (error) {
    console.error('MathPad cloud read failed', error);
    return jsonResponse({ error: 'Could not read cloud notes.' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const sql = getDatabase();
  if (!sql) return notConfigured();
  try {
    const body = await request.json().catch(() => null);
    if (!isNoteDocument(body)) return jsonResponse({ error: 'Invalid note.' }, { status: 400 });
    await ensureSchema(sql);
    await sql`
      INSERT INTO mathpad_notes (id, version, title, content, updated_at, revision, deleted_at)
      VALUES (${body.id}, 1, ${body.title}, CAST(${JSON.stringify(body.content)} AS JSONB), ${body.updatedAt}, 1, NULL)
      ON CONFLICT (id) DO UPDATE SET
        version = 1,
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        updated_at = EXCLUDED.updated_at,
        revision = mathpad_notes.revision + 1,
        deleted_at = NULL
      WHERE EXCLUDED.updated_at >= mathpad_notes.updated_at
    `;
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('MathPad cloud write failed', error);
    return jsonResponse({ error: 'Could not save cloud note.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const sql = getDatabase();
  if (!sql) return notConfigured();
  try {
    const body = await request.json().catch(() => null) as { id?: unknown } | null;
    if (!body || !isNoteId(body.id)) return jsonResponse({ error: 'Invalid note id.' }, { status: 400 });
    await ensureSchema(sql);
    const deletedAt = Date.now();
    await sql`
      INSERT INTO mathpad_notes (id, version, title, content, updated_at, revision, deleted_at)
      VALUES (${body.id}, 1, '', CAST(${JSON.stringify({ type: 'doc', content: [] })} AS JSONB), ${deletedAt}, 1, ${deletedAt})
      ON CONFLICT (id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        revision = mathpad_notes.revision + 1,
        deleted_at = EXCLUDED.deleted_at
      WHERE EXCLUDED.updated_at >= mathpad_notes.updated_at
    `;
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('MathPad cloud delete failed', error);
    return jsonResponse({ error: 'Could not delete cloud note.' }, { status: 500 });
  }
}
