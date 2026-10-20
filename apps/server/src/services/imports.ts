import {
  csvRecords, DEFAULT_CATEGORIES, describePack, importNameKey, mapImportRecord, productCodeKey, stockText, unitCostFromPurchase,
  type ImportRow, type Measure, type Packaging, type Station,
} from '@rupbar/core';
import { stockImportSchema } from '@rupbar/core/schemas';
import { bool, type Row } from '../db/db';
import { AppError, badRequest } from '../lib/errors';
import type { CatalogService } from './catalog';
import { requirePerm, type Actor, type Ctx } from './context';
import type { StockService } from './stock';

export interface ImportPreviewItem {
  line: number;
  name: string;
  action: 'create' | 'update' | 'error';
  error: string | null;
  /** Produto já cadastrado que esta linha atualiza. */
  productId: string | null;
  existingName: string | null;
  matchedBy: 'barcode' | 'code' | 'name' | null;
  category: string | null;
  newCategory: boolean;
  /** "fardo de 24 long necks", "garrafa de 1.000 ml". */
  pack: string | null;
  /** Saldo contado e o que está no sistema hoje (só para os já cadastrados). */
  stock: string | null;
  stockBefore: string | null;
  packageCostCents: number | null;
  presentations: { name: string; priceCents: number }[];
  warnings: string[];
}

interface Planned {
  item: ImportPreviewItem;
  row: ImportRow | null;
}

const MAX_ROWS = 2000;
const NOTES = 'Importação de planilha';

const packagingOf = (p: Row): Packaging => ({
  measure: p.measure as Measure, packageQty: Number(p.package_qty), packageLabel: p.package_label as string | null, unitLabel: p.unit_label as string | null,
});

/** Categoria nova: usa a estação das padrão (Cervejas → bar) ou adivinha pelo nome. */
function stationFor(name: string): { station: Station; icon: string | null } {
  const known = DEFAULT_CATEGORIES.find((c) => importNameKey(c.name) === importNameKey(name));
  if (known) return { station: known.station, icon: known.icon };
  const key = importNameKey(name);
  if (/porc|comida|lanche|refeic|petisc|cozinha|salgad/.test(key)) return { station: 'kitchen', icon: 'utensils' };
  if (/cervej|chopp|drink|dose|destil|bebida|refri|agua|energ|suco|gin|vodka|whisk|vinho|caipi|bar/.test(key)) return { station: 'bar', icon: null };
  return { station: 'none', icon: null };
}

/**
 * Importa a contagem do estoque e o cadastro dos produtos de uma planilha.
 * Primeiro confere (prévia linha a linha); ao confirmar, grava tudo numa
 * transação: produtos novos com saldo inicial e um inventário com a contagem
 * dos que já existiam.
 */
export class ImportService {
  constructor(
    private readonly ctx: Ctx,
    private readonly catalog: CatalogService,
    private readonly stock: StockService,
  ) {}

  products(actor: Actor, raw: unknown) {
    requirePerm(actor, 'products.manage', 'stock.entry', 'stock.adjust');
    const input = stockImportSchema.parse(raw);
    const plan = this.plan(input.csv);
    const items = plan.map((p) => p.item);
    const summary = {
      items,
      total: items.length,
      create: items.filter((i) => i.action === 'create').length,
      update: items.filter((i) => i.action === 'update').length,
      errors: items.filter((i) => i.action === 'error').length,
      newCategories: [...new Set(items.filter((i) => i.action === 'create' && i.newCategory).map((i) => i.category!))],
    };
    if (!input.commit) return { committed: false, ...summary };
    if (!summary.create && !summary.update) throw badRequest('Nenhuma linha válida para importar. Corrija os erros da planilha.', 'IMPORT_EMPTY');
    const result = this.ctx.tx(() => this.apply(actor, plan));
    return { committed: true, ...summary, ...result };
  }

