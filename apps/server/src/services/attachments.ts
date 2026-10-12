import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from '../db/db';
import { sha256 } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import type { Actor, Ctx } from './context';

export const ATTACHMENT_KINDS = ['logo', 'cover', 'product_photo', 'receipt', 'loss_proof', 'invoice'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Imagens de identidade visual são públicas (tela de login e TV). */
const PUBLIC_KINDS: AttachmentKind[] = ['logo', 'cover', 'product_photo'];
const IMAGE_ONLY: AttachmentKind[] = ['logo', 'cover', 'product_photo'];
const MAX_BYTES: Record<AttachmentKind, number> = {
  logo: 2 * 1024 * 1024,
  cover: 5 * 1024 * 1024,
  product_photo: 3 * 1024 * 1024,
  receipt: 10 * 1024 * 1024,
  loss_proof: 10 * 1024 * 1024,
  invoice: 10 * 1024 * 1024,
};

/** Detecta o tipo pelo conteúdo (assinatura), nunca pela extensão informada. */
export function sniffMime(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

export class AttachmentsService {
  constructor(private readonly ctx: Ctx) {
    if (!existsSync(ctx.config.attachmentsDir)) mkdirSync(ctx.config.attachmentsDir, { recursive: true });
  }

  save(actor: Actor, kind: AttachmentKind, data: Buffer, originalName: string | null) {
    if (!ATTACHMENT_KINDS.includes(kind)) throw badRequest('Tipo de anexo inválido.');
    if (data.length === 0) throw badRequest('Arquivo vazio.');
    if (data.length > MAX_BYTES[kind]) throw badRequest(`Arquivo muito grande (máximo ${Math.round(MAX_BYTES[kind] / 1024 / 1024)} MB).`, 'FILE_TOO_LARGE');
    const sniffed = sniffMime(data);
    if (!sniffed) throw badRequest('Formato não suportado. Envie JPG, PNG, WEBP ou PDF.', 'UNSUPPORTED_FILE');
    if (IMAGE_ONLY.includes(kind) && !sniffed.mime.startsWith('image/')) throw badRequest('Envie uma imagem (JPG, PNG ou WEBP).', 'UNSUPPORTED_FILE');
    const id = this.ctx.id();
    const stored = `${id}.${sniffed.ext}`;
    writeFileSync(join(this.ctx.config.attachmentsDir, stored), data, { flag: 'wx' });
    this.ctx.tx(() => {
      this.ctx.db.run(
        'INSERT INTO attachments (id, sha256, mime, size, original_name, stored_name, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, sha256(data), sniffed.mime, data.length, originalName?.slice(0, 120) ?? null, stored, kind, actor.userId, this.ctx.nowIso(),
      );
      this.ctx.audit(actor, 'attachments.uploaded', 'attachment', id, { kind, mime: sniffed.mime, size: data.length });
    });
    return { id, mime: sniffed.mime, size: data.length, url: `/api/files/${id}` };
  }

  meta(id: string): Row {
    const a = this.ctx.db.get('SELECT * FROM attachments WHERE id = ?', id);
    if (!a) throw notFound('Arquivo');
    return a;
  }

  isPublic(a: Row): boolean {
    return PUBLIC_KINDS.includes(a.kind as AttachmentKind);
  }

  read(a: Row): Buffer {
    return readFileSync(join(this.ctx.config.attachmentsDir, String(a.stored_name)));
  }
}
