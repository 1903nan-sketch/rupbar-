import { hookahCharge, HOOKAH_STATUS, type HookahPricing, type HookahStatus } from '@rupbar/core';
import { hookahFinishSchema, hookahRoshSchema, hookahSchema, hookahStartSchema, hookahStatusSchema } from '@rupbar/core/schemas';
import { json, type Row } from '../db/db';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { ComandasService } from './comandas';
import { requirePerm, type Actor, type Ctx } from './context';
import type { SettingsService } from './settings';
import type { StockService } from './stock';

export class HookahService {
  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly stock: StockService,
    private readonly comandas: ComandasService,
  ) {}

  private hookahRow(id: string): Row {
    const h = this.ctx.db.get('SELECT * FROM hookahs WHERE id = ?', id);
    if (!h) throw notFound('Narguilé');
    return h;
  }

  private sessionRow(id: string): Row {
    const s = this.ctx.db.get('SELECT * FROM hookah_sessions WHERE id = ?', id);
    if (!s) throw notFound('Locação');
    return s;
  }

  private setStatus(hookahId: string, from: string | null, to: HookahStatus, actor: Actor, notes: string | null = null) {
    const now = this.ctx.nowIso();
    this.ctx.db.run('UPDATE hookahs SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', to, now, hookahId);
    this.ctx.db.run(
      'INSERT INTO hookah_status_history (id, hookah_id, from_status, to_status, notes, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
      this.ctx.id(), hookahId, from, to, notes, actor.userId, now,
    );
    this.ctx.emit({ channel: 'hookah', type: 'hookah.status', data: { hookahId, status: to } });
  }

  list(actor: Actor) {
    requirePerm(actor, 'hookah.view');
    const rows = this.ctx.db.all(
      `SELECT h.*, s.id AS session_id, s.started_at, s.customer_name, s.rosh_count, c.number AS comanda_number, c.table_label
       FROM hookahs h LEFT JOIN hookah_sessions s ON s.hookah_id = h.id AND s.status = 'active'
       LEFT JOIN comandas c ON c.id = s.comanda_id
       ORDER BY h.active DESC, h.code`,
    );
    return rows.map((h) => ({
      id: h.id, code: h.code, model: h.model, pricingMode: h.pricing_mode, priceCents: h.price_cents, periodMinutes: h.period_minutes,
      toleranceMinutes: h.tolerance_minutes, status: h.status, statusLabel: HOOKAH_STATUS[h.status as HookahStatus], notes: h.notes,
      active: h.active === 1,
      session: h.session_id
        ? {
            id: h.session_id, startedAt: h.started_at, customerName: h.customer_name, roshCount: h.rosh_count,
            comandaNumber: h.comanda_number, table: h.table_label,
            currentCharge: hookahCharge(this.pricingOf(h), Date.parse(String(h.started_at)), this.ctx.clock.now()),
          }
        : null,
    }));
  }

  private pricingOf(h: Row): HookahPricing {
    return {
      mode: h.pricing_mode as HookahPricing['mode'],
      priceCents: Number(h.price_cents),
      periodMinutes: Number(h.period_minutes),
      toleranceMinutes: Number(h.tolerance_minutes),
    };
  }

  save(actor: Actor, id: string | null, raw: unknown) {
    requirePerm(actor, 'hookah.manage');
    const input = hookahSchema.parse(raw);
    const hookahId = id ?? this.ctx.id();
    this.ctx.tx(() => {
      const dup = this.ctx.db.value('SELECT id FROM hookahs WHERE code = ? COLLATE NOCASE AND id <> ?', input.code, hookahId);
      if (dup) throw conflict('Já existe um narguilé com este identificador.', 'DUPLICATE_CODE');
      const now = this.ctx.nowIso();
      if (id) {
        const h = this.hookahRow(id);
        this.ctx.db.run(
          `UPDATE hookahs SET code=?, model=?, pricing_mode=?, price_cents=?, period_minutes=?, tolerance_minutes=?, notes=?, active=?,
             version=version+1, updated_at=? WHERE id=?`,
          input.code, input.model, input.pricingMode, input.priceCents, input.periodMinutes, input.toleranceMinutes, input.notes, input.active, now, id,
        );
        if (!input.active && h.status !== 'inactive') {
          if (h.status === 'rented') throw conflict('Registre a devolução antes de desativar.', 'HOOKAH_RENTED');
          this.setStatus(id, String(h.status), 'inactive', actor, 'Desativado');
        }
      } else {
        this.ctx.db.run(
          `INSERT INTO hookahs (id, code, model, pricing_mode, price_cents, period_minutes, tolerance_minutes, status, notes, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          hookahId, input.code, input.model, input.pricingMode, input.priceCents, input.periodMinutes, input.toleranceMinutes,
          input.active ? 'available' : 'inactive', input.notes, input.active, now, now,
        );
      }
      this.ctx.audit(actor, id ? 'hookah.updated' : 'hookah.created', 'hookah', hookahId, { code: input.code });
    });
    return { id: hookahId };
  }

  changeStatus(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'hookah.manage');
    const input = hookahStatusSchema.parse(raw);
    return this.ctx.tx(() => {
      const h = this.hookahRow(id);
      if (input.status === 'rented') throw badRequest('Use "Nova locação" para alugar o aparelho.');
      if (h.status === 'rented') throw conflict('Registre a devolução antes de mudar o status.', 'HOOKAH_RENTED');
      if (h.status === input.status) return { ok: true };
      this.ctx.db.run('UPDATE hookahs SET active = ? WHERE id = ?', input.status !== 'inactive', id);
      this.setStatus(id, String(h.status), input.status, actor, input.notes);
      this.ctx.audit(actor, 'hookah.status', 'hookah', id, { from: h.status, to: input.status, notes: input.notes });
      return { ok: true };
    });
  }

  history(actor: Actor, id: string) {
    requirePerm(actor, 'hookah.view');
    return {
      status: this.ctx.db.all(
        `SELECT hs.*, u.name AS user_name FROM hookah_status_history hs LEFT JOIN users u ON u.id = hs.user_id
         WHERE hs.hookah_id = ? ORDER BY hs.created_at DESC LIMIT 200`,
        id,
      ),
      sessions: this.ctx.db.all(
        `SELECT s.id, s.customer_name, s.started_at, s.ended_at, s.status, s.charge_cents, s.rosh_count, c.number AS comanda_number
         FROM hookah_sessions s JOIN comandas c ON c.id = s.comanda_id WHERE s.hookah_id = ? ORDER BY s.started_at DESC LIMIT 200`,
        id,
      ),
    };
  }

  private consume(sessionId: string, roshNo: number, essences: { productId: string; qty: number }[], coalProductId: string | null, coalUnits: number, actor: Actor) {
    const now = this.ctx.nowIso();
    const record = (productId: string, kind: 'essence' | 'coal', qty: number) => {
      const p = this.ctx.db.get('SELECT id, name, measure FROM products WHERE id = ?', productId);
      if (!p) throw notFound('Produto');
      if (kind === 'essence' && p.measure !== 'mass') throw badRequest(`${p.name} não é controlado por peso (g).`);
      if (kind === 'coal' && p.measure !== 'unit') throw badRequest(`${p.name} não é controlado por unidade.`);
      const id = this.ctx.id();
      this.ctx.db.run(
        'INSERT INTO hookah_consumptions (id, session_id, rosh_no, product_id, kind, qty, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, sessionId, roshNo, productId, kind, qty, actor.userId, now, now,
      );
      const tracked = this.ctx.db.value('SELECT stock_tracked FROM products WHERE id = ?', productId) === 1;
      let cost = 0;
      if (tracked) {
        cost = this.stock.move({
          productId, type: 'hookah', delta: -qty, refType: 'hookah_consumption', refId: id, reason: `Narguilé — rosh ${roshNo}`, userId: actor.userId,
        }).costCents;
      }
      this.ctx.db.run('UPDATE hookah_consumptions SET cost_cents = ? WHERE id = ?', cost, id);
    };
    for (const e of essences) record(e.productId, 'essence', e.qty);
    if (coalUnits > 0) {
      if (!coalProductId) throw badRequest('Selecione o carvão utilizado.');
      record(coalProductId, 'coal', coalUnits * 1000);
    }
    this.ctx.db.run('UPDATE hookah_sessions SET rosh_count = ?, version = version + 1, updated_at = ? WHERE id = ?', roshNo, now, sessionId);
  }

  start(actor: Actor, raw: unknown) {
    requirePerm(actor, 'hookah.rent');
    const input = hookahStartSchema.parse(raw);
    return this.ctx.tx(() => {
      const dup = this.ctx.db.value<string>('SELECT id FROM hookah_sessions WHERE client_request_id = ?', input.clientRequestId);
      if (dup) return this.session(actor, dup);
      const h = this.hookahRow(input.hookahId);
      if (h.status !== 'available') throw conflict(`Narguilé ${h.code} está "${HOOKAH_STATUS[h.status as HookahStatus]}".`, 'HOOKAH_UNAVAILABLE');
      const c = this.ctx.db.get('SELECT * FROM comandas WHERE id = ?', input.comandaId);
      if (!c) throw notFound('Comanda');
      if (c.status !== 'open') throw conflict('A comanda precisa estar aberta.', 'COMANDA_NOT_OPEN');
      const id = this.ctx.id();
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `INSERT INTO hookah_sessions (id, hookah_id, comanda_id, customer_name, started_at, status, pricing_json, notes, client_request_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?, 'active', ?,?,?,?,?,?)`,
        id, input.hookahId, input.comandaId, String(c.customer_name), now, JSON.stringify(this.pricingOf(h)), input.notes,
        input.clientRequestId, actor.userId, now, now,
      );
      if (input.essences.length || input.coalUnits) this.consume(id, 1, input.essences, input.coalProductId, input.coalUnits, actor);
      this.setStatus(input.hookahId, String(h.status), 'rented', actor);
      this.comandas.touch(input.comandaId, 'hookah_started');
      this.ctx.audit(actor, 'hookah.rented', 'hookah_session', id, { code: h.code, comanda: c.number });
      return this.session(actor, id);
    });
  }

  addRosh(actor: Actor, sessionId: string, raw: unknown) {
    requirePerm(actor, 'hookah.rent');
    const input = hookahRoshSchema.parse(raw);
    return this.ctx.tx(() => {
      const s = this.sessionRow(sessionId);
      if (s.status !== 'active') throw conflict('Esta locação já foi encerrada.', 'SESSION_FINISHED');
      this.consume(sessionId, Number(s.rosh_count) + 1, input.essences, input.coalProductId, input.coalUnits, actor);
      this.ctx.audit(actor, 'hookah.rosh_added', 'hookah_session', sessionId, { rosh: Number(s.rosh_count) + 1 });
      return this.session(actor, sessionId);
    });
  }

  /** Devolução: calcula o valor, lança na comanda e envia o aparelho para limpeza. */
  finish(actor: Actor, sessionId: string, raw: unknown) {
    requirePerm(actor, 'hookah.rent');
    const input = hookahFinishSchema.parse(raw);
    return this.ctx.tx(() => {
      const s = this.sessionRow(sessionId);
      if (s.status !== 'active') throw conflict('Esta locação já foi encerrada.', 'SESSION_FINISHED');
      const h = this.hookahRow(String(s.hookah_id));
      const c = this.ctx.db.get('SELECT * FROM comandas WHERE id = ?', String(s.comanda_id));
      if (!c || c.status !== 'open') throw conflict('A comanda vinculada não está aberta.', 'COMANDA_NOT_OPEN');
      const now = this.ctx.clock.now();
      const pricing = json<HookahPricing>(s.pricing_json, this.pricingOf(h));
      const charge = hookahCharge(pricing, Date.parse(String(s.started_at)), now);
      const consumptionCost = Number(this.ctx.db.value('SELECT COALESCE(SUM(cost_cents),0) FROM hookah_consumptions WHERE session_id = ?', sessionId));
      const itemId = this.ctx.id();
      const nowIso = now.toISOString();
      this.ctx.db.run(
        `INSERT INTO comanda_items (id, comanda_id, order_id, kind, presentation_id, product_id, product_name, presentation_name, quantity,
           unit_price_cents, unit_cost_cents, notes, station, created_by, created_at, updated_at)
         VALUES (?,?,NULL,'hookah',NULL,NULL,?,?,1,?,?,?, 'none', ?,?,?)`,
        itemId, String(s.comanda_id), `Narguilé ${h.code}`, `${charge.description} (${charge.minutes} min)`, charge.totalCents,
        consumptionCost, s.rosh_count ? `${s.rosh_count} rosh` : null, actor.userId, nowIso, nowIso,
      );
      this.ctx.db.run(
        `UPDATE hookah_sessions SET status = 'finished', ended_at = ?, charge_cents = ?, comanda_item_id = ?, finished_by = ?,
           notes = COALESCE(?, notes), version = version + 1, updated_at = ? WHERE id = ?`,
        nowIso, charge.totalCents, itemId, actor.userId, input.notes, nowIso, sessionId,
      );
      const needsCleaning = input.sendToCleaning && this.settings.operation().hookahRequiresCleaning;
      this.setStatus(String(h.id), 'rented', needsCleaning ? 'cleaning' : 'available', actor, 'Devolução');
      this.comandas.touch(String(s.comanda_id), 'hookah_finished');
      this.ctx.audit(actor, 'hookah.returned', 'hookah_session', sessionId, { code: h.code, chargeCents: charge.totalCents, minutes: charge.minutes });
      return this.session(actor, sessionId);
    });
  }

  session(actor: Actor, id: string) {
    requirePerm(actor, 'hookah.view');
    const s = this.ctx.db.get(
      `SELECT s.*, h.code, h.model, c.number AS comanda_number, c.table_label FROM hookah_sessions s
       JOIN hookahs h ON h.id = s.hookah_id JOIN comandas c ON c.id = s.comanda_id WHERE s.id = ?`,
      id,
    );
    if (!s) throw notFound('Locação');
    const consumptions = this.ctx.db.all(
      `SELECT hc.rosh_no, hc.kind, hc.qty, hc.created_at, p.id AS product_id, p.name AS product_name FROM hookah_consumptions hc
       JOIN products p ON p.id = hc.product_id WHERE hc.session_id = ? ORDER BY hc.rosh_no, hc.kind DESC, p.name`,
      id,
    );
    const pricing = json<HookahPricing>(s.pricing_json, { mode: 'fixed', priceCents: 0 });
    return {
      id: s.id, hookahId: s.hookah_id, code: s.code, model: s.model, comandaId: s.comanda_id, comandaNumber: s.comanda_number,
      table: s.table_label, customerName: s.customer_name, startedAt: s.started_at, endedAt: s.ended_at, status: s.status,
      roshCount: s.rosh_count, chargeCents: s.charge_cents, notes: s.notes, pricing,
      currentCharge: s.status === 'active' ? hookahCharge(pricing, Date.parse(String(s.started_at)), this.ctx.clock.now()) : null,
      consumptions,
    };
  }

  sessions(actor: Actor, filter: { status?: string; from?: string; to?: string } = {}) {
    requirePerm(actor, 'hookah.view');
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) where.push('s.status = ?'), params.push(filter.status);
    if (filter.from) where.push('s.started_at >= ?'), params.push(filter.from);
    if (filter.to) where.push('s.started_at < ?'), params.push(filter.to);
    return this.ctx.db.all(
      `SELECT s.id, s.customer_name, s.started_at, s.ended_at, s.status, s.charge_cents, s.rosh_count, h.code, c.number AS comanda_number
       FROM hookah_sessions s JOIN hookahs h ON h.id = s.hookah_id JOIN comandas c ON c.id = s.comanda_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.started_at DESC LIMIT 300`,
      ...params,
    );
  }

  /** Indicadores do período: gramas, sessões, sabores, carvão, receita, duração e uso por aparelho. */
  indicators(actor: Actor, from: string, to: string) {
    requirePerm(actor, 'reports.operational');
    const totals = this.ctx.db.get<{ sessions: number; revenue: number; avg_minutes: number | null; roshes: number }>(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(charge_cents),0) AS revenue,
              AVG((julianday(ended_at) - julianday(started_at)) * 1440) AS avg_minutes, COALESCE(SUM(rosh_count),0) AS roshes
       FROM hookah_sessions WHERE status = 'finished' AND started_at >= ? AND started_at < ?`,
      from, to,
    )!;
    const consumption = this.ctx.db.get<{ grams: number; coal: number; cost: number }>(
      `SELECT COALESCE(SUM(CASE WHEN hc.kind = 'essence' THEN hc.qty END),0) AS grams,
              COALESCE(SUM(CASE WHEN hc.kind = 'coal' THEN hc.qty END),0) AS coal, COALESCE(SUM(hc.cost_cents),0) AS cost
       FROM hookah_consumptions hc JOIN hookah_sessions s ON s.id = hc.session_id WHERE s.started_at >= ? AND s.started_at < ?`,
      from, to,
    )!;
    const flavors = this.ctx.db.all(
      `SELECT p.id AS product_id, p.name, SUM(hc.qty) AS qty, COUNT(DISTINCT hc.session_id) AS sessions, SUM(hc.cost_cents) AS cost_cents
       FROM hookah_consumptions hc JOIN products p ON p.id = hc.product_id JOIN hookah_sessions s ON s.id = hc.session_id
       WHERE hc.kind = 'essence' AND s.started_at >= ? AND s.started_at < ? GROUP BY p.id ORDER BY qty DESC`,
      from, to,
    );
    const devices = this.ctx.db.all(
      `SELECT h.code, h.model, COUNT(s.id) AS sessions, COALESCE(SUM(s.charge_cents),0) AS revenue,
              COALESCE(SUM((julianday(s.ended_at) - julianday(s.started_at)) * 1440),0) AS minutes
       FROM hookahs h LEFT JOIN hookah_sessions s ON s.hookah_id = h.id AND s.status = 'finished' AND s.started_at >= ? AND s.started_at < ?
       GROUP BY h.id ORDER BY sessions DESC`,
      from, to,
    );
    return {
      sessions: totals.sessions,
      roshes: totals.roshes,
      revenueCents: totals.revenue,
      avgMinutes: totals.avg_minutes === null ? null : Math.round(totals.avg_minutes),
      essenceGramsMilli: consumption.grams,
      avgGramsPerSessionMilli: totals.sessions ? Math.round(consumption.grams / totals.sessions) : 0,
      coalUnits: consumption.coal / 1000,
      consumptionCostCents: consumption.cost,
      flavors,
      devices,
    };
  }
}