  private plan(csv: string): Planned[] {
    const { records, columns } = csvRecords(csv);
    if (!columns.includes('nome')) throw badRequest('Não achei a coluna "nome". Use o modelo da planilha (botão "Baixar modelo").', 'IMPORT_NO_NAME');
    if (!records.length) throw badRequest('A planilha não tem nenhum produto abaixo do cabeçalho.', 'IMPORT_EMPTY');
    if (records.length > MAX_ROWS) throw badRequest(`A planilha tem ${records.length} linhas; importe no máximo ${MAX_ROWS} por vez.`, 'IMPORT_TOO_BIG');

    const products = this.ctx.db.all(
      'SELECT id, name, internal_code, barcode, measure, package_qty, package_label, unit_label, stock_qty, stock_tracked, active FROM products',
    );
    const byBarcode = new Map(products.filter((p) => p.barcode).map((p) => [String(p.barcode), p]));
    const byCode = new Map(products.filter((p) => p.internal_code).map((p) => [productCodeKey(String(p.internal_code)), p]));
    const byName = new Map(products.filter((p) => bool(p.active)).map((p) => [importNameKey(String(p.name)), p]));
    const categories = new Set(this.ctx.db.all<{ name: string }>('SELECT name FROM categories').map((c) => importNameKey(c.name)));
    const seen = new Map<string, number>();

    return records.map((rec, i): Planned => {
      const line = i + 2;
      const base: ImportPreviewItem = {
        line, name: (rec.nome ?? '').trim(), action: 'error', error: null, productId: null, existingName: null, matchedBy: null, category: null,
        newCategory: false, pack: null, stock: null, stockBefore: null, packageCostCents: null, presentations: [], warnings: [],
      };
      const fail = (error: string): Planned => ({ item: { ...base, error }, row: null });
      const mapped = mapImportRecord(rec, line);
      if (!mapped.ok) return fail(mapped.error);
      const row = mapped.row;

      // A mesma linha duas vezes somaria a contagem errado: só vale a primeira.
      for (const key of [`n:${importNameKey(row.name)}`, row.barcode && `b:${row.barcode}`, row.code && `c:${productCodeKey(row.code)}`]) {
        if (!key) continue;
        const first = seen.get(key);
        if (first) return fail(`Repetido na planilha (linha ${first}). Junte as quantidades numa linha só.`);
        seen.set(key, line);
      }

      const [match, matchedBy] = row.barcode && byBarcode.has(row.barcode)
        ? [byBarcode.get(row.barcode)!, 'barcode' as const]
        : row.code && byCode.has(productCodeKey(row.code))
          ? [byCode.get(productCodeKey(row.code))!, 'code' as const]
          : byName.has(importNameKey(row.name))
            ? [byName.get(importNameKey(row.name))!, 'name' as const]
            : [null, null];
      const item: ImportPreviewItem = {
        ...base, name: row.name, packageCostCents: row.packageCostCents, warnings: [...row.warnings],
        presentations: row.presentations.map((p) => ({ name: p.name, priceCents: p.priceCents })),
      };

      if (match) {
        const what = matchedBy === 'barcode' ? 'código de barras' : 'código';
        if (!bool(match.active)) return fail(`O ${what} é do produto desativado "${match.name}". Reative-o no cadastro ou tire o ${what} da planilha.`);
        const packaging = packagingOf(match);
        if (match.measure !== row.measure) {
          return fail(`"${match.name}" já está cadastrado como ${describePack(packaging)}. Na coluna como_compra use o mesmo tipo.`);
        }
        if (!bool(match.stock_tracked)) return fail(`"${match.name}" está cadastrado sem controle de estoque.`);
        const warnings = item.warnings.filter((w) => !w.startsWith('Sem preço'));
        if (row.presentations.length) warnings.push('Já cadastrado: atualiza estoque, custo e mínimo. Os preços continuam os do sistema.');
        return {
          row,
          item: {
            ...item, action: 'update', productId: String(match.id), existingName: String(match.name), matchedBy, warnings,
            pack: describePack(packaging),
            stock: row.stockQty === null ? null : stockText(row.stockQty, packaging),
            stockBefore: stockText(Number(match.stock_qty), packaging),
          },
        };
      }

      const category = row.category ?? 'Outros';
      const packaging: Packaging = { measure: row.measure, packageQty: row.packageQty, packageLabel: row.packageLabel, unitLabel: row.unitLabel };
      if (row.stockQty !== null && row.stockQty > 0 && row.packageCostCents === null) item.warnings.push('Sem custo: o lucro deste produto fica sem custo até a próxima entrada.');
      return {
        row,
        item: {
          ...item, action: 'create', category, newCategory: !categories.has(importNameKey(category)),
          pack: describePack(packaging), stock: row.stockQty === null ? null : stockText(row.stockQty, packaging),
        },
      };
    });
  }

