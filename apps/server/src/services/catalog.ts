import { DEFAULT_CATEGORIES, entryQtyMilli, packageBreakdown, stockLevel, theoreticalYield, type Measure } from '@rupbar/core';
import { categorySchema, optionGroupSchema, productSchema, supplierSchema, type ProductInput } from '@rupbar/core/schemas';
import { bool, type Row } from '../db/db';
import { allocateProductCode, peekProductCode } from '../db/product-codes';
import { badRequest, conflict, notFound } from '../lib/errors';
import { hasPerm, requirePerm, type Actor, type Ctx } from './context';
import { attachmentUrl } from './settings';
import type { StockService } from './stock';

export interface PresentationView {
  id: string;
  name: string;
  priceCents: number;
  menuVisible: boolean;
  active: boolean;
  sortOrder: number;
  components: { productId: string; productName: string; qty: number; measure: Measure; isSelf: boolean }[];
  /** Escolhas só desta apresentação (somadas às do produto). */
  optionGroups: { groupId: string; quantity: number }[];
  /** Meio a meio: apresentações que podem ser metade. */
  halves: string[];
  /** Quantas unidades desta apresentação o estoque atual permite (null = não controlado). */
  available: number | null;
}

export class CatalogService {
  private stock!: StockService;

  constructor(private readonly ctx: Ctx) {}

  bind(stock: StockService): void {
    this.stock = stock;
  }

  // ---------------------------------------------------------------- categorias

  seedCategories(): void {
    const now = this.ctx.nowIso();
    DEFAULT_CATEGORIES.forEach((c, i) => {
      if (this.ctx.db.value('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', c.name)) return;
      this.ctx.db.run(
        'INSERT INTO categories (id, name, station, icon, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        this.ctx.id(), c.name, c.station, c.icon, i, now, now,
      );
    });
  }

