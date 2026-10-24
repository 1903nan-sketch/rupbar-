import { barDay, isValidDay, reportFileName, reportWindow, type FullReport } from '@rupbar/core';
import { renderReportPdf } from '@rupbar/core/pdf';
import type { NextRequest } from 'next/server';
import { currentEstablishment } from '@/lib/data';

/** Relatório completo em PDF: ?de=AAAA-MM-DD&ate=AAAA-MM-DD (&abrir=1 abre no navegador para imprimir). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const de = isValidDay(q.get('de')) ? q.get('de')! : barDay();
  const ate = isValidDay(q.get('ate')) ? q.get('ate')! : de;
  const w = reportWindow(de, ate);
  const { sb, est } = await currentEstablishment();
  if (!est) return new Response('Nenhum estabelecimento vinculado.', { status: 404 });
  const { data, error } = await sb.rpc('rupbar_full_report', { p_establishment_id: est.id, p_de: w.de, p_ate: w.ate });
  if (error || !data) return new Response('Não foi possível gerar o relatório.', { status: 500 });
  const pdf = renderReportPdf(data as FullReport);
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${q.get('abrir') === '1' ? 'inline' : 'attachment'}; filename="${reportFileName(w.de, w.ate)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
