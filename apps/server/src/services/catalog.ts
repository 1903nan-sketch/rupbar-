import { DEFAULT_CATEGORIES, entryQtyMilli, packageBreakdown, stockLevel, theoreticalYield, type Measure } from '@rupbar/core';
import { categorySchema, productSchema, supplierSchema, type ProductInput } from '@rupbar/core/schemas';
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
    };
  }

  products(actor: Actor, filter: { q?: string; categoryId?: string; includeInactive?: boolean } = {}) {
    requirePerm(actor, 'products.view');
    const where: string[] = [];
    const params: string[] = [];
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
    const items = this.ctx.db
      .all(
        `SELECT pr.id AS presentation_id, pr.name AS presentation_name, pr.price_cents, p.id AS product_id, p.name AS product_name,
                p.description, p.photo_attachment_id, p.category_id, COALESCE(p.station, c.station) AS station
         FROM presentations pr JOIN products p ON p.id = pr.product_id JOIN categories c ON c.id = p.category_id
         WHERE pr.active = 1 AND pr.menu_visible = 1 AND p.active = 1 AND p.menu_visible = 1 AND c.active = 1
         ORDER BY c.sort_order, p.name, pr.sort_order, pr.price_cents`,
      )
      .map((r) => {
        const components = this.componentsOf(String(r.presentation_id), String(r.product_id));
        const available = this.availability(components);
        return {
          presentationId: r.presentation_id, presentationName: r.presentation_name, priceCents: r.price_cents,
          productId: r.product_id, productName: r.product_name, description: r.description,
          photoUrl: attachmentUrl(r.photo_attachment_id as string | null), categoryId: r.category_id, station: r.station,
          available, soldOut: available === 0,
        };
      });
    return { categories, items };
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
      });
      for (const old of existing) {
        if (!kept.has(old)) this.ctx.db.run('UPDATE presentations SET active = 0, version=version+1, updated_at=? WHERE id = ?', now, old);
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
