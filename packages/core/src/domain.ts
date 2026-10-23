/** Enumerações de domínio e seus rótulos em português. */

export const PAYMENT_METHODS = {
  cash: 'Dinheiro',
  pix: 'Pix',
  debit: 'Débito',
  credit: 'Crédito',
  voucher: 'Vale-refeição',
  other: 'Outro',
} as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export const STATIONS = {
  kitchen: 'Cozinha',
  bar: 'Balcão/Bebidas',
  none: 'Sem preparo',
} as const;
export type Station = keyof typeof STATIONS;

export const TICKET_STATUS = {
  received: 'Recebido',
  preparing: 'Em preparo',
  ready: 'Pronto',
  delivered: 'Entregue',
  canceled: 'Cancelado',
} as const;
export type TicketStatus = keyof typeof TICKET_STATUS;

/** Transições válidas do painel de produção. */
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  received: ['preparing', 'ready', 'canceled'],
  preparing: ['ready', 'received', 'canceled'],
  ready: ['delivered', 'preparing', 'canceled'],
  delivered: ['ready'],
  canceled: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export const COMANDA_STATUS = {
  open: 'Aberta',
  closed: 'Encerrada',
  canceled: 'Cancelada',
} as const;
export type ComandaStatus = keyof typeof COMANDA_STATUS;

export const LOSS_REASONS = {
  expired: 'Vencimento',
  broken: 'Quebra',
  spilled: 'Derramamento',
  missing: 'Extravio',
  spoiled: 'Deterioração',
  other: 'Outros',
} as const;
export type LossReason = keyof typeof LOSS_REASONS;

export const LOSS_STATUS = {
  pending_application: 'Aguardando aplicação',
  applied: 'Aplicada',
  conflict: 'Conflito de estoque',
  rejected: 'Rejeitada',
} as const;
export type LossStatus = keyof typeof LOSS_STATUS;

export const HOOKAH_STATUS = {
  available: 'Disponível',
  rented: 'Alugado',
  cleaning: 'Em limpeza',
  maintenance: 'Em manutenção',
  inactive: 'Inativo',
} as const;
export type HookahStatus = keyof typeof HOOKAH_STATUS;

export const CASH_MOVEMENT_TYPES = {
  withdrawal: 'Sangria',
  supply: 'Suprimento',
} as const;
export type CashMovementType = keyof typeof CASH_MOVEMENT_TYPES;

export const STOCK_MOVEMENT_TYPES = {
  purchase: 'Entrada de mercadoria',
  sale: 'Venda',
  sale_reversal: 'Estorno de venda',
  loss: 'Perda',
  adjustment: 'Ajuste',
  inventory: 'Inventário',
  hookah: 'Consumo de narguilé',
  hookah_reversal: 'Estorno de narguilé',
  initial: 'Saldo inicial',
  purchase_cancel: 'Entrada excluída',
  loss_reversal: 'Perda excluída',
  correction: 'Correção do proprietário',
} as const;
export type StockMovementType = keyof typeof STOCK_MOVEMENT_TYPES;

export const DEFAULT_CATEGORIES: { name: string; station: Station; icon: string }[] = [
  { name: 'Cervejas', station: 'bar', icon: 'beer' },
  { name: 'Destilados', station: 'bar', icon: 'wine' },
  { name: 'Refrigerantes', station: 'bar', icon: 'cup-soda' },
  { name: 'Águas', station: 'bar', icon: 'glass-water' },
  { name: 'Energéticos', station: 'bar', icon: 'zap' },
  { name: 'Drinks', station: 'bar', icon: 'martini' },
  { name: 'Porções', station: 'kitchen', icon: 'utensils' },
  { name: 'Refeições', station: 'kitchen', icon: 'chef-hat' },
  { name: 'Essências', station: 'none', icon: 'leaf' },
  { name: 'Carvão', station: 'none', icon: 'flame' },
  { name: 'Narguilés', station: 'none', icon: 'wind' },
  { name: 'Outros', station: 'none', icon: 'package' },
];

export const SYNC_STATUS = {
  synced: 'Sincronizado',
  syncing: 'Sincronizando',
  offline: 'Sem internet',
  pending: 'Pendências',
  error: 'Erro de sincronização',
  disabled: 'Nuvem não configurada',
} as const;
export type SyncStatus = keyof typeof SYNC_STATUS;

export const PRINT_JOB_KINDS = {
  order_ticket: 'Pedido de produção',
  pickup_ticket: 'Ticket do pedido (cliente)',
  receipt: 'Conferência de conta',
  cash_close: 'Fechamento de caixa',
  test: 'Teste de impressão',
} as const;
export type PrintJobKind = keyof typeof PRINT_JOB_KINDS;

/**
 * Nome da apresentação para mostrar junto do produto, ou null quando só
 * repetiria: "Unidade" ou o próprio nome do produto ("Heineken" · "Heineken").
 */
export function presentationSuffix(productName: string, presentationName: string): string | null {
  const key = (s: string) => s.trim().toLocaleLowerCase('pt-BR');
  const pres = key(presentationName);
  return !pres || pres === 'unidade' || pres === key(productName) ? null : presentationName;
}

/**
 * Código do ticket do pedido (vai no código de barras): "RB" + dia de
 * movimento (AAMMDD) + número do pedido. Ex.: RB2610160042. A numeração dos
 * pedidos recomeça a cada dia, por isso o dia faz parte do código.
 */
export function pickupCode(businessDay: string, orderNumber: number): string {
  const [y = '', m = '', d = ''] = businessDay.split('-');
  return `RB${y.slice(-2)}${m}${d}${String(orderNumber).padStart(orderNumber > 9999 ? 6 : 4, '0')}`;
}

/** Lê o código do ticket (bipado ou digitado). Aceita minúsculas, espaços e hífens. */
export function parsePickupCode(raw: string): { businessDay: string; orderNumber: number } | null {
  const m = /^RB(\d{2})(\d{2})(\d{2})(\d{4}|\d{6})$/.exec(raw.replace(/[\s-]/g, '').toUpperCase());
  if (!m) return null;
  const [, yy, mm, dd, n] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return { businessDay: `20${yy}-${mm}-${dd}`, orderNumber: Number(n) };
}

// ------------------------------------------------------------- comandas

/** regular: cliente · quick: venda rápida · staff: consumo de funcionário (não cobrado, fora das vendas). */
export type ComandaKind = 'regular' | 'quick' | 'staff';

/**
 * Número que o cliente/garçom enxerga: o do cartão físico quando houver,
 * senão o número sequencial do sistema. Venda rápida não tem comanda visível.
 */
export function comandaDisplayNumber(c: { number: number; cardNumber?: number | null; kind?: ComandaKind | string | null }): number | null {
  if (c.kind === 'quick') return null;
  return c.cardNumber ?? c.number;
}

/** "Comanda 23" / "Venda rápida 105" (para listas e cupons). */
export function comandaLabel(c: { number: number; cardNumber?: number | null; kind?: ComandaKind | string | null }): string {
  if (c.kind === 'quick') return `Venda rápida ${c.number}`;
  return `Comanda ${c.cardNumber ?? c.number}`;
}
