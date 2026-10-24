import {
  billTotals, comandaDisplayNumber, comandaLabel, displayName, firstName, formatBRL, maskCpf, maskPhone, parsePickupCode, pickupCode, presentationSuffix,
  splitEqually, type Station,
} from '@rupbar/core';
import {
  cancelComandaSchema, cancelItemSchema, closeComandaSchema, comandaEditSchema, comandaOpenSchema, discountRequestSchema, discountSchema, moveItemsSchema,
  orderCreateSchema,
  serviceFeeSchema, transferSchema, swapItemSchema,
} from '@rupbar/core/schemas';
import type { Row } from '../db/db';
import { badRequest, conflict, forbidden, notFound, staleVersion } from '../lib/errors';
import { businessDay } from '../lib/time';
import { hasPerm, requirePerm, type Actor, type Ctx } from './context';
import type { SettingsService } from './settings';
import type { StockService } from './stock';

export type OrderSource = 'desktop' | 'mobile' | 'quick';

export interface OrderCreatedHook {
  (orderId: string): void;
}

export class ComandasService {
  /** Chamado dentro da transação após criar o pedido (impressão automática). */
  onOrderCreated: OrderCreatedHook = () => {};

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly stock: StockService,
  ) {}

  /**
   * Encerra as locações de narguilé junto com a comanda (ligado pelo
   * HookahService na montagem dos serviços). Sem ele, a comanda não encerra com
   * narguilé em uso.
   */
  endHookahs: (actor: Actor, comandaId: string, outcome: 'closed' | 'canceled') => void = (_actor, comandaId) => {
    if (Number(this.ctx.db.value("SELECT COUNT(*) FROM hookah_sessions WHERE comanda_id = ? AND status = 'active'", comandaId)) > 0) {
      throw conflict('Há narguilé em uso nesta comanda. Registre a devolução antes de encerrar.', 'HOOKAH_ACTIVE');
    }
  };

  private row(id: string): Row {
    const c = this.ctx.db.get('SELECT * FROM comandas WHERE id = ?', id);
    if (!c) throw notFound('Comanda');
    return c;
  }

  private requireOpen(c: Row): void {
    if (c.status !== 'open') throw conflict('Esta comanda já foi encerrada ou cancelada.', 'COMANDA_NOT_OPEN');
  }

  private checkVersion(c: Row, expected: number): void {
    if (Number(c.version) !== expected) throw staleVersion();
  }

  /** Incrementa a versão (controle de concorrência) e avisa os outros dispositivos. */
  touch(comandaId: string, change: string): void {
    this.ctx.db.run('UPDATE comandas SET version = version + 1, updated_at = ? WHERE id = ?', this.ctx.nowIso(), comandaId);
    this.ctx.emit({ channel: 'comandas', type: 'comanda.changed', data: { comandaId, change } });
  }

  totals(comandaId: string) {
    const c = this.row(comandaId);
    const items = this.ctx.db.all<{ quantity: number; unit_price_cents: number; status: string }>(
      'SELECT quantity, unit_price_cents, status FROM comanda_items WHERE comanda_id = ?',
      comandaId,
    );
    const paid = Number(
      this.ctx.db.value("SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE comanda_id = ? AND status = 'active'", comandaId),
    );
    const t = billTotals(
      items.map((i) => ({ quantity: i.quantity, unitPrice: i.unit_price_cents, canceled: i.status !== 'active' })),
      { discount: Number(c.discount_cents), serviceFeeBp: Number(c.service_fee_bp), paid },
    );
    // Consumo de funcionário: mostra o valor consumido, mas não há o que cobrar.
    return c.kind === 'staff' ? { ...t, remaining: 0 } : t;
  }

  private summary(c: Row) {
    const t = this.totals(String(c.id));
    const ref = { number: Number(c.number), cardNumber: c.card_number === null || c.card_number === undefined ? null : Number(c.card_number), kind: String(c.kind ?? 'regular') };
    return {
      id: c.id,
      number: c.number,
      cardNumber: ref.cardNumber,
      kind: ref.kind,
      displayNumber: comandaDisplayNumber(ref),
      label: comandaLabel(ref),
      customerName: c.customer_name,
      customerPhoneMasked: maskPhone(c.customer_phone as string | null),
      customerCpfMasked: maskCpf(c.customer_cpf as string | null),
      table: c.table_label,
      status: c.status,
      responsibleUserId: c.responsible_user_id,
      staffUserId: (c.staff_user_id as string | null) ?? null,
      responsibleName: c.responsible_name ?? null,
      openedAt: c.opened_at,
      closedAt: c.closed_at,
      notes: c.notes,
      version: c.version,
      itemCount: Number(this.ctx.db.value("SELECT COALESCE(SUM(quantity),0) FROM comanda_items WHERE comanda_id = ? AND status = 'active'", String(c.id))),
      ...t,
    };
  }

  list(actor: Actor, filter: { status?: string; q?: string; from?: string; to?: string; limit?: number } = {}) {
    requirePerm(actor, 'comandas.view');
    const where: string[] = [];
    const params: (string | number)[] = [];
    const status = filter.status ?? 'open';
    if (status !== 'all') where.push('c.status = ?'), params.push(status);
    if (filter.q) {
      where.push('(c.customer_name LIKE ? OR c.table_label = ? OR CAST(c.number AS TEXT) = ? OR CAST(c.card_number AS TEXT) = ?)');
      params.push(`%${filter.q}%`, filter.q, filter.q, filter.q);
    }
    if (filter.from) where.push('c.opened_at >= ?'), params.push(filter.from);
    if (filter.to) where.push('c.opened_at < ?'), params.push(filter.to);
    params.push(Math.min(filter.limit ?? 300, 1000));
    return this.ctx.db
      .all(
        `SELECT c.*, u.name AS responsible_name FROM comandas c LEFT JOIN users u ON u.id = c.responsible_user_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.status = 'open' DESC, COALESCE(c.card_number, c.number) ASC, c.number DESC LIMIT ?`,
        ...params,
      )
      .map((c) => this.summary(c));
  }

  detail(actor: Actor, id: string) {
    requirePerm(actor, 'comandas.view');
    const c = this.ctx.db.get(
      'SELECT c.*, u.name AS responsible_name FROM comandas c LEFT JOIN users u ON u.id = c.responsible_user_id WHERE c.id = ?',
      id,
    );
    if (!c) throw notFound('Comanda');
    const items = this.ctx.db.all(
      `SELECT i.*, o.number AS order_number, u.name AS created_by_name,
              (SELECT GROUP_CONCAT(t.status) FROM order_tickets t WHERE t.order_id = i.order_id AND t.station = i.station) AS ticket_status
       FROM comanda_items i LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN users u ON u.id = i.created_by
       WHERE i.comanda_id = ? ORDER BY i.created_at`,
      id,
    );
    const payments = this.ctx.db.all(
      `SELECT p.id, p.method, p.amount_cents, p.received_cents, p.change_cents, p.payer_label, p.status, p.created_at,
              p.reverse_reason, u.name AS created_by_name
       FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.comanda_id = ? ORDER BY p.created_at`,
      id,
    );
    const hookahSessions = this.ctx.db.all(
      `SELECT s.id, s.status, s.started_at, s.ended_at, s.charge_cents, h.code, h.model FROM hookah_sessions s
       JOIN hookahs h ON h.id = s.hookah_id WHERE s.comanda_id = ? ORDER BY s.started_at`,
      id,
    );
    const showCost = hasPerm(actor, 'reports.financial');
    return {
      ...this.summary(c),
      discountReason: c.discount_reason,
      serviceFeeBp: c.service_fee_bp,
      openedBy: c.opened_by,
      items: items.map((i) => ({
        id: i.id, orderId: i.order_id, orderNumber: i.order_number, kind: i.kind, presentationId: i.presentation_id,
        productId: i.product_id, name: i.product_name, presentationName: i.presentation_name, options: (i.options_label as string | null) ?? null, quantity: i.quantity,
        unitPriceCents: i.unit_price_cents, totalCents: Number(i.quantity) * Number(i.unit_price_cents),
        unitCostCents: showCost ? i.unit_cost_cents : null, notes: i.notes, station: i.station, status: i.status,
        cancelReason: i.cancel_reason, createdAt: i.created_at, createdByName: i.created_by_name, ticketStatus: i.ticket_status,
      })),
      payments,
      hookahSessions,
      discountRequest: this.pendingDiscountRequest(id),
    };
  }

  open(actor: Actor, raw: unknown) {
    requirePerm(actor, 'comandas.open');
    const input = comandaOpenSchema.parse(raw);
    const op = this.settings.operation();
    if (op.requireCustomerPhone && !input.customerPhone) throw badRequest('Informe o telefone do cliente.', 'PHONE_REQUIRED');
    if (op.requireCustomerCpf && !input.customerCpf) throw badRequest('Informe o CPF do cliente.', 'CPF_REQUIRED');
    return this.ctx.tx(() => {
      if (input.clientRequestId) {
        const existing = this.ctx.db.get('SELECT * FROM comandas WHERE client_request_id = ?', input.clientRequestId);
        if (existing) return this.summary(existing);
      }
      if (input.table) {
        const busy = this.ctx.db.get("SELECT number FROM comandas WHERE status = 'open' AND table_label = ? COLLATE NOCASE", input.table);
        // Mesa com outra comanda aberta é permitido (grupos), mas avisamos a interface.
        if (busy) this.ctx.emit({ channel: 'comandas', type: 'table.shared', data: { table: input.table } });
      }
      if (input.cardNumber !== null) this.assertCardFree(input.cardNumber);
      // Consumo de funcionário: a comanda leva o nome de quem pegou.
      let staffName: string | null = null;
      if (input.staffUserId) {
        staffName = this.ctx.db.value<string>("SELECT name FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL", input.staffUserId) ?? null;
        if (!staffName) throw notFound('Funcionário');
      }
      const responsible = input.responsibleUserId ?? actor.userId;
      if (responsible && !this.ctx.db.get("SELECT id FROM users WHERE id = ? AND status = 'active'", responsible)) {
        throw notFound('Funcionário responsável');
      }
      const id = this.ctx.id();
      const number = this.ctx.nextSeq('comanda');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO comandas (id, number, card_number, kind, customer_name, customer_phone, customer_cpf, table_label, responsible_user_id, status,
           service_fee_bp, notes, opened_by, opened_at, client_request_id, updated_at, staff_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?)`,
        id, number, input.cardNumber, staffName ? 'staff' : 'regular', input.customerName || staffName || '', input.customerPhone, input.customerCpf,
        input.table, responsible, staffName ? 0 : op.serviceFeeBp, input.notes, actor.userId ?? 'system', now, input.clientRequestId ?? null, now,
        input.staffUserId ?? null,
      );
      this.ctx.audit(actor, 'comandas.opened', 'comanda', id, { number, card: input.cardNumber, table: input.table, ...(staffName ? { staff: staffName } : {}) });
      this.ctx.emit({ channel: 'comandas', type: 'comanda.opened', data: { comandaId: id, number } });
      return this.summary(this.row(id));
    });
  }

  /** Comanda interna da venda rápida (sem taxa de serviço; encerrada logo após o pagamento). */
  openQuick(actor: Actor, customerName: string, clientRequestId: string, notes: string | null): string {
    requirePerm(actor, 'comandas.open');
    const id = this.ctx.id();
    const number = this.ctx.nextSeq('comanda');
    const now = this.ctx.nowIso();
    this.ctx.db.run(
      `INSERT INTO comandas (id, number, kind, customer_name, responsible_user_id, status, service_fee_bp, notes, opened_by, opened_at, client_request_id, updated_at)
       VALUES (?,?,'quick',?,?,'open',0,?,?,?,?,?)`,
      id, number, customerName, actor.userId, notes, actor.userId ?? 'system', now, clientRequestId, now,
    );
    return id;
  }

  /** Um cartão físico só pode estar em uma comanda aberta por vez. */
  private assertCardFree(cardNumber: number, exceptId: string | null = null) {
    const busy = this.ctx.db.get(
      "SELECT id, customer_name FROM comandas WHERE status = 'open' AND card_number = ? AND id <> COALESCE(?, '')",
      cardNumber, exceptId,
    );
    if (busy) {
      const who = busy.customer_name ? ` (${String(busy.customer_name)})` : '';
      throw conflict(`O cartão ${cardNumber} já está em uma comanda aberta${who}.`, 'CARD_IN_USE', { comandaId: busy.id });
    }
  }

  /** Comanda aberta pelo número do cartão (ou, sem cartão, pelo número do sistema). */
  findOpenByNumber(actor: Actor, n: number) {
    requirePerm(actor, 'comandas.view');
    const c =
      this.ctx.db.get("SELECT * FROM comandas WHERE status = 'open' AND card_number = ?", n) ??
      this.ctx.db.get("SELECT * FROM comandas WHERE status = 'open' AND card_number IS NULL AND number = ? AND kind IN ('regular','staff')", n);
    return c ? this.summary(c) : null;
  }

  /** Corrige nome, cartão, mesa e observações de uma comanda aberta. */
  edit(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.edit');
    const input = comandaEditSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.row(id);
      if (c.status !== 'open' && !hasPerm(actor, 'admin.override')) this.requireOpen(c);
      this.checkVersion(c, input.expectedVersion);
      if (input.cardNumber !== null && c.status === 'open') this.assertCardFree(input.cardNumber, id);
      this.ctx.db.run(
        'UPDATE comandas SET customer_name = ?, card_number = ?, table_label = ?, notes = ? WHERE id = ?',
        input.customerName, input.cardNumber, input.table, input.notes, id,
      );
      this.touch(id, 'edited');
      this.ctx.emit({ channel: 'kitchen', type: 'order.changed', data: { comandaId: id } });
      this.ctx.emit({ channel: 'tv', type: 'board.changed' });
      this.ctx.audit(actor, 'comandas.edited', 'comanda', id, {
        from: { name: c.customer_name, card: c.card_number, table: c.table_label },
        to: { name: input.customerName, card: input.cardNumber, table: input.table },
      });
      return this.summary(this.row(id));
    });
  }

  /**
   * Envia um pedido (itens) para a comanda. Idempotente por `clientRequestId`:
   * toques repetidos ou reenvio após queda de conexão retornam o mesmo pedido.
   */
  createOrder(actor: Actor, raw: unknown, source: OrderSource = 'desktop') {
    requirePerm(actor, 'orders.create');
    const input = orderCreateSchema.parse(raw);
    return this.ctx.tx(() => {
      const existing = this.ctx.db.get('SELECT * FROM orders WHERE client_request_id = ?', input.clientRequestId);
      if (existing) return { ...this.orderView(String(existing.id)), duplicate: true };

      const c = this.row(input.comandaId);
      this.requireOpen(c);
      const now = this.ctx.clock.now();
      const nowIso = now.toISOString();
      const day = businessDay(now);
      const number = this.ctx.nextSeq(`order:${day}`);
      const orderId = this.ctx.id();
      this.ctx.db.run(
        `INSERT INTO orders (id, number, business_day, comanda_id, client_request_id, notes, source, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        orderId, number, day, input.comandaId, input.clientRequestId, input.notes, source, actor.userId ?? 'system', nowIso, nowIso,
      );
      const stations = new Set<Station>();
      for (const item of input.items) {
        const pr = this.ctx.db.get(
          `SELECT pr.*, p.name AS product_name, p.active AS product_active, p.category_id, COALESCE(p.station, c.station) AS station
           FROM presentations pr JOIN products p ON p.id = pr.product_id JOIN categories c ON c.id = p.category_id WHERE pr.id = ?`,
          item.presentationId,
        );
        if (!pr || pr.active !== 1 || pr.product_active !== 1) throw conflict('Um dos produtos não está mais disponível. Atualize o cardápio.', 'PRODUCT_UNAVAILABLE');
        const itemId = this.ctx.id();
        const station = String(pr.station) as Station;
        const halves = this.resolveHalves(String(pr.id), String(pr.product_name), item.halves);
        // Meio a meio na hora (duas porções quaisquer): só as metades, sem as escolhas da porção.
        const chosen = [...halves.entries, ...(halves.free ? [] : this.resolveOptions(String(pr.product_id), String(pr.id), String(pr.product_name), item.options))];
        // Meio a meio cobra a metade mais cara (ou o preço do item, se for maior).
        const unitPrice = Math.max(Number(pr.price_cents), halves.priceCents) + chosen.reduce((a, o) => a + o.priceDeltaCents, 0);
        this.ctx.db.run(
          `INSERT INTO comanda_items (id, comanda_id, order_id, kind, presentation_id, product_id, product_name, presentation_name, category_id,
             quantity, unit_price_cents, notes, station, options_label, options_json, created_by, created_at, updated_at)
           VALUES (?,?,?,'product',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          itemId, input.comandaId, orderId, item.presentationId, pr.product_id as string,
          halves.free ? 'Meio a meio' : (pr.product_name as string), halves.free ? 'Unidade' : (pr.name as string),
          pr.category_id as string, item.quantity, unitPrice, item.notes, station,
          chosen.length || halves.labels.length ? [...halves.labels, ...chosen.filter((o) => !o.half).map((o) => o.choice)].join(' · ') : null,
          chosen.length ? JSON.stringify(chosen) : null,
          actor.userId ?? 'system', nowIso, nowIso,
        );
        const extra = chosen.filter((o) => o.productId && o.qty > 0).map((o) => ({ productId: o.productId!, qty: o.qty }));
        // No meio a meio na hora a porção base não baixa inteira: só as duas metades.
        const cost = this.stock.deductForSale(itemId, item.presentationId, item.quantity, actor.userId, extra, halves.free);
        this.ctx.db.run('UPDATE comanda_items SET unit_cost_cents = ? WHERE id = ?', Math.round(cost / item.quantity), itemId);
        if (station !== 'none') stations.add(station);
      }
      for (const station of stations) {
        this.ctx.db.run(
          'INSERT INTO order_tickets (id, order_id, station, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          this.ctx.id(), orderId, station, 'received', nowIso, nowIso,
        );
      }
      this.touch(input.comandaId, 'order');
      this.ctx.audit(actor, 'orders.created', 'order', orderId, { number, comanda: c.number, items: input.items.length, source });
      this.ctx.emit({ channel: 'kitchen', type: 'order.created', data: { orderId, number, stations: [...stations] } });
      this.ctx.emit({ channel: 'tv', type: 'board.changed' });
      this.onOrderCreated(orderId);
      return { ...this.orderView(orderId), duplicate: false };
    });
  }

  /**
   * Meio a meio: cobra a metade mais cara e baixa metade da ficha de cada uma
   * (meia batata, meia polenta). Na hora do pedido vale para quaisquer duas
   * porções de comida (cozinha); um item "meio a meio" cadastrado só aceita as
   * porções ligadas a ele.
   */
  private resolveHalves(presentationId: string, productName: string, picked: string[]) {
    const none = { entries: [] as ReturnType<ComandasService['resolveOptions']>, labels: [] as string[], priceCents: 0, free: false };
    const configured = this.ctx.db.all<{ part_presentation_id: string }>('SELECT part_presentation_id FROM presentation_halves WHERE presentation_id = ?', presentationId)
      .map((h) => h.part_presentation_id);
    if (!picked.length) {
      if (configured.length) throw badRequest(`Escolha as duas metades de ${productName}.`, 'HALVES_REQUIRED');
      return none;
    }
    if (picked.length !== 2) throw badRequest(`Escolha as duas metades de ${productName}.`, 'HALVES_REQUIRED');
    const free = !configured.length;
    if (free && !picked.includes(presentationId)) throw badRequest('O item do meio a meio tem de ser uma das metades.', 'HALVES_INVALID');
    const parts = picked.map((id) => this.ctx.db.get<{ id: string; name: string; price_cents: number; product_name: string; station: string }>(
      `SELECT pr.id, pr.name, pr.price_cents, p.name AS product_name, COALESCE(p.station, c.station) AS station
       FROM presentations pr JOIN products p ON p.id = pr.product_id JOIN categories c ON c.id = p.category_id
       WHERE pr.id = ? AND pr.active = 1 AND p.active = 1`,
      id,
    ));
    if (parts.some((p, i) => !p || (!free && !configured.includes(picked[i]!)))) {
      throw conflict(`Uma das metades de ${productName} não está mais disponível. Atualize o cardápio.`, 'OPTION_UNAVAILABLE');
    }
    if (free && parts.some((p) => p!.station !== 'kitchen')) throw badRequest('Meio a meio só para comida (porções da cozinha).', 'HALVES_NOT_FOOD');
    const label = (p: NonNullable<(typeof parts)[number]>) => `½ ${presentationSuffix(p.product_name, p.name) ? `${p.product_name} ${p.name}` : p.product_name}`;
    const entries = parts.flatMap((p) => this.ctx.db
      .all<{ ingredient_product_id: string; qty: number }>('SELECT ingredient_product_id, qty FROM presentation_components WHERE presentation_id = ?', p!.id)
      .map((c) => ({
        groupId: presentationId, group: 'Meio a meio', choiceId: p!.id, choice: label(p!), quantity: 1, priceDeltaCents: 0,
        productId: c.ingredient_product_id, qty: Math.max(1, Math.round(Number(c.qty) / 2)), half: true, ...(free ? { free: true } : {}),
      })));
    return { entries, labels: parts.map((p) => label(p!)), priceCents: Math.max(...parts.map((p) => Number(p!.price_cents))), free };
  }

  /**
   * Confere as escolhas de um item (sabor, energético, gelo): uma opção por
   * escolha, todas as obrigatórias respondidas. Devolve o que foi escolhido com
   * o acréscimo e o produto que sai do estoque.
   */
  private resolveOptions(productId: string, presentationId: string, productName: string, selected: { groupId: string; choiceId: string }[]) {
    // As do produto e, depois, as só desta apresentação (a mesma escolha conta uma vez).
    const groups = this.ctx.db.all<{ id: string; name: string; required: number; quantity: number }>(
      `SELECT g.id, g.name, g.required, l.quantity FROM (
         SELECT group_id, quantity, sort_order, 0 AS level FROM product_option_groups WHERE product_id = ?
         UNION ALL
         SELECT group_id, quantity, sort_order, 1 FROM presentation_option_groups WHERE presentation_id = ?
       ) l JOIN option_groups g ON g.id = l.group_id
       WHERE g.active = 1 AND EXISTS (SELECT 1 FROM option_choices oc WHERE oc.group_id = g.id AND oc.active = 1)
       ORDER BY l.level, l.sort_order`,
      productId, presentationId,
    ).filter((g, i, all) => all.findIndex((x) => x.id === g.id) === i);
    if (selected.some((s) => !groups.some((g) => g.id === s.groupId))) {
      throw conflict(`As escolhas de ${productName} mudaram. Atualize o cardápio e escolha de novo.`, 'OPTION_UNAVAILABLE');
    }
    // Nos combos a escolha vale várias unidades: preço e baixa multiplicados (4× Red Bull = 4 latas).
    const chosen: { groupId: string; group: string; choiceId: string; choice: string; quantity: number; priceDeltaCents: number; productId: string | null; qty: number; half?: boolean; free?: boolean }[] = [];
    for (const g of groups) {
      const picks = selected.filter((s) => s.groupId === g.id);
      if (picks.length > 1) throw badRequest(`Escolha só uma opção em "${g.name}" (${productName}).`, 'OPTION_MULTIPLE');
      if (!picks.length) {
        if (g.required) throw badRequest(`Escolha ${g.name.toLocaleLowerCase('pt-BR')} para ${productName}.`, 'OPTION_REQUIRED', { groupId: g.id });
        continue;
      }
      const c = this.ctx.db.get('SELECT * FROM option_choices WHERE id = ? AND group_id = ? AND active = 1', picks[0]!.choiceId, g.id);
      if (!c) throw conflict(`Uma opção de ${productName} não está mais disponível. Atualize o cardápio.`, 'OPTION_UNAVAILABLE');
      const n = Math.max(1, Number(g.quantity) || 1);
      chosen.push({
        groupId: g.id, group: g.name, choiceId: String(c.id), choice: n > 1 ? `${n}× ${c.name}` : String(c.name), quantity: n,
        priceDeltaCents: Number(c.price_delta_cents) * n, productId: (c.ingredient_product_id as string | null) ?? null, qty: Number(c.qty) * n,
      });
    }
    return chosen;
  }

  orderView(orderId: string) {
    const o = this.ctx.db.get(
      'SELECT o.*, c.number AS comanda_number, c.card_number, c.kind AS comanda_kind, c.table_label, c.customer_name FROM orders o JOIN comandas c ON c.id = o.comanda_id WHERE o.id = ?',
      orderId,
    );
    if (!o) throw notFound('Pedido');
    return {
      id: o.id,
      number: o.number,
      comandaId: o.comanda_id,
      comandaNumber: o.comanda_number,
      comandaDisplayNumber: comandaDisplayNumber({ number: Number(o.comanda_number), cardNumber: o.card_number as number | null, kind: String(o.comanda_kind) }),
      table: o.table_label,
      customerFirstName: firstName(o.customer_name as string),
      customerDisplayName: displayName(o.customer_name as string),
      createdAt: o.created_at,
      tickets: this.ctx.db.all('SELECT id, station, status, ready_at, delivered_at FROM order_tickets WHERE order_id = ?', orderId),
      items: this.ctx.db.all(
        'SELECT id, product_name, presentation_name, options_label, quantity, unit_price_cents, notes, station, status FROM comanda_items WHERE order_id = ?',
        orderId,
      ),
    };
  }

  /** Mais vendidos dos últimos 30 dias (atalhos no cardápio do PC e do garçom). */
  popular(limit = 12): string[] {
    const since = new Date(this.ctx.clock.now().getTime() - 30 * 86_400_000).toISOString();
    return this.ctx.db
      .all<{ presentation_id: string }>(
        `SELECT presentation_id FROM comanda_items WHERE status = 'active' AND kind = 'product' AND presentation_id IS NOT NULL AND created_at >= ?
         GROUP BY presentation_id ORDER BY SUM(quantity) DESC LIMIT ?`,
        since, limit,
      )
      .map((r) => r.presentation_id);
  }

  /**
   * Conferência de pedido (o cliente perdeu o ticket, ou o bar quer confirmar):
   * busca pelo código do ticket (bipado ou digitado), número do pedido, número
   * do cartão ou nome, nos últimos 2 dias. Diz se está pago e se já foi entregue.
   */
  lookupOrders(actor: Actor, raw: string | undefined) {
    requirePerm(actor, 'orders.view');
    const q = (raw ?? '').trim().slice(0, 60);
    if (!q) return [];
    const code = parsePickupCode(q);
    const base = 'SELECT o.id FROM orders o JOIN comandas c ON c.id = o.comanda_id';
    const since = new Date(this.ctx.clock.now().getTime() - 2 * 86_400_000).toISOString();
    let ids: { id: string }[];
    if (code) {
      ids = this.ctx.db.all(`${base} WHERE o.business_day = ? AND o.number = ?`, code.businessDay, code.orderNumber);
    } else if (/^\d{1,6}$/.test(q)) {
      ids = this.ctx.db.all(
        `${base} WHERE o.created_at >= ? AND (o.number = ? OR c.card_number = ?) ORDER BY o.created_at DESC LIMIT 20`,
        since, Number(q), Number(q),
      );
    } else {
      ids = this.ctx.db.all(
        `${base} WHERE o.created_at >= ? AND c.customer_name LIKE ? ESCAPE '\\' ORDER BY o.created_at DESC LIMIT 20`,
        since, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`,
      );
    }
    return ids.map((r) => this.orderCheck(r.id));
  }

  /** Pedido com a situação do pagamento e da entrega (conferência). */
  orderCheck(orderId: string) {
    const v = this.orderView(orderId);
    const o = this.ctx.db.get(
      `SELECT o.business_day, o.picked_up_at, u.name AS picked_up_name, c.kind, c.status AS comanda_status
       FROM orders o JOIN comandas c ON c.id = o.comanda_id LEFT JOIN users u ON u.id = o.picked_up_by WHERE o.id = ?`,
      orderId,
    )!;
    const t = this.totals(String(v.comandaId));
    const active = v.items.filter((i) => i.status === 'active');
    const tickets = v.tickets.filter((x) => x.status !== 'canceled');
    const deliveredByKitchen = tickets.length > 0 && tickets.every((x) => x.status === 'delivered')
      ? tickets.map((x) => String(x.delivered_at ?? '')).sort().at(-1) || null
      : null;
    return {
      ...v,
      code: pickupCode(String(o.business_day), Number(v.number)),
      quick: o.kind === 'quick',
      comandaStatus: o.comanda_status as string,
      /** paid: comanda quitada (venda rápida sempre); open: comanda aberta, paga na saída; canceled. */
      payment: o.comanda_status === 'canceled' ? 'canceled' : t.total > 0 && t.remaining <= 0 ? 'paid' : 'open',
      orderTotal: active.reduce((a, i) => a + Number(i.quantity) * Number(i.unit_price_cents), 0),
      comandaTotal: t.total,
      paidCents: t.paid,
      remaining: t.remaining,
      payments: this.ctx.db.all(
        "SELECT method, amount_cents, created_at FROM payments WHERE comanda_id = ? AND status = 'active' ORDER BY created_at",
        String(v.comandaId),
      ),
      pickedUpAt: (o.picked_up_at as string | null) ?? deliveredByKitchen,
      pickedUpBy: (o.picked_up_name as string | null) ?? null,
      ticketPrints: Number(this.ctx.db.value("SELECT COUNT(*) FROM print_jobs WHERE kind = 'pickup_ticket' AND ref_id = ? AND status <> 'canceled'", orderId)),
    };
  }

  /** O bar entregou o pedido: registra quem e quando (e tira da tela de produção). */
  markPickedUp(actor: Actor, orderId: string) {
    if (!hasPerm(actor, 'orders.create') && !hasPerm(actor, 'kitchen.update')) throw forbidden();
    return this.ctx.tx(() => {
      const o = this.ctx.db.get('SELECT id, number, picked_up_at FROM orders WHERE id = ?', orderId);
      if (!o) throw notFound('Pedido');
      if (o.picked_up_at) throw conflict('Este pedido já foi entregue.', 'ALREADY_PICKED_UP', { pickedUpAt: o.picked_up_at });
      const now = this.ctx.nowIso();
      this.ctx.db.run('UPDATE orders SET picked_up_at = ?, picked_up_by = ?, updated_at = ? WHERE id = ?', now, actor.userId, now, orderId);
      const changed = this.ctx.db.run(
        `UPDATE order_tickets SET status = 'delivered', delivered_at = ?, updated_by = ?, version = version + 1, updated_at = ?
         WHERE order_id = ? AND status NOT IN ('delivered','canceled')`,
        now, actor.userId, now, orderId,
      ).changes;
      if (changed) this.ctx.emit({ channel: 'kitchen', type: 'order.status', data: { orderId, status: 'delivered' } });
      this.ctx.audit(actor, 'orders.picked_up', 'order', orderId, { number: o.number });
      return this.orderCheck(orderId);
    });
  }

  /** Pedidos recentes feitos pelo próprio usuário (acompanhamento no celular). */
  myOrders(actor: Actor, limit = 30) {
    requirePerm(actor, 'orders.view');
    const ids = this.ctx.db.all<{ id: string }>(
      'SELECT id FROM orders WHERE created_by = ? ORDER BY created_at DESC LIMIT ?',
      actor.userId ?? '', limit,
    );
    return ids.map((r) => this.orderView(r.id));
  }

  cancelItem(actor: Actor, itemId: string, raw: unknown) {
    requirePerm(actor, 'comandas.cancel_item');
    const input = cancelItemSchema.parse(raw);
    return this.ctx.tx(() => {
      const item = this.ctx.db.get('SELECT * FROM comanda_items WHERE id = ?', itemId);
      if (!item) throw notFound('Item');
      if (item.status !== 'active') throw conflict('Item já cancelado.', 'ALREADY_CANCELED');
      const c = this.row(String(item.comanda_id));
      this.requireOpen(c);
      const t = this.totals(String(c.id));
      const itemTotal = Number(item.quantity) * Number(item.unit_price_cents);
      if (t.total - itemTotal < t.paid) {
        throw conflict('O valor já pago ficaria maior que o total. Estorne um pagamento antes de cancelar o item.', 'PAID_EXCEEDS_TOTAL');
      }
      this.cancelItemRow(actor, item, input.reason, input.returnToStock);
      this.touch(String(c.id), 'item_canceled');
      this.ctx.audit(actor, 'comandas.item_canceled', 'comanda_item', itemId, {
        comanda: c.number, product: item.product_name, quantity: item.quantity, reason: input.reason, returnToStock: input.returnToStock,
      });
      return this.detail(actor, String(c.id));
    });
  }

  /** Cancela o item (e o ticket do setor, se ficou vazio); devolve ao estoque se pedido. */
  private cancelItemRow(actor: Actor, item: Row, reason: string, returnToStock: boolean) {
    const now = this.ctx.nowIso();
    const itemId = String(item.id);
    this.ctx.db.run(
      `UPDATE comanda_items SET status = 'canceled', cancel_reason = ?, canceled_by = ?, canceled_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      reason, actor.userId, now, now, itemId,
    );
    if (returnToStock && item.kind === 'product') this.stock.reverseSale(itemId, actor.userId, reason);
    if (item.order_id) {
      // Se todos os itens do setor foram cancelados, o ticket de produção é cancelado.
      const remaining = Number(
        this.ctx.db.value(
          "SELECT COUNT(*) FROM comanda_items WHERE order_id = ? AND station = ? AND status = 'active'",
          String(item.order_id), String(item.station),
        ),
      );
      if (remaining === 0) {
        this.ctx.db.run(
          "UPDATE order_tickets SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ? WHERE order_id = ? AND station = ? AND status <> 'canceled'",
          now, now, String(item.order_id), String(item.station),
        );
      }
      this.ctx.emit({ channel: 'kitchen', type: 'order.changed', data: { orderId: item.order_id } });
      this.ctx.emit({ channel: 'tv', type: 'board.changed' });
    }
  }

  /**
   * Troca um item lançado (acabou a água: vai a com gás; outro energético na
   * dose): o item sai e volta ao estoque, e o que entra no lugar vai num
   * pedido novo, que segue para a produção e a impressora como qualquer
   * pedido. Idempotente por `clientRequestId`. Quem não pode cancelar itens
   * só troca o que ainda não ficou pronto, até 30 minutos depois de lançado.
   */
  swapItem(actor: Actor, itemId: string, raw: unknown, source: OrderSource = 'desktop') {
    requirePerm(actor, 'orders.create');
    const input = swapItemSchema.parse(raw);
    return this.ctx.tx(() => {
      const existing = this.ctx.db.get('SELECT id FROM orders WHERE client_request_id = ?', input.clientRequestId);
      if (existing) return { ...this.orderView(String(existing.id)), duplicate: true };
      const item = this.ctx.db.get('SELECT * FROM comanda_items WHERE id = ?', itemId);
      if (!item) throw notFound('Item');
      if (item.status !== 'active') throw conflict('Este item já foi cancelado ou trocado.', 'ALREADY_CANCELED');
      if (item.kind !== 'product') throw badRequest('Narguilé não se troca por aqui: use a tela do narguilé.');
      const c = this.row(String(item.comanda_id));
      this.requireOpen(c);
      if (!hasPerm(actor, 'comandas.cancel_item')) {
        const ticket = item.order_id
          ? this.ctx.db.value<string>('SELECT status FROM order_tickets WHERE order_id = ? AND station = ? ORDER BY created_at DESC LIMIT 1', String(item.order_id), String(item.station))
          : null;
        const age = this.ctx.clock.now().getTime() - Date.parse(String(item.created_at));
        if ((ticket && ['ready', 'delivered'].includes(ticket)) || age > 30 * 60_000) {
          throw forbidden('Este item já saiu da produção. Peça ao gerente para trocar.', 'SWAP_NOT_ALLOWED');
        }
      }
      const was = `${item.quantity}× ${String(item.product_name)}${item.options_label ? ` (${String(item.options_label)})` : ''}`;
      this.cancelItemRow(actor, item, `Trocado${input.reason ? `: ${input.reason}` : ''}`, input.returnToStock);
      const order = this.createOrder(actor, { comandaId: c.id, clientRequestId: input.clientRequestId, items: input.items, notes: `Troca de ${was}`.slice(0, 200) }, source);
      if (this.totals(String(c.id)).remaining < 0) {
        throw conflict('O valor já pago ficaria maior que o total. Estorne um pagamento antes de trocar.', 'PAID_EXCEEDS_TOTAL');
      }
      this.ctx.audit(actor, 'comandas.item_swapped', 'comanda_item', itemId, {
        comanda: c.number, from: was, toOrder: order.number, reason: input.reason, returnToStock: input.returnToStock,
      });
      return { ...order, swappedItemId: itemId };
    });
  }

  transfer(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.transfer');
    const input = transferSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.row(id);
      this.requireOpen(c);
      this.checkVersion(c, input.expectedVersion);
      this.ctx.db.run('UPDATE comandas SET table_label = ? WHERE id = ?', input.table, id);
      this.touch(id, 'transfer');
      this.ctx.audit(actor, 'comandas.table_transferred', 'comanda', id, { from: c.table_label, to: input.table });
      return this.summary(this.row(id));
    });
  }

  moveItems(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.transfer');
    const input = moveItemsSchema.parse(raw);
    return this.ctx.tx(() => {
      const from = this.row(id);
      const to = this.row(input.targetComandaId);
      this.requireOpen(from);
      this.requireOpen(to);
      this.checkVersion(from, input.expectedVersion);
      if (from.id === to.id) throw badRequest('Escolha outra comanda de destino.');
      for (const itemId of input.itemIds) {
        const r = this.ctx.db.run(
          "UPDATE comanda_items SET comanda_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND comanda_id = ? AND status = 'active'",
          String(to.id), this.ctx.nowIso(), itemId, id,
        );
        if (!r.changes) throw conflict('Um dos itens não pode ser movido.', 'ITEM_NOT_MOVABLE');
      }
      const t = this.totals(id);
      if (t.remaining < 0) throw conflict('A comanda de origem ficaria com pagamento maior que o total. Estorne um pagamento antes.', 'PAID_EXCEEDS_TOTAL');
      this.touch(id, 'items_moved');
      this.touch(String(to.id), 'items_received');
      this.ctx.audit(actor, 'comandas.items_moved', 'comanda', id, { to: to.number, items: input.itemIds.length });
      return { from: this.summary(this.row(id)), to: this.summary(this.row(String(to.id))) };
    });
  }

  setDiscount(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.discount');
    const input = discountSchema.parse(raw);
    return this.ctx.tx(() => {
      this.checkVersion(this.row(id), input.expectedVersion);
      return this.applyDiscount(actor, id, input.discountCents, input.reason);
    });
  }

  /**
   * Desconto: só o proprietário dá (no PC ou pelo painel online). Quem tinha
   * pedido desconto nesta comanda tem o pedido encerrado (o dono já decidiu).
   */
  applyDiscount(actor: Actor, id: string, discountCents: number, reason: string, fromRequest?: Row) {
    requirePerm(actor, 'comandas.discount');
    const c = this.row(id);
    this.requireOpen(c);
    if (c.kind === 'staff' && discountCents > 0) throw conflict('Consumo de funcionário não é cobrado; não tem desconto.', 'STAFF_NO_DISCOUNT');
    this.ctx.db.run('UPDATE comandas SET discount_cents = ?, discount_reason = ? WHERE id = ?', discountCents, discountCents ? reason : null, id);
    const t = this.totals(id);
    if (t.remaining < 0) throw conflict('O desconto deixaria o valor pago maior que o total.', 'PAID_EXCEEDS_TOTAL');
    const now = this.ctx.nowIso();
    this.ctx.db.run(
      `UPDATE discount_requests SET status = 'canceled', decision_note = 'O proprietário deu o desconto direto', decided_at = ?, seen_at = ?,
         version = version + 1, updated_at = ? WHERE comanda_id = ? AND status = 'pending' AND id <> ?`,
      now, now, now, id, fromRequest ? String(fromRequest.id) : '',
    );
    this.touch(id, 'discount');
    this.ctx.audit(actor, 'comandas.discount', 'comanda', id, {
      from: c.discount_cents, to: discountCents, reason, ...(fromRequest ? { requestedBy: fromRequest.requested_by_name } : {}),
    });
    return this.summary(this.row(id));
  }

  setServiceFee(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.service_fee');
    const input = serviceFeeSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.row(id);
      this.requireOpen(c);
      this.checkVersion(c, input.expectedVersion);
      this.ctx.db.run('UPDATE comandas SET service_fee_bp = ? WHERE id = ?', input.serviceFeeBp, id);
      if (this.totals(id).remaining < 0) throw conflict('O valor pago ficaria maior que o total.', 'PAID_EXCEEDS_TOTAL');
      this.touch(id, 'service_fee');
      this.ctx.audit(actor, 'comandas.service_fee', 'comanda', id, { from: c.service_fee_bp, to: input.serviceFeeBp });
      return this.summary(this.row(id));
    });
  }

  /** Total da comanda com um desconto (sem gravar), para o pedido mostrar "fica R$ X". */
  private totalsWith(c: Row, discountCents: number) {
    const id = String(c.id);
    const items = this.ctx.db.all<{ quantity: number; unit_price_cents: number; status: string }>(
      'SELECT quantity, unit_price_cents, status FROM comanda_items WHERE comanda_id = ?', id,
    );
    const paid = Number(this.ctx.db.value("SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE comanda_id = ? AND status = 'active'", id));
    const lines = items.map((i) => ({ quantity: i.quantity, unitPrice: i.unit_price_cents, canceled: i.status !== 'active' }));
    return {
      before: billTotals(lines, { discount: Number(c.discount_cents), serviceFeeBp: Number(c.service_fee_bp), paid }),
      after: billTotals(lines, { discount: discountCents, serviceFeeBp: Number(c.service_fee_bp), paid }),
    };
  }

  private discountRequestView(r: Row) {
    return {
      id: r.id, comandaId: r.comanda_id, requestedBy: r.requested_by, requestedByName: r.requested_by_name,
      discountCents: Number(r.discount_cents), reason: r.reason, subtotalCents: Number(r.subtotal_cents), totalCents: Number(r.total_cents),
      totalAfterCents: Number(r.total_after_cents), status: r.status, decidedByName: r.decided_by_name ?? null, decidedAt: r.decided_at ?? null,
      decisionNote: r.decision_note ?? null, createdAt: r.created_at,
    };
  }

  /** Pedido de desconto aguardando o proprietário (aparece na comanda). */
  pendingDiscountRequest(comandaId: string) {
    const r = this.ctx.db.get("SELECT * FROM discount_requests WHERE comanda_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", comandaId);
    return r ? this.discountRequestView(r) : null;
  }

  /**
   * Qualquer funcionário pede desconto; o pedido vai ao painel online do
   * proprietário. Um pedido novo na mesma comanda substitui o anterior.
   */
  requestDiscount(actor: Actor, comandaId: string, raw: unknown) {
    requirePerm(actor, 'comandas.view');
    const input = discountRequestSchema.parse(raw);
    return this.ctx.tx(() => {
      const dup = this.ctx.db.get('SELECT * FROM discount_requests WHERE client_request_id = ?', input.clientRequestId);
      if (dup) return { ...this.discountRequestView(dup), duplicate: true };
      const c = this.row(comandaId);
      this.requireOpen(c);
      if (c.kind !== 'regular') throw conflict('Desconto só em comanda de cliente.', 'DISCOUNT_NOT_ALLOWED');
      const t = this.totalsWith(c, input.discountCents);
      if (input.discountCents > t.before.subtotal) throw badRequest('O desconto é maior que o valor dos itens.');
      if (t.after.remaining < 0) throw conflict('O desconto deixaria o valor pago maior que o total.', 'PAID_EXCEEDS_TOTAL');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `UPDATE discount_requests SET status = 'canceled', decision_note = 'Substituído por um pedido novo', decided_at = ?, seen_at = ?,
           version = version + 1, updated_at = ? WHERE comanda_id = ? AND status = 'pending'`,
        now, now, now, comandaId,
      );
      const id = this.ctx.id();
      this.ctx.db.run(
        `INSERT INTO discount_requests (id, comanda_id, requested_by, requested_by_name, discount_cents, reason, subtotal_cents, total_cents,
           total_after_cents, client_request_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, comandaId, actor.userId, actor.name, input.discountCents, input.reason, t.before.subtotal, t.before.total, t.after.total,
        input.clientRequestId, now, now,
      );
      this.ctx.audit(actor, 'comandas.discount_requested', 'comanda', comandaId, { discountCents: input.discountCents, reason: input.reason });
      this.ctx.emit({ channel: 'comandas', type: 'comanda.changed', data: { comandaId, change: 'discount_request' } });
      return { ...this.discountRequestView(this.ctx.db.get('SELECT * FROM discount_requests WHERE id = ?', id)!), duplicate: false };
    });
  }

  /** Quem pediu (ou o proprietário) desiste do pedido. */
  cancelDiscountRequest(actor: Actor, requestId: string) {
    requirePerm(actor, 'comandas.view');
    return this.ctx.tx(() => {
      const r = this.ctx.db.get('SELECT * FROM discount_requests WHERE id = ?', requestId);
      if (!r) throw notFound('Pedido de desconto');
      if (r.requested_by !== actor.userId && !hasPerm(actor, 'comandas.discount')) throw forbidden('Só quem pediu pode cancelar o pedido.');
      if (r.status !== 'pending') throw conflict('Este pedido já foi respondido.', 'DISCOUNT_REQUEST_DONE');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `UPDATE discount_requests SET status = 'canceled', decision_note = 'Cancelado por quem pediu', decided_at = ?, seen_at = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
        now, now, now, requestId,
      );
      this.ctx.emit({ channel: 'comandas', type: 'comanda.changed', data: { comandaId: r.comanda_id, change: 'discount_request' } });
      return { ok: true };
    });
  }

  /**
   * O proprietário aceita ou recusa (pelo painel online ou no PC). Não lança
   * erro quando o pedido não vale mais: responde o motivo, para o painel mostrar.
   */
  decideDiscount(actor: Actor, requestId: string, approve: boolean, note: string | null): { applied: boolean; message: string } {
    requirePerm(actor, 'comandas.discount');
    const r = this.ctx.db.get('SELECT * FROM discount_requests WHERE id = ?', requestId);
    if (!r) throw notFound('Pedido de desconto');
    if (r.status !== 'pending') {
      const why = r.status === 'approved' ? 'já foi aceito' : r.status === 'rejected' ? 'já foi recusado' : `foi cancelado (${r.decision_note ?? 'sem motivo'})`;
      return { applied: false, message: `Este pedido de desconto ${why}.` };
    }
    const c = this.row(String(r.comanda_id));
    const label = comandaLabel({ number: Number(c.number), cardNumber: c.card_number === null ? null : Number(c.card_number), kind: String(c.kind) });
    const now = this.ctx.nowIso();
    const finish = (status: 'approved' | 'rejected' | 'canceled', decisionNote: string | null) => {
      this.ctx.db.run(
        `UPDATE discount_requests SET status = ?, decided_by_name = ?, decided_at = ?, decision_note = ?, seen_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        status, actor.name, now, decisionNote, status === 'canceled' ? now : null, now, requestId,
      );
      this.ctx.emit({ channel: 'comandas', type: 'discount.decided', data: { requestId, requestedBy: r.requested_by, comandaId: r.comanda_id, status } });
      this.ctx.emit({ channel: 'comandas', type: 'comanda.changed', data: { comandaId: r.comanda_id, change: 'discount_request' } });
    };
    if (!approve) {
      finish('rejected', note);
      this.ctx.audit(actor, 'comandas.discount_rejected', 'comanda', String(r.comanda_id), { discountCents: r.discount_cents, requestedBy: r.requested_by_name, note });
      return { applied: true, message: `Desconto de ${formatBRL(Number(r.discount_cents))} recusado (${label}). ${r.requested_by_name} recebe o aviso.` };
    }
    if (c.status !== 'open') {
      finish('canceled', 'Comanda encerrada antes da resposta');
      return { applied: false, message: `${label} já foi encerrada; o desconto não foi aplicado.` };
    }
    const after = this.totalsWith(c, Number(r.discount_cents)).after;
    if (after.remaining < 0) {
      finish('canceled', 'O valor já pago ficaria maior que o total');
      return { applied: false, message: `Não deu para aplicar: o valor já pago na ${label} ficaria maior que o total.` };
    }
    this.applyDiscount(actor, String(r.comanda_id), Number(r.discount_cents), String(r.reason), r);
    finish('approved', note);
    return {
      applied: true,
      message: `Desconto de ${formatBRL(Number(r.discount_cents))} aplicado na ${label} (fica ${formatBRL(after.total)}). ${r.requested_by_name} recebe o aviso.`,
    };
  }

  /** Respostas do proprietário que o funcionário ainda não viu (mensagem na tela). */
  discountNotices(actor: Actor) {
    const rows = this.ctx.db.all(
      `SELECT r.*, c.number, c.card_number, c.kind FROM discount_requests r JOIN comandas c ON c.id = r.comanda_id
       WHERE r.requested_by = ? AND r.status IN ('approved','rejected') AND r.seen_at IS NULL ORDER BY r.decided_at`,
      actor.userId,
    );
    return rows.map((r) => ({
      ...this.discountRequestView(r),
      comandaLabel: comandaLabel({ number: Number(r.number), cardNumber: r.card_number === null ? null : Number(r.card_number), kind: String(r.kind) }),
    }));
  }

  markDiscountNoticeSeen(actor: Actor, requestId: string) {
    this.ctx.db.run('UPDATE discount_requests SET seen_at = ? WHERE id = ? AND requested_by = ? AND seen_at IS NULL', this.ctx.nowIso(), requestId, actor.userId);
    return { ok: true };
  }

  /** Divisão igualitária do saldo restante (sugestão; cada parte vira um pagamento). */
  split(actor: Actor, id: string, parts: number) {
    requirePerm(actor, 'comandas.view');
    const t = this.totals(id);
    if (!Number.isInteger(parts) || parts < 1 || parts > 50) throw badRequest('Número de pessoas inválido.');
    return { remaining: t.remaining, shares: splitEqually(Math.max(0, t.remaining), parts) };
  }

  close(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.close');
    const input = closeComandaSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.row(id);
      this.requireOpen(c);
      this.checkVersion(c, input.expectedVersion);
      this.endHookahs(actor, id, 'closed');
      const t = this.totals(id);
      if (t.remaining > 0) throw conflict(`Ainda faltam ${(t.remaining / 100).toFixed(2).replace('.', ',')} para encerrar.`, 'BALANCE_DUE', t);
      const now = this.ctx.nowIso();
      this.ctx.db.run("UPDATE comandas SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?", actor.userId, now, id);
      this.touch(id, 'closed');
      this.ctx.audit(actor, 'comandas.closed', 'comanda', id, { number: c.number, total: t.total, ...(c.kind === 'staff' ? { staff: true } : {}) });
      return this.summary(this.row(id));
    });
  }

  cancel(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'comandas.cancel');
    const input = cancelComandaSchema.parse(raw);
    return this.ctx.tx(() => {
      const c = this.row(id);
      this.requireOpen(c);
      this.checkVersion(c, input.expectedVersion);
      if (this.totals(id).paid > 0) throw conflict('Estorne os pagamentos antes de cancelar a comanda.', 'HAS_PAYMENTS');
      this.endHookahs(actor, id, 'canceled');
      const now = this.ctx.nowIso();
      const items = this.ctx.db.all<{ id: string; kind: string; order_id: string | null }>(
        "SELECT id, kind, order_id FROM comanda_items WHERE comanda_id = ? AND status = 'active'",
        id,
      );
      for (const item of items) {
        this.ctx.db.run(
          "UPDATE comanda_items SET status = 'canceled', cancel_reason = ?, canceled_by = ?, canceled_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
          input.reason, actor.userId, now, now, item.id,
        );
        if (input.returnToStock && item.kind === 'product') this.stock.reverseSale(item.id, actor.userId, input.reason);
      }
      this.ctx.db.run(
        `UPDATE order_tickets SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
         WHERE order_id IN (SELECT id FROM orders WHERE comanda_id = ?) AND status IN ('received','preparing','ready')`,
        now, now, id,
      );
      this.ctx.db.run("UPDATE comandas SET status = 'canceled', canceled_by = ?, canceled_at = ?, cancel_reason = ? WHERE id = ?", actor.userId, now, input.reason, id);
      this.touch(id, 'canceled');
      this.ctx.emit({ channel: 'kitchen', type: 'order.changed', data: { comandaId: id } });
      this.ctx.emit({ channel: 'tv', type: 'board.changed' });
      this.ctx.audit(actor, 'comandas.canceled', 'comanda', id, { number: c.number, reason: input.reason, items: items.length });
      return this.summary(this.row(id));
    });
  }

  /** Dados completos de contato (LGPD: acesso registrado em auditoria). */
  contact(actor: Actor, id: string) {
    requirePerm(actor, 'comandas.open');
    const c = this.row(id);
    this.ctx.tx(() => this.ctx.audit(actor, 'comandas.contact_viewed', 'comanda', id));
    return { phone: c.customer_phone, cpf: c.customer_cpf };
  }
}
