/**
 * Generic storage for extensions: one Durable Object per (extension, original site origin), holding a collection of
 * JSON items keyed to the page they belong to. Extensions get it for free through the toolbar's `px.store`, so a new
 * extension needs no server code. SQLite-backed, so concurrent writers from several reviewers can't clobber each other.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export interface StoredItem {
	id: string;
	/** Original page URL without the fragment: https://site.com/path?query */
	page: string;
	created: number;
	updated: number;
	data: Record<string, unknown>;
}

const MAX_ITEMS = 5000;
export const MAX_ITEM_BYTES = 256 * 1024; // a note with a few freehand drawings is tens of KB

type Row = { id: string; page: string; created: number; updated: number; data: string };
const toItem = (r: Row): StoredItem => ({ id: r.id, page: r.page, created: r.created, updated: r.updated, data: JSON.parse(r.data) });

export class ExtStoreDO extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, page TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
			 CREATE INDEX IF NOT EXISTS items_page ON items (page, created);`,
		);
	}

	list(page: string | null): StoredItem[] {
		const rows = page
			? this.sql.exec<Row>('SELECT * FROM items WHERE page = ? ORDER BY created', page)
			: this.sql.exec<Row>('SELECT * FROM items ORDER BY page, created');
		return rows.toArray().map(toItem);
	}

	create(page: string, data: Record<string, unknown>): StoredItem | null {
		const count = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM items').one().n;
		if (count >= MAX_ITEMS) return null;
		const now = Date.now();
		const item: StoredItem = { id: crypto.randomUUID(), page, created: now, updated: now, data };
		this.sql.exec('INSERT INTO items VALUES (?, ?, ?, ?, ?)', item.id, page, now, now, JSON.stringify(data));
		return item;
	}

	/** Shallow merge; a null value removes that key. */
	update(id: string, patch: Record<string, unknown>): StoredItem | null {
		const row = this.sql.exec<Row>('SELECT * FROM items WHERE id = ?', id).toArray()[0];
		if (!row) return null;
		const data: Record<string, unknown> = { ...JSON.parse(row.data) };
		for (const [k, v] of Object.entries(patch)) {
			if (v === null) delete data[k];
			else data[k] = v;
		}
		const text = JSON.stringify(data);
		if (text.length > MAX_ITEM_BYTES) return null;
		const now = Date.now();
		this.sql.exec('UPDATE items SET data = ?, updated = ? WHERE id = ?', text, now, id);
		return { ...toItem(row), data, updated: now };
	}

	remove(id: string): boolean {
		return this.sql.exec('DELETE FROM items WHERE id = ?', id).rowsWritten > 0;
	}
}
