import { Printer, PrinterX } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { Button, Switch, useToast } from './ui';

/** Liga/desliga lembrados no PC (valem para todos os aparelhos). */
export interface PrintSwitches {
  /** Pedidos das comandas: cozinha, balcão e ticket no caixa. */
  orders: boolean;
  /** Ticket do pedido da venda rápida. */
  quickTicket: boolean;
  /** Comprovante de pagamento da venda rápida. */
  quickReceipt: boolean;
  /** Impressões esperando na fila. */
  queued: number;
}

export function usePrintSwitches() {
  const toast = useToast();
  const [sw, setSw] = useState<PrintSwitches | null>(null);
  const load = useCallback(async () => {
    try {
      setSw(await api.get<PrintSwitches>('/api/printing/switches'));
    } catch {
      // Sem conexão: tenta de novo quando o PC voltar.
    }
  }, []);
  useEffect(() => void load(), [load]);
  useRealtime(['print.switches'], (e) => (e.type === 'print.switches' ? setSw(e.data as PrintSwitches) : void load()));
  const set = useCallback(async (patch: Partial<Omit<PrintSwitches, 'queued'>>) => {
    setSw((s) => (s ? { ...s, ...patch } : s));
    try {
      const r = await api.post<PrintSwitches & { discarded: number }>('/api/printing/switches', patch);
      setSw(r);
      return r;
    } catch (e) {
      toast.error(e);
      void load();
      return null;
    }
  }, [load, toast]);
  return { sw, set };
}

/** Botão da barra do topo: um toque liga ou desliga a impressão dos pedidos. */
export function PrintToggle() {
  const { can } = useSession();
  const toast = useToast();
  const { sw, set } = usePrintSwitches();
  if (!sw || !(can('orders.create') || can('cash.payment') || can('printers.manage'))) return null;
  const on = sw.orders;
  const toggle = async () => {
    const r = await set({ orders: !on });
    if (!r) return;
    const fila = r.discarded ? ` (${r.discarded} da fila descartado${r.discarded === 1 ? '' : 's'})` : '';
    if (r.orders) toast.success(`Impressão de pedidos ligada: só os pedidos novos saem${fila}.`);
    else toast.success(`Impressão de pedidos desligada: nenhum papel de pedido sai até ligar de novo${fila}.`);
  };
  return (
    <Button
      size="small"
      className={`topbar-action topbar-extra print-toggle ${on ? 'on' : 'off'}`}
      icon={on ? <Printer size={15} /> : <PrinterX size={15} />}
      aria-pressed={on}
      title={on ? 'Impressão de pedidos LIGADA — toque para desligar' : 'Impressão de pedidos DESLIGADA — toque para ligar (a fila parada não sai)'}
      onClick={() => void toggle()}
    >
      {on ? 'Pedidos: ligado' : 'Pedidos: desligado'}
    </Button>
  );
}

/** Os três liga/desliga juntos (Configurações → Impressoras). */
export function PrintSwitchesPanel() {
  const { sw, set } = usePrintSwitches();
  if (!sw) return null;
  return (
    <div className="stack">
      <Switch checked={sw.orders} onChange={(v) => void set({ orders: v })} label="Pedidos das comandas" description="Cozinha, balcão e o ticket no caixa. Desligado não sai papel; ao ligar, a fila parada não sai." />
      <Switch checked={sw.quickTicket} onChange={(v) => void set({ quickTicket: v })} label="Ticket do pedido na venda rápida" description="Fica como você deixar para as próximas vendas." />
      <Switch checked={sw.quickReceipt} onChange={(v) => void set({ quickReceipt: v })} label="Comprovante de pagamento na venda rápida" description="Fica como você deixar para as próximas vendas." />
    </div>
  );
}
