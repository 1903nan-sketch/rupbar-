import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tvMediaOrderSchema, tvMediaUpdateSchema } from '@rupbar/core/schemas';
import type { Row } from '../db/db';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { sniffMime } from './attachments';
import { requirePerm, type Actor, type Ctx } from './context';

const MB = 1024 * 1024;
/** Quantidade máxima de anúncios guardados. */
const MAX_ITEMS = 100;
const DEFAULT_IMAGE_SECONDS = 10;
/** Bytes iniciais usados para reconhecer o formato. */
const HEAD_BYTES = 64;

/** Marcas "ftyp" que não são vídeo reproduzível no navegador (fotos HEIC/AVIF, áudio M4A, QuickTime). */
const NON_VIDEO_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'crx ', 'qt  ']);

export type TvMediaKind = 'image' | 'video';

/** Reconhece foto (JPG/PNG/WEBP) ou vídeo (MP4/WEBM) pelo conteúdo, nunca pela extensão. */
export function sniffTvMedia(head: Buffer): { kind: TvMediaKind; mime: string; ext: string } | null {
  const img = sniffMime(head);
  if (img) return img.mime.startsWith('image/') ? { kind: 'image', ...img } : null;
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    return NON_VIDEO_BRANDS.has(brand) ? null : { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  // WebM: cabeçalho EBML com DocType "webm" (Matroska genérico fica de fora).
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 && head.includes('webm', 0, 'latin1')) {
    return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  }
  return null;
}

export interface TvMediaView {
  id: string;
  kind: TvMediaKind;
  mime: string;
  size: number;
  title: string;
  originalName: string | null;
  durationSeconds: number;
  position: number;
  enabled: boolean;
  /** Arquivo ausente no disco (apagado ou corrompido): a TV pula este item. */
  missing: boolean;
  url: string;
  createdAt: string;
}

/** Item da sequência de anúncios entregue à TV (somente ativos e com arquivo presente). */
export interface TvPlaylistItem {
  id: string;
  kind: TvMediaKind;
  mime: string;
  title: string;
  durationSeconds: number;
  url: string;
}

/**
 * Anúncios da TV de retirada: fotos e vídeos enviados pelo painel do PC e
 * guardados localmente. A TV os recebe junto com o painel e os reproduz pela
 * rede local (com suporte a Range para vídeos).
 */
export class TvMediaService {
  readonly dir: string;
  /** Limites ajustáveis (os testes reduzem para não gerar arquivos enormes). */
  maxVideoBytes = 300 * MB;
  maxImageBytes = 20 * MB;