  private apply(actor: Actor, plan: Planned[]) {
    const categoryIds = new Map(this.ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM categories').map((c) => [importNameKey(c.name), c.id]));
    const categoriesCreated: string[] = [];
    const categoryId = (name: string) => {
      const key = importNameKey(name);
      let id = categoryIds.get(key);
      if (!id) {
        const { station, icon } = stationFor(name);
        id = this.catalog.createCategory(actor, { name, station, icon, sortOrder: 50 }).id;
        categoryIds.set(key, id);
        categoriesCreated.push(name);
      }
      return id;
    };
    // Erros com a linha da planilha, para o dono achar o que corrigir.
    const atLine = <T>(line: number, name: string, fn: () => T): T => {
      try {
        return fn();
      } catch (err) {
        const message = `Linha ${line} (${name}): ${(err as Error).message}`;
        if (err instanceof AppError) throw new AppError(err.status, err.code, message, err.details);
        throw new Error(message);
      }
    };

    let created = 0;
    const counted: { productId: string; countedQty: number }[] = [];
    const minChanged: string[] = [];
    const now = this.ctx.nowIso();
    for (const { item, row } of plan) {
      if (!row || item.action === 'error') continue;
      atLine(row.line, row.name, () => {
        const cost = row.packageCostCents;
        if (item.action === 'create') {
          const stock = row.stockQty ?? 0;
          this.catalog.saveProduct(actor, null, {
            name: row.name, categoryId: categoryId(item.category!), internalCode: row.code, barcode: row.barcode,
            measure: row.measure, packageQty: row.packageQty, packageLabel: row.packageLabel, unitLabel: row.unitLabel,
            stockTracked: true, minStock: row.minStock ?? 0, menuVisible: row.presentations.length > 0,
            unitCostE4: cost !== null && stock === 0 ? unitCostFromPurchase(cost, row.packageQty) : undefined,
            presentations: row.presentations.map((p, i) => ({ name: p.name, priceCents: p.priceCents, sortOrder: i, components: [{ productId: null, qty: p.qty }] })),
            initialStock: stock > 0 ? { qty: stock, totalCostCents: cost === null ? 0 : Math.round((cost * stock) / row.packageQty) } : undefined,
          });
          created++;
          return;
        }
        const id = item.productId!;
        const p = this.ctx.db.get('SELECT barcode, min_stock FROM products WHERE id = ?', id)!;
        // Custo antes da contagem: as diferenças do inventário saem pelo custo novo.
        if (cost !== null) {
          this.ctx.db.run('UPDATE products SET unit_cost_e4=?, version=version+1, updated_at=? WHERE id=?', unitCostFromPurchase(cost, row.packageQty), now, id);
        }
        if (row.minStock !== null && Number(p.min_stock) !== row.minStock) {
          this.ctx.db.run('UPDATE products SET min_stock=?, version=version+1, updated_at=? WHERE id=?', row.minStock, now, id);
          minChanged.push(id);
        }
        if (row.barcode && !p.barcode) this.ctx.db.run('UPDATE products SET barcode=?, version=version+1, updated_at=? WHERE id=?', row.barcode, now, id);
        if (row.stockQty !== null) counted.push({ productId: id, countedQty: row.stockQty });
        this.ctx.emit({ channel: 'stock', type: 'product.updated', data: { productId: id } });
      });
    }
    const inventory = counted.length ? this.stock.inventory(actor, { notes: NOTES, items: counted }) : null;
    for (const id of minChanged) this.stock.evaluateAlert(id);
    const updated = plan.filter((p) => p.row && p.item.action === 'update').length;
    this.ctx.audit(actor, 'stock.imported', 'inventory', inventory?.id ?? null, { created, updated, categoriesCreated });
    return {
      created, updated, categoriesCreated, inventoryId: inventory?.id ?? null,
      divergences: inventory?.items.filter((i) => i.diff !== 0).length ?? 0,
    };
  }
}