  categories() {
    return this.ctx.db
      .all(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
         FROM categories c ORDER BY c.sort_order, c.name`,
      )
      .map((c) => ({
        id: c.id, name: c.name, station: c.station, icon: c.icon, sortOrder: c.sort_order, active: bool(c.active),
        productCount: c.product_count,
      }));
  }

  createCategory(actor: Actor, raw: unknown) {
    requirePerm(actor, 'products.manage');
    const input = categorySchema.parse(raw);
    const id = this.ctx.id();
    this.ctx.tx(() => {
      if (this.ctx.db.value('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', input.name)) throw conflict('Categoria já existe.');
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        'INSERT INTO categories (id, name, station, icon, sort_order, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        id, input.name, input.station, input.icon, input.sortOrder, input.active, now, now,
      );
      this.ctx.audit(actor, 'categories.created', 'category', id, { name: input.name });
    });
    return { id };
  }

  updateCategory(actor: Actor, id: string, raw: unknown) {
    requirePerm(actor, 'products.manage');
    const input = categorySchema.parse(raw);
    this.ctx.tx(() => {
      const c = this.ctx.db.get('SELECT id FROM categories WHERE id = ?', id);
      if (!c) throw notFound('Categoria');
      if (this.ctx.db.value('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?', input.name, id)) {
        throw conflict('Categoria já existe.');
      }
      this.ctx.db.run(
        'UPDATE categories SET name=?, station=?, icon=?, sort_order=?, active=?, version=version+1, updated_at=? WHERE id=?',
        input.name, input.station, input.icon, input.sortOrder, input.active, this.ctx.nowIso(), id,
      );
      this.ctx.audit(actor, 'categories.updated', 'category', id, input);
    });
  }

  // -------------------------------------------------------------- fornecedores

  suppliers() {
    return this.ctx.db.all('SELECT * FROM suppliers ORDER BY active DESC, name');
  }

  upsertSupplier(actor: Actor, id: string | null, raw: unknown) {
    requirePerm(actor, 'suppliers.manage');
    const input = supplierSchema.parse(raw);
    const supplierId = id ?? this.ctx.id();
    this.ctx.tx(() => {
      const now = this.ctx.nowIso();
      if (id) {
        if (!this.ctx.db.get('SELECT id FROM suppliers WHERE id = ?', id)) throw notFound('Fornecedor');
        this.ctx.db.run(
          `UPDATE suppliers SET name=?, cnpj=?, phone=?, email=?, contact_name=?, notes=?, active=?, version=version+1, updated_at=? WHERE id=?`,
          input.name, input.cnpj, input.phone, input.email, input.contactName, input.notes, input.active, now, id,
        );
      } else {
        this.ctx.db.run(
          `INSERT INTO suppliers (id, name, cnpj, phone, email, contact_name, notes, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          supplierId, input.name, input.cnpj, input.phone, input.email, input.contactName, input.notes, input.active, now, now,
        );
      }
      this.ctx.audit(actor, id ? 'suppliers.updated' : 'suppliers.created', 'supplier', supplierId, { name: input.name });
    });
    return { id: supplierId };
  }

  // ------------------------------------------------------------------ produtos

  private componentsOf(presentationId: string, ownerProductId: string) {
    return this.ctx.db
      .all(
        `SELECT pc.ingredient_product_id AS product_id, pc.qty, p.name, p.measure
         FROM presentation_components pc JOIN products p ON p.id = pc.ingredient_product_id
         WHERE pc.presentation_id = ? ORDER BY p.name`,
        presentationId,
      )
      .map((c) => ({
        productId: String(c.product_id),
        productName: String(c.name),
        qty: Number(c.qty),
        measure: c.measure as Measure,
        isSelf: c.product_id === ownerProductId,
      }));
  }

  /** Quantas unidades de uma apresentação o estoque permite (menor razão entre ingredientes controlados). */
  /** Porções que podem ser metade no meio a meio; esgotada quando não há estoque para meia porção. */
  private halfParts(presentationId: string) {
    const parts = this.ctx.db.all(
      `SELECT pr.id, pr.name, pr.price_cents, pr.product_id, p.name AS product_name FROM presentation_halves h
       JOIN presentations pr ON pr.id = h.part_presentation_id JOIN products p ON p.id = pr.product_id
       WHERE h.presentation_id = ? AND pr.active = 1 AND p.active = 1 ORDER BY h.sort_order`,
      presentationId,
    );
    if (!parts.length) return undefined;
    return parts.map((part) => {
      const half = this.componentsOf(String(part.id), String(part.product_id)).map((c) => ({ ...c, qty: Math.max(1, Math.round(c.qty / 2)) }));
      return {
        presentationId: String(part.id), name: String(part.product_name), presentationName: String(part.name),
        priceCents: Number(part.price_cents), soldOut: this.availability(half) === 0,
      };
    });
  }

  private availability(components: PresentationView['components']): number | null {
    let min: number | null = null;
    for (const c of components) {
      const p = this.ctx.db.get<{ stock_tracked: number; stock_qty: number }>('SELECT stock_tracked, stock_qty FROM products WHERE id = ?', c.productId);
      if (!p || p.stock_tracked !== 1) continue;
      const n = Math.max(0, Math.floor(p.stock_qty / c.qty));
      min = min === null ? n : Math.min(min, n);
    }
    return min;
  }

  private presentationsOf(productId: string): PresentationView[] {
    return this.ctx.db
      .all('SELECT * FROM presentations WHERE product_id = ? ORDER BY sort_order, price_cents', productId)
      .map((pr) => {
        const components = this.componentsOf(String(pr.id), productId);
        return {
          id: String(pr.id), name: String(pr.name), priceCents: Number(pr.price_cents), menuVisible: bool(pr.menu_visible),
          active: bool(pr.active), sortOrder: Number(pr.sort_order), components, available: this.availability(components),
          optionGroups: this.ctx.db
            .all<{ group_id: string; quantity: number }>('SELECT group_id, quantity FROM presentation_option_groups WHERE presentation_id = ? ORDER BY sort_order', String(pr.id))
            .map((l) => ({ groupId: l.group_id, quantity: l.quantity })),
          halves: this.ctx.db
            .all<{ part_presentation_id: string }>('SELECT part_presentation_id FROM presentation_halves WHERE presentation_id = ? ORDER BY sort_order', String(pr.id))
            .map((h) => h.part_presentation_id),
        };
      });
  }

  productView(p: Row, actor: Actor | null, withPresentations = true) {
    const showCost = !actor || hasPerm(actor, 'reports.financial') || hasPerm(actor, 'stock.entry');
    const measure = p.measure as Measure;
    const presentations = withPresentations ? this.presentationsOf(String(p.id)) : [];
    const smallestDose = presentations
      .flatMap((pr) => pr.components.filter((c) => c.isSelf).map((c) => c.qty))
      .reduce<number | null>((m, q) => (m === null ? q : Math.min(m, q)), null);
    return {
      id: p.id,
      name: p.name,
      categoryId: p.category_id,
      categoryName: p.category_name ?? null,
      internalCode: p.internal_code,
      barcode: p.barcode,
      description: p.description,
      supplierId: p.supplier_id,
      photoUrl: attachmentUrl(p.photo_attachment_id as string | null),
      measure,
      packageQty: p.package_qty,
      packageLabel: p.package_label,
      unitLabel: p.unit_label ?? null,
      /** Menor dose vendida do próprio produto (ex.: 50 ml), para "1 garrafa = 20 doses". */
      doseQty: smallestDose,
      stockTracked: bool(p.stock_tracked),
      stockQty: p.stock_qty,
      minStock: p.min_stock,
      level: bool(p.stock_tracked) ? stockLevel(Number(p.stock_qty), Number(p.min_stock)) : 'ok',
      packages: bool(p.stock_tracked) ? packageBreakdown(Number(p.stock_qty), Number(p.package_qty)) : null,
      theoreticalYield: smallestDose ? theoreticalYield(Number(p.package_qty), smallestDose) : null,
      unitCostE4: showCost ? p.unit_cost_e4 : null,
      expiryTracked: bool(p.expiry_tracked),
      menuVisible: bool(p.menu_visible),
      station: p.station ?? p.category_station ?? 'none',
      stationOverride: p.station,
      active: bool(p.active),
      updatedAt: p.updated_at,
      version: p.version,
      presentations,
      ...(() => {
        const links = this.ctx.db.all<{ group_id: string; quantity: number }>(
          'SELECT group_id, quantity FROM product_option_groups WHERE product_id = ? ORDER BY sort_order', String(p.id),
        );
        // Escolhas na ordem e, nos combos, quantas unidades da opção escolhida vão (4 latas, 5 gelos).
        return { optionGroupIds: links.map((l) => l.group_id), optionGroups: links.map((l) => ({ groupId: l.group_id, quantity: l.quantity })) };
      })(),
    };
  }

  // ------------------------------------------------------- escolhas no pedido

  /** Opção esgotada: o produto que ela baixa é controlado e não tem saldo para uma dose. */
  private choiceSoldOut(productId: string | null, qty: number): boolean {
    if (!productId || qty <= 0) return false;
    const p = this.ctx.db.get<{ stock_tracked: number; stock_qty: number }>('SELECT stock_tracked, stock_qty FROM products WHERE id = ?', productId);
    return !!p && p.stock_tracked === 1 && p.stock_qty < qty;
  }

  /** Escolhas do pedido (Energético, Gelo, Sabor do gin…) com as opções e os produtos que usam cada uma. */
  optionGroups(actor: Actor) {
    requirePerm(actor, 'products.view');
    return this.ctx.db.all('SELECT * FROM option_groups ORDER BY active DESC, name COLLATE NOCASE').map((g) => ({
      id: g.id,
      name: g.name,
      required: bool(g.required),
      active: bool(g.active),
      choices: this.ctx.db
        .all(
          `SELECT oc.*, p.name AS product_name, p.measure FROM option_choices oc LEFT JOIN products p ON p.id = oc.ingredient_product_id
           WHERE oc.group_id = ? AND oc.active = 1 ORDER BY oc.sort_order, oc.name`,
          String(g.id),
        )
        .map((c) => ({
          id: c.id, name: c.name, priceDeltaCents: c.price_delta_cents, productId: c.ingredient_product_id, productName: c.product_name ?? null,
          measure: (c.measure as Measure | null) ?? null, qty: c.qty, soldOut: this.choiceSoldOut(c.ingredient_product_id as string | null, Number(c.qty)),
        })),
      products: this.ctx.db
        .all<{ id: string; name: string }>(
          `SELECT DISTINCT p.id, p.name FROM products p
           WHERE p.active = 1 AND (p.id IN (SELECT product_id FROM product_option_groups WHERE group_id = ?)
             OR p.id IN (SELECT pr.product_id FROM presentation_option_groups po JOIN presentations pr ON pr.id = po.presentation_id WHERE po.group_id = ? AND pr.active = 1))
           ORDER BY p.name`,
          String(g.id), String(g.id),
        ),
    }));
  }

  /**
   * Cria ou altera uma escolha. Opções alteradas mantêm o id; as removidas são
   * desativadas (itens vendidos guardam o que foi escolhido).
   */
  saveOptionGroup(actor: Actor, id: string | null, raw: unknown) {
    requirePerm(actor, 'products.manage');
    const input = optionGroupSchema.parse(raw);
    const groupId = id ?? this.ctx.id();
    this.ctx.tx(() => {
      const now = this.ctx.nowIso();
      if (id) {
        if (!this.ctx.db.run('UPDATE option_groups SET name=?, required=?, active=?, version=version+1, updated_at=? WHERE id=?', input.name, input.required, input.active, now, id).changes) {
          throw notFound('Escolha');
        }
      } else {
        this.ctx.db.run('INSERT INTO option_groups (id, name, required, active, created_at, updated_at) VALUES (?,?,?,?,?,?)', groupId, input.name, input.required, input.active, now, now);
      }
      const existing = new Set(this.ctx.db.all<{ id: string }>('SELECT id FROM option_choices WHERE group_id = ?', groupId).map((r) => r.id));
      const kept = new Set<string>();
      input.choices.forEach((c, idx) => {
        if (c.productId && !this.ctx.db.value('SELECT id FROM products WHERE id = ?', c.productId)) throw notFound('Produto da opção');
        const choiceId = c.id && existing.has(c.id) ? c.id : this.ctx.id();
        kept.add(choiceId);
        const qty = c.productId ? c.qty : 0;
        if (existing.has(choiceId)) {
          this.ctx.db.run(
            'UPDATE option_choices SET name=?, price_delta_cents=?, ingredient_product_id=?, qty=?, sort_order=?, active=?, version=version+1, updated_at=? WHERE id=?',
            c.name, c.priceDeltaCents, c.productId, qty, idx, c.active, now, choiceId,
          );
        } else {
          this.ctx.db.run(
            `INSERT INTO option_choices (id, group_id, name, price_delta_cents, ingredient_product_id, qty, sort_order, active, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            choiceId, groupId, c.name, c.priceDeltaCents, c.productId, qty, idx, c.active, now, now,
          );
        }
      });
      for (const old of existing) {
        if (!kept.has(old)) this.ctx.db.run('UPDATE option_choices SET active = 0, version=version+1, updated_at=? WHERE id = ?', now, old);
      }
      this.ctx.audit(actor, id ? 'options.updated' : 'options.created', 'option_group', groupId, {
        name: input.name, choices: input.choices.map((c) => ({ name: c.name, priceDeltaCents: c.priceDeltaCents })),
      });
      this.ctx.emit({ channel: 'stock', type: 'stock.changed' });
    });
    return { id: groupId };
  }

  /** Escolhas ativas do cardápio, com as opções disponíveis (por id). */
  private menuOptionGroups() {
    const groups: Record<string, { id: string; name: string; required: boolean; choices: { id: string; name: string; priceDeltaCents: number; soldOut: boolean }[] }> = {};
    for (const g of this.ctx.db.all('SELECT * FROM option_groups WHERE active = 1')) {
      const choices = this.ctx.db
        .all('SELECT * FROM option_choices WHERE group_id = ? AND active = 1 ORDER BY sort_order, name', String(g.id))
        .map((c) => ({
          id: String(c.id), name: String(c.name), priceDeltaCents: Number(c.price_delta_cents),
          soldOut: this.choiceSoldOut(c.ingredient_product_id as string | null, Number(c.qty)),
        }));
      if (choices.length) groups[String(g.id)] = { id: String(g.id), name: String(g.name), required: bool(g.required), choices };
    }
    return groups;
  }

  products(actor: Actor, filter: { q?: string; categoryId?: string; includeInactive?: boolean } = {}) {
    requirePerm(actor, 'products.view');
    const where: string[] = [];
    const params: string[] = [];
    where.push('p.deleted_at IS NULL');
    if (!filter.includeInactive) where.push('p.active = 1');
    if (filter.categoryId) {
      where.push('p.category_id = ?');
      params.push(filter.categoryId);
    }
    if (filter.q) {
      // Código: "7", "07" e "#0007" encontram "0007"; texto busca pelo começo ("CERV" → "CERV-01").
      const q = filter.q.trim();
      const code = q.replace(/^#/, '');
      where.push(`(p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?${/^\d+$/.test(code) ? " OR ltrim(p.internal_code, '0') = ltrim(?, '0')" : ''})`);
      params.push(`%${q}%`, `${code}%`, q);
      if (/^\d+$/.test(code)) params.push(code);
    }
    const rows = this.ctx.db.all(
      `SELECT p.*, c.name AS category_name, c.station AS category_station FROM products p
       JOIN categories c ON c.id = p.category_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.sort_order, p.name`,
      ...params,
    );
    return rows.map((p) => this.productView(p, actor));
  }

  product(actor: Actor, id: string) {
    requirePerm(actor, 'products.view');
    const p = this.ctx.db.get(
      `SELECT p.*, c.name AS category_name, c.station AS category_station FROM products p
       JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
      id,
    );
    if (!p) throw notFound('Produto');
    return this.productView(p, actor);
  }

  /**
   * Cardápio para garçons/celulares: apenas itens ativos e visíveis, com preço,
   * disponibilidade e local de preparo. Sem custos.
   */
  menu(actor: Actor) {
    requirePerm(actor, 'menu.view');
    const categories = this.ctx.db.all('SELECT id, name, icon, station FROM categories WHERE active = 1 ORDER BY sort_order, name');
    const optionGroups = this.menuOptionGroups();
    const linked = new Map<string, { group_id: string; quantity: number }[]>();
    for (const l of this.ctx.db.all<{ product_id: string; group_id: string; quantity: number }>('SELECT product_id, group_id, quantity FROM product_option_groups ORDER BY sort_order')) {
      linked.set(l.product_id, [...(linked.get(l.product_id) ?? []), l]);
    }
    const ownLinks = new Map<string, { group_id: string; quantity: number }[]>();
    for (const l of this.ctx.db.all<{ presentation_id: string; group_id: string; quantity: number }>('SELECT presentation_id, group_id, quantity FROM presentation_option_groups ORDER BY sort_order')) {
      ownLinks.set(l.presentation_id, [...(ownLinks.get(l.presentation_id) ?? []), l]);
    }
    const items = this.ctx.db
      .all(
        `SELECT pr.id AS presentation_id, pr.name AS presentation_name, pr.price_cents, p.id AS product_id, p.name AS product_name,
                p.description, p.photo_attachment_id, p.category_id, COALESCE(p.station, c.station) AS station, p.barcode, p.internal_code
         FROM presentations pr JOIN products p ON p.id = pr.product_id JOIN categories c ON c.id = p.category_id
         WHERE pr.active = 1 AND pr.menu_visible = 1 AND p.active = 1 AND p.menu_visible = 1 AND c.active = 1
         ORDER BY c.sort_order, p.name, pr.sort_order, pr.price_cents`,
      )
      .map((r) => {
        const components = this.componentsOf(String(r.presentation_id), String(r.product_id));
        const available = this.availability(components);
        // As do produto valem para todas as apresentações; depois vêm as só desta (ex.: Dose com energético).
        const links = [...(linked.get(String(r.product_id)) ?? []), ...(ownLinks.get(String(r.presentation_id)) ?? [])]
          .filter((l, i, all) => optionGroups[l.group_id] && all.findIndex((x) => x.group_id === l.group_id) === i);
        const optionGroupIds = links.map((l) => l.group_id);
        const optionQty = Object.fromEntries(links.filter((l) => l.quantity > 1).map((l) => [l.group_id, l.quantity]));
        return {
          presentationId: r.presentation_id, presentationName: r.presentation_name, priceCents: r.price_cents,
          productId: r.product_id, productName: r.product_name, description: r.description,
          photoUrl: attachmentUrl(r.photo_attachment_id as string | null), categoryId: r.category_id, station: r.station,
          // Leitor de código de barras no caixa: bipar adiciona o produto.
          barcode: r.barcode, code: r.internal_code,
          available, soldOut: available === 0,
          // Escolhas pedidas ao tocar no produto (sabor, energético, gelo…) e, nos combos, quantas unidades de cada.
          optionGroupIds,
          optionQty,
          // Meio a meio: as porções que podem ser metade, com o preço de cada (cobra a mais cara).
          halfParts: this.halfParts(String(r.presentation_id)),
        };
      });
    return { categories, items, optionGroups };
  }

  private validateComponents(input: ProductInput, productId: string) {
    for (const pr of input.presentations) {
      for (const c of pr.components) {
        if (c.productId === null || c.productId === productId) continue;
        const ing = this.ctx.db.get('SELECT id, active FROM products WHERE id = ?', c.productId);
        if (!ing) throw badRequest(`Ingrediente não encontrado na apresentação "${pr.name}".`, 'INGREDIENT_NOT_FOUND');
      }
    }
  }

  saveProduct(actor: Actor, id: string | null, raw: unknown) {
    requirePerm(actor, 'products.manage');
    const input = productSchema.parse(raw);
    if (input.initialStock) {
      if (id) throw badRequest('Saldo inicial só pode ser informado no novo cadastro. Use uma entrada para repor o estoque.');
      if (!input.stockTracked) throw badRequest('Ative o controle de estoque para registrar o saldo inicial.');
      requirePerm(actor, 'stock.entry');
      const qty = entryQtyMilli(input.initialStock, input.packageQty);
      if (!Number.isSafeInteger(qty) || qty <= 0) throw badRequest('A quantidade inicial deve ser maior que zero e estar dentro do limite permitido.');
    }
    const productId = id ?? this.ctx.id();
    let internalCode: string | null = null;
    if (id && this.ctx.db.value('SELECT deleted_at FROM products WHERE id = ?', id)) throw notFound('Produto');
    this.ctx.tx(() => {
      if (!this.ctx.db.get('SELECT id FROM categories WHERE id = ?', input.categoryId)) throw notFound('Categoria');
      if (input.internalCode && this.ctx.db.value('SELECT id FROM products WHERE internal_code = ? AND id <> ?', input.internalCode, productId)) {
        throw conflict('Código interno já usado por outro produto.', 'DUPLICATE_CODE');
      }
      // "7" e "0007" se confundem na busca: um código numérico novo não pode repetir outro com zeros à esquerda.
      if (input.internalCode && /^\d+$/.test(input.internalCode)) {
        const current = id ? this.ctx.db.value<string | null>('SELECT internal_code FROM products WHERE id = ?', id) : null;
        const twin = current !== input.internalCode
          ? this.ctx.db.value<string>(
              "SELECT internal_code FROM products WHERE id <> ? AND internal_code GLOB '[0-9]*' AND internal_code NOT GLOB '*[^0-9]*' AND ltrim(internal_code, '0') = ltrim(?, '0')",
              productId, input.internalCode,
            )
          : undefined;
        if (twin) throw conflict(`Código interno equivale ao ${twin}, já usado por outro produto.`, 'DUPLICATE_CODE');
      }
      if (input.barcode && this.ctx.db.value('SELECT id FROM products WHERE barcode = ? AND id <> ?', input.barcode, productId)) {
        throw conflict('Código de barras já usado por outro produto.', 'DUPLICATE_BARCODE');
      }
      this.validateComponents(input, productId);
      const now = this.ctx.nowIso();
      const before = id ? this.ctx.db.get('SELECT * FROM products WHERE id = ?', id) : undefined;
      if (id && !before) throw notFound('Produto');
      if (before && before.measure !== input.measure && Number(before.stock_qty) !== 0) {
        throw conflict('Não é possível mudar a unidade de medida de um produto com saldo. Zere o estoque com um ajuste antes.', 'MEASURE_LOCKED');
      }
      // Código interno: o informado; em branco mantém o atual; sem nenhum, o próximo da sequência (0001, 0002…).
      const code = input.internalCode ?? (before?.internal_code ? String(before.internal_code) : null) ?? allocateProductCode(this.ctx.db);
      internalCode = code;

      if (before) {
        this.ctx.db.run(
          `UPDATE products SET name=?, category_id=?, internal_code=?, barcode=?, description=?, supplier_id=?, measure=?, package_qty=?,
             package_label=?, unit_label=?, stock_tracked=?, min_stock=?, unit_cost_e4=COALESCE(?, unit_cost_e4), expiry_tracked=?, menu_visible=?,
             station=?, active=?, version=version+1, updated_at=? WHERE id=?`,
          input.name, input.categoryId, code, input.barcode, input.description, input.supplierId, input.measure,
          input.packageQty, input.packageLabel, input.unitLabel, input.stockTracked, input.minStock, input.unitCostE4 ?? null, input.expiryTracked,
          input.menuVisible, input.station, input.active, now, productId,
        );
      } else {
        this.ctx.db.run(
          `INSERT INTO products (id, name, category_id, internal_code, barcode, description, supplier_id, measure, package_qty, package_label,
             unit_label, stock_tracked, stock_qty, min_stock, unit_cost_e4, expiry_tracked, menu_visible, station, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
          productId, input.name, input.categoryId, code, input.barcode, input.description, input.supplierId, input.measure,
          input.packageQty, input.packageLabel, input.unitLabel, input.stockTracked, input.minStock, input.unitCostE4 ?? 0, input.expiryTracked,
          input.menuVisible, input.station, input.active, now, now,
        );
      }

      // Apresentações: atualiza as existentes, cria novas e desativa as removidas
      // (nunca apaga — itens vendidos referenciam a apresentação).
      const existing = new Set(this.ctx.db.all<{ id: string }>('SELECT id FROM presentations WHERE product_id = ?', productId).map((r) => r.id));
      const kept = new Set<string>();
      input.presentations.forEach((pr, idx) => {
        const prId = pr.id && existing.has(pr.id) ? pr.id : this.ctx.id();
        kept.add(prId);
        if (existing.has(prId)) {
          this.ctx.db.run(
            'UPDATE presentations SET name=?, price_cents=?, menu_visible=?, active=?, sort_order=?, version=version+1, updated_at=? WHERE id=?',
            pr.name, pr.priceCents, pr.menuVisible, pr.active, pr.sortOrder || idx, now, prId,
          );
          this.ctx.db.run('DELETE FROM presentation_components WHERE presentation_id = ?', prId);
        } else {
          this.ctx.db.run(
            'INSERT INTO presentations (id, product_id, name, price_cents, menu_visible, active, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
            prId, productId, pr.name, pr.priceCents, pr.menuVisible, pr.active, pr.sortOrder || idx, now, now,
          );
        }
        const components = pr.components.length ? pr.components : [{ productId: null, qty: 1000 }];
        for (const c of components) {
          this.ctx.db.run(
            'INSERT INTO presentation_components (id, presentation_id, ingredient_product_id, qty) VALUES (?,?,?,?)',
            this.ctx.id(), prId, c.productId ?? productId, c.qty,
          );
        }
        if (pr.optionGroups) {
          const seen = new Set<string>();
          const own = pr.optionGroups.filter((l) => !seen.has(l.groupId) && seen.add(l.groupId));
          for (const l of own) if (!this.ctx.db.value('SELECT id FROM option_groups WHERE id = ?', l.groupId)) throw notFound('Escolha');
          this.ctx.db.run('DELETE FROM presentation_option_groups WHERE presentation_id = ?', prId);
          own.forEach((l, k) => this.ctx.db.run(
            'INSERT INTO presentation_option_groups (presentation_id, group_id, sort_order, quantity) VALUES (?,?,?,?)', prId, l.groupId, k, l.quantity,
          ));
        }
        if (pr.halves) {
          const parts = [...new Set(pr.halves)];
          if (parts.length === 1) throw badRequest(`O meio a meio "${pr.name}" precisa de ao menos duas porções para combinar.`, 'HALVES_MIN');
          for (const part of parts) {
            const ok = this.ctx.db.get(
              'SELECT pr.id FROM presentations pr WHERE pr.id = ? AND pr.id <> ? AND NOT EXISTS (SELECT 1 FROM presentation_halves h WHERE h.presentation_id = pr.id)',
              part, prId,
            );
            if (!ok) throw badRequest(`Uma das porções do meio a meio "${pr.name}" não existe mais (ou também é meio a meio).`, 'HALVES_INVALID');
          }
          this.ctx.db.run('DELETE FROM presentation_halves WHERE presentation_id = ?', prId);
          parts.forEach((part, k) => this.ctx.db.run(
            'INSERT INTO presentation_halves (presentation_id, part_presentation_id, sort_order) VALUES (?,?,?)', prId, part, k,
          ));
        }
      });
      for (const old of existing) {
        if (!kept.has(old)) this.ctx.db.run('UPDATE presentations SET active = 0, version=version+1, updated_at=? WHERE id = ?', now, old);
      }

      const links = input.optionGroups ?? input.optionGroupIds?.map((groupId) => ({ groupId, quantity: 1 }));
      if (links) {
        const seen = new Set<string>();
        const unique = links.filter((l) => !seen.has(l.groupId) && seen.add(l.groupId));
        for (const l of unique) if (!this.ctx.db.value('SELECT id FROM option_groups WHERE id = ?', l.groupId)) throw notFound('Escolha');
        this.ctx.db.run('DELETE FROM product_option_groups WHERE product_id = ?', productId);
        unique.forEach((l, i) => this.ctx.db.run(
          'INSERT INTO product_option_groups (product_id, group_id, sort_order, quantity) VALUES (?,?,?,?)', productId, l.groupId, i, l.quantity,
        ));
      }

      this.ctx.audit(actor, id ? 'products.updated' : 'products.created', 'product', productId, {
        name: input.name,
        internalCode: code,
        presentations: input.presentations.map((p) => ({ name: p.name, priceCents: p.priceCents })),
        ...(before && before.min_stock !== input.minStock ? { minStock: { from: before.min_stock, to: input.minStock } } : {}),
      });
      if (input.initialStock) {
        this.stock.purchase(actor, {
          supplierId: input.supplierId,
          notes: 'Estoque inicial no cadastro do produto',
          items: [{ productId, packageQty: input.packageQty, ...input.initialStock }],
        });
      }
      if (before && Number(before.min_stock) !== input.minStock) this.stock.evaluateAlert(productId);
      this.ctx.emit({ channel: 'stock', type: 'product.updated', data: { productId } });
    });
    return { id: productId, internalCode };
  }

  /** Tira o produto da venda (some do cardápio e das listas) ou devolve; o histórico fica. */
  setActive(actor: Actor, id: string, active: boolean) {
    requirePerm(actor, 'products.manage');
    return this.ctx.tx(() => {
      const p = this.ctx.db.get<{ name: string; active: number }>('SELECT name, active FROM products WHERE id = ? AND deleted_at IS NULL', id);
      if (!p) throw notFound('Produto');
      if (p.active !== (active ? 1 : 0)) {
        this.ctx.db.run('UPDATE products SET active = ?, version = version + 1, updated_at = ? WHERE id = ?', active ? 1 : 0, this.ctx.nowIso(), id);
        this.ctx.audit(actor, active ? 'products.activated' : 'products.deactivated', 'product', id, { name: p.name });
        this.ctx.emit({ channel: 'stock', type: 'product.updated', data: { productId: id } });
      }
      return { id, name: p.name, active };
    });
  }

  /**
   * Exclui o produto: some do cardápio, do estoque, das escolhas e do painel
   * online; vendas e movimentações antigas continuam com o nome. Código e
   * código de barras ficam livres para outro cadastro. Não exclui o que é
   * ingrediente ou item fixo de outro produto à venda (baixaria do excluído).
   */
  remove(actor: Actor, id: string) {
    requirePerm(actor, 'products.manage');
    return this.ctx.tx(() => {
      const p = this.ctx.db.get<{ name: string; stock_qty: number; stock_tracked: number }>(
        'SELECT name, stock_qty, stock_tracked FROM products WHERE id = ? AND deleted_at IS NULL',
        id,
      );
      if (!p) throw notFound('Produto');
      const usedBy = this.ctx.db.all<{ name: string }>(
        `SELECT DISTINCT p.name FROM presentation_components pc JOIN presentations pr ON pr.id = pc.presentation_id
         JOIN products p ON p.id = pr.product_id
         WHERE pc.ingredient_product_id = ? AND pr.product_id <> ? AND pr.active = 1 AND p.active = 1 AND p.deleted_at IS NULL ORDER BY p.name LIMIT 4`,
        id, id,
      );
      if (usedBy.length) {
        const names = usedBy.slice(0, 3).map((u) => u.name).join(', ') + (usedBy.length > 3 ? '…' : '');
        throw conflict(`${p.name} é ingrediente ou item de: ${names}. Tire de lá (ou exclua esses produtos) antes.`, 'PRODUCT_IN_USE', { products: usedBy.map((u) => u.name) });
      }
      const now = this.ctx.nowIso();
      this.ctx.db.run(
        `UPDATE products SET deleted_at = ?, active = 0, internal_code = NULL, barcode = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
        now, now, id,
      );
      this.ctx.db.run('UPDATE presentations SET active = 0, version = version + 1, updated_at = ? WHERE product_id = ? AND active = 1', now, id);
      // Opções que baixavam este produto (ex.: Red Bull no "Energético") saem das escolhas.
      this.ctx.db.run('UPDATE option_choices SET active = 0 WHERE ingredient_product_id = ? AND active = 1', id);
      this.ctx.db.run('DELETE FROM hookah_flavors WHERE product_id = ?', id);
      this.ctx.db.run("UPDATE stock_alerts SET status = 'resolved', resolved_at = ?, version = version + 1, updated_at = ? WHERE product_id = ? AND status = 'open'", now, now, id);
      this.ctx.audit(actor, 'products.deleted', 'product', id, { name: p.name, stockQty: p.stock_tracked ? p.stock_qty : null });
      this.ctx.emit({ channel: 'stock', type: 'product.updated', data: { productId: id } });
      this.ctx.emit({ channel: 'hookah', type: 'flavors.changed' });
      return { id, name: p.name };
    });
  }

  /** Prévia do próximo código automático (não reserva). */
  nextProductCode(actor: Actor) {
    requirePerm(actor, 'products.view');
    return { code: peekProductCode(this.ctx.db) };
  }

  setPhoto(actor: Actor, productId: string, attachmentId: string | null) {
    requirePerm(actor, 'products.manage');
    this.ctx.tx(() => {
      const r = this.ctx.db.run('UPDATE products SET photo_attachment_id=?, version=version+1, updated_at=? WHERE id=?', attachmentId, this.ctx.nowIso(), productId);
      if (!r.changes) throw notFound('Produto');
      this.ctx.audit(actor, 'products.photo', 'product', productId);
    });
  }
}
