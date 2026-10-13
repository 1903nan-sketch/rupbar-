import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Intervalo de bytes inclusivo pedido pelo navegador. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Interpreta o cabeçalho `Range` (um único intervalo, como os navegadores
 * pedem para vídeos). Devolve:
 *  - null: sem Range aproveitável (envia o arquivo inteiro, como manda a RFC 9110);
 *  - 'unsatisfiable': começa depois do fim do arquivo (resposta 416);
 *  - o intervalo a enviar (resposta 206).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // outra unidade ou vários intervalos: arquivo inteiro
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    // sufixo: últimos N bytes
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return null; // intervalo inválido é ignorado
  if (start >= size) return 'unsatisfiable';
  return { start, end: b === '' ? size - 1 : Math.min(Number(b), size - 1) };
}

/**
 * Envia um arquivo com suporte a Range (206), ETag/If-None-Match (304) e
 * If-Range, para que o `<video>` da TV possa carregar aos poucos e avançar.
 */
export function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  file: { path: string; mime: string; size: number; etag: string },
  cacheControl: string,
) {
  reply.header('Accept-Ranges', 'bytes');
  reply.header('ETag', file.etag);
  reply.header('Cache-Control', cacheControl);
  reply.header('Content-Disposition', 'inline');
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim() === file.etag || t.trim() === `W/${file.etag}`)) return reply.status(304).send();
  const ifRange = req.headers['if-range'];
  const range = !ifRange || ifRange === file.etag ? parseRange(req.headers.range, file.size) : null;
  if (range === 'unsatisfiable') {
    reply.header('Content-Range', `bytes */${file.size}`);
    reply.header('Cache-Control', 'no-store');
    return reply.status(416).send({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Intervalo inválido.' } });
  }
  reply.header('Content-Type', file.mime);
  if (range) {
    reply.status(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return reply.send(createReadStream(file.path, { start: range.start, end: range.end }));
  }
  reply.header('Content-Length', file.size);
  return reply.send(createReadStream(file.path));
}