  constructor(private readonly ctx: Ctx) {
    this.dir = join(ctx.config.dataDir, 'tv-media');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private path(row: Row): string {
    return join(this.dir, String(row.stored_name));
  }

  private view(row: Row): TvMediaView {
    return {
      id: String(row.id),
      kind: row.kind as TvMediaKind,
      mime: String(row.mime),
      size: Number(row.size),
      title: String(row.title ?? ''),
      originalName: (row.original_name as string | null) ?? null,
      durationSeconds: Number(row.duration_s),
      position: Number(row.position),
      enabled: !!row.enabled,
      missing: !existsSync(this.path(row)),
      // O conteúdo de um id nunca muda: a versão no endereço permite cache longo na TV.
      url: `/api/tv/media/${String(row.id)}/file?v=${String(row.sha256).slice(0, 12)}`,
      createdAt: String(row.created_at),
    };
  }

  private row(id: string): Row {
    const r = this.ctx.db.get('SELECT * FROM tv_media WHERE id = ?', id);
    if (!r) throw notFound('Anúncio');
    return r;
  }

  private changed(): void {
    this.ctx.emit({ channel: 'tv', type: 'tv.config' });
  }

  list(actor: Actor): TvMediaView[] {
    requirePerm(actor, 'devices.manage');
    return this.ctx.db.all('SELECT * FROM tv_media ORDER BY position, created_at').map((r) => this.view(r));
  }

  /** Sequência para a TV: somente anúncios ativos cujo arquivo existe. */
  playlist(): TvPlaylistItem[] {
    return this.ctx.db
      .all('SELECT * FROM tv_media WHERE enabled = 1 ORDER BY position, created_at')
      .map((r) => this.view(r))
      .filter((m) => !m.missing)
      .map(({ id, kind, mime, title, durationSeconds, url }) => ({ id, kind, mime, title, durationSeconds, url }));
  }

  /**
   * Grava o arquivo enviado direto no disco (sem carregar o vídeo inteiro na
   * memória), confere o formato pela assinatura e registra o anúncio.
   */
  async upload(actor: Actor, input: Readable & { truncated?: boolean }, originalName: string | null): Promise<TvMediaView> {
    requirePerm(actor, 'devices.manage');
    if (Number(this.ctx.db.value('SELECT COUNT(*) FROM tv_media')) >= MAX_ITEMS) {
      input.resume(); // descarta o restante do envio
      throw conflict(`Limite de ${MAX_ITEMS} anúncios atingido. Exclua algum para enviar outro.`, 'TV_MEDIA_LIMIT');
    }
    const id = this.ctx.id();
    const tmp = join(this.dir, `${id}.part`);
    const hash = createHash('sha256');
    const limit = this.maxVideoBytes;
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(tooLarge(limit));
        hash.update(chunk);
        if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, meter, createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      removeQuietly(tmp);
      input.resume();
      throw err;
    }
    const fail = (e: AppError): never => {
      removeQuietly(tmp);
      throw e;
    };
    if (input.truncated) fail(tooLarge(limit));
    if (size === 0) fail(badRequest('Arquivo vazio.'));
    const sniffed = sniffTvMedia(head);
    if (!sniffed) return fail(badRequest('Formato não suportado. Envie foto (JPG, PNG ou WEBP) ou vídeo (MP4 ou WEBM).', 'UNSUPPORTED_FILE'));
    if (sniffed.kind === 'image' && size > this.maxImageBytes) fail(tooLarge(this.maxImageBytes, 'fotos'));
    const stored = `${id}.${sniffed.ext}`;
    renameSync(tmp, join(this.dir, stored));
    const name = originalName?.slice(0, 120) ?? null;
    const title = (name ?? '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);
    try {
      this.ctx.tx(() => {
        const position = Number(this.ctx.db.value('SELECT COALESCE(MAX(position), 0) + 1 FROM tv_media'));
        const now = this.ctx.nowIso();
        this.ctx.db.run(
          `INSERT INTO tv_media (id, kind, mime, size, sha256, stored_name, original_name, title, duration_s, position, enabled, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
          id, sniffed.kind, sniffed.mime, size, hash.digest('hex'), stored, name, title, DEFAULT_IMAGE_SECONDS, position, actor.userId, now, now,
        );
        this.ctx.audit(actor, 'tv.media_uploaded', 'tv_media', id, { kind: sniffed.kind, mime: sniffed.mime, size });
        this.changed();
      });
    } catch (err) {
      removeQuietly(join(this.dir, stored));
      throw err;
    }
    return this.view(this.row(id));
  }

  update(actor: Actor, id: string, raw: unknown): TvMediaView {
    requirePerm(actor, 'devices.manage');
    const input = tvMediaUpdateSchema.parse(raw);
    return this.ctx.tx(() => {
      const cur = this.row(id);
      this.ctx.db.run(
        'UPDATE tv_media SET title = ?, duration_s = ?, enabled = ?, updated_at = ? WHERE id = ?',
        input.title ?? String(cur.title), input.durationSeconds ?? Number(cur.duration_s), input.enabled ?? !!cur.enabled, this.ctx.nowIso(), id,
      );
      this.ctx.audit(actor, 'tv.media_updated', 'tv_media', id, input);
      this.changed();
      return this.view(this.row(id));
    });
  }

  /** Reordena: os ids informados vêm primeiro, na ordem dada; os demais mantêm a ordem relativa. */
  reorder(actor: Actor, raw: unknown): TvMediaView[] {
    requirePerm(actor, 'devices.manage');
    const { ids } = tvMediaOrderSchema.parse(raw);
    return this.ctx.tx(() => {
      const all = this.ctx.db.all<{ id: string }>('SELECT id FROM tv_media ORDER BY position, created_at').map((r) => r.id);
      const known = new Set(all);
      const unknown = ids.find((i) => !known.has(i));
      if (unknown) throw notFound('Anúncio');
      const first = [...new Set(ids)];
      const order = [...first, ...all.filter((i) => !first.includes(i))];
      order.forEach((mediaId, i) => this.ctx.db.run('UPDATE tv_media SET position = ? WHERE id = ?', i + 1, mediaId));
      this.ctx.audit(actor, 'tv.media_reordered', 'tv_media', null, { ids: order });
      this.changed();
      return this.list(actor);
    });
  }

  remove(actor: Actor, id: string): void {
    requirePerm(actor, 'devices.manage');
    const r = this.ctx.tx(() => {
      const row = this.row(id);
      this.ctx.db.run('DELETE FROM tv_media WHERE id = ?', id);
      this.ctx.audit(actor, 'tv.media_deleted', 'tv_media', id, { title: row.title, kind: row.kind });
      this.changed();
      return row;
    });
    removeQuietly(this.path(r));
  }

  /** Arquivo para reprodução (a rota cuida da autorização e do Range). */
  file(id: string): { path: string; mime: string; size: number; etag: string } {
    const r = this.row(id);
    const path = this.path(r);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new AppError(404, 'MEDIA_MISSING', 'Arquivo do anúncio não encontrado no PC.');
    }
    return { path, mime: String(r.mime), size, etag: `"${String(r.sha256).slice(0, 32)}"` };
  }
}

function tooLarge(max: number, what = 'vídeos'): AppError {
  return new AppError(413, 'FILE_TOO_LARGE', `Arquivo muito grande (máximo ${Math.round(max / MB)} MB para ${what}).`);
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* já removido */
  }
}
