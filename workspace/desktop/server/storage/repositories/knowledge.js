const crypto = require('crypto');

function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || `entry-${Date.now()}`;
}

class KnowledgeRepository {
  /**
   * @param {import('../database').DatabaseManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  list({ category, q, limit = 50, offset = 0, status = 'active' } = {}) {
    let sql = 'SELECT * FROM knowledge_entries WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (q && q.trim()) {
      sql += ' AND (title LIKE ? OR description LIKE ? OR content LIKE ?)';
      const term = `%${q.trim()}%`;
      params.push(term, term, term);
    }

    // Count query
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
    const totalRow = this.db.prepare(countSql).get(...params);
    const total = totalRow ? Number(totalRow.total) : 0;

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);

    return {
      entries: rows.map(r => this._mapRow(r)),
      total,
    };
  }

  search({ q, category, limit = 20 } = {}) {
    const query = String(q || '').trim();
    if (!query) {
      return { query: '', total_matches: 0, results: [] };
    }

    try {
      let ftsSql = `
        SELECT
          k.id AS entry_id,
          k.slug,
          k.title,
          k.category,
          snippet(knowledge_fts, -1, '<mark>', '</mark>', '...', 20) AS snippet,
          length(k.content) AS char_count,
          bm25(knowledge_fts) AS rank
        FROM knowledge_fts f
        JOIN knowledge_entries k ON k.id = f.entry_id
        WHERE knowledge_fts MATCH ?
      `;
      const params = [query];

      if (category) {
        ftsSql += ' AND k.category = ?';
        params.push(category);
      }

      ftsSql += ' ORDER BY rank ASC LIMIT ?';
      params.push(limit);

      const rows = this.db.prepare(ftsSql).all(...params);

      return {
        query,
        total_matches: rows.length,
        results: rows.map((r, idx) => ({
          chunk_id: `chunk-${r.entry_id}-${idx}`,
          entry_id: r.entry_id,
          slug: r.slug,
          title: r.title,
          category: r.category || 'general',
          section: 'main',
          section_path: [r.category || 'general', r.title],
          snippet: r.snippet || '',
          char_count: Number(r.char_count || 0),
          score: Math.max(0, 1 - (Number(r.rank) / 100)),
        })),
      };
    } catch (_) {
      // Fallback to LIKE search if FTS query syntax error
      const likeTerm = `%${query}%`;
      let sql = `
        SELECT id AS entry_id, slug, title, category, substr(content, 1, 150) AS snippet, length(content) AS char_count
        FROM knowledge_entries
        WHERE (title LIKE ? OR content LIKE ? OR description LIKE ?)
      `;
      const params = [likeTerm, likeTerm, likeTerm];
      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }
      sql += ' LIMIT ?';
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params);
      return {
        query,
        total_matches: rows.length,
        results: rows.map((r, idx) => ({
          chunk_id: `chunk-${r.entry_id}-${idx}`,
          entry_id: r.entry_id,
          slug: r.slug,
          title: r.title,
          category: r.category || 'general',
          section: 'main',
          section_path: [r.category || 'general', r.title],
          snippet: r.snippet || '',
          char_count: Number(r.char_count || 0),
          score: 0.5,
        })),
      };
    }
  }

  get(idOrSlug) {
    if (!idOrSlug) return null;
    const row = this.db.prepare(`
      SELECT * FROM knowledge_entries
      WHERE id = ? OR slug = ?
    `).get(idOrSlug, idOrSlug);

    return row ? this._mapRow(row) : null;
  }

  create({
    id,
    projectId = null,
    slug,
    title,
    description = null,
    category = 'general',
    content,
    createdBy = 'human:user',
    status = 'active',
  }) {
    if (!title || typeof title !== 'string') throw new Error('Knowledge title is required');
    if (!content || typeof content !== 'string') throw new Error('Knowledge content is required');

    const entryId = id || `k_${crypto.randomUUID()}`;
    const baseSlug = slug || slugify(title);
    let finalSlug = baseSlug;

    // Check slug collision
    const existing = this.db.prepare('SELECT id FROM knowledge_entries WHERE slug = ?').get(baseSlug);
    if (existing) {
      finalSlug = `${baseSlug}-${Date.now().toString().slice(-4)}`;
    }

    const now = new Date().toISOString();
    const contentSize = Buffer.byteLength(content, 'utf8');

    this.db.prepare(`
      INSERT INTO knowledge_entries (
        id, project_id, slug, title, description, category, content, content_size,
        created_by, updated_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      projectId,
      finalSlug,
      title.trim(),
      description ? description.trim() : null,
      category ? category.trim() : 'general',
      content,
      contentSize,
      createdBy,
      null,
      status,
      now,
      now
    );

    return this.get(entryId);
  }

  update(id, data = {}) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Knowledge entry not found: ${id}`);

    const title = data.title !== undefined ? data.title.trim() : existing.title;
    const description = data.description !== undefined ? data.description : existing.description;
    const category = data.category !== undefined ? data.category.trim() : existing.category;
    const content = data.content !== undefined ? data.content : existing.content;
    const status = data.status !== undefined ? data.status : existing.status;
    const updatedBy = data.updatedBy !== undefined ? data.updatedBy : 'human:user';
    const now = new Date().toISOString();
    const contentSize = Buffer.byteLength(content, 'utf8');

    this.db.prepare(`
      UPDATE knowledge_entries SET
        title = ?,
        description = ?,
        category = ?,
        content = ?,
        content_size = ?,
        updated_by = ?,
        status = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      title,
      description,
      category,
      content,
      contentSize,
      updatedBy,
      status,
      now,
      existing.id
    );

    return this.get(existing.id);
  }

  delete(id) {
    const res = this.db.prepare('DELETE FROM knowledge_entries WHERE id = ? OR slug = ?').run(id, id);
    return res.changes > 0;
  }

  _mapRow(r) {
    return {
      id: r.id,
      projectId: r.project_id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      category: r.category,
      content: r.content,
      contentSize: Number(r.content_size || 0),
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

module.exports = { KnowledgeRepository };
