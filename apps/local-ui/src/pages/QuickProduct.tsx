import { buyModeOf, describeStock, MILLI, type Packaging } from '@rupbar/core';
import { useState } from 'react';
import { OptionGroupsField } from '../components/OptionGroups';
import { BuyModePicker, CostEntry, EntrySentence, QtyEntry, SellModePicker, totalCostOf } from '../components/stock-units';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, Select, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useSession } from '../lib/session';
import {
  costModes, defaultCostMode, defaultSell, emptyQty, entryPayload, PACK_DEFAULTS, packagingFromDraft, presentationsFor, previewPackaging, qtyOf,
  type CostDraft, type PackDraft, type QtyDraft, type SellDraft,
} from '../lib/stock-units';
import '../styles/stock.css';
import type { Category } from './Products';

const plain = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Categoria "Insumos" que ainda não existe (bares cadastrados antes dela): criada ao salvar. */
const NEW_INSUMOS = '__insumos__';

/**
 * Cadastro e primeira entrada juntos, em perguntas simples:
 * o que é → como você compra → como você vende → quanto tem agora.
 * `ingredient`: insumo das fichas técnicas (batata, queijo, bacon), fora do cardápio,
 * com a quantidade em kg/L por padrão.
 */
export function QuickProductModal({ onClose, onSaved, ingredient = false }: { onClose: () => void; onSaved: (id: string) => void; ingredient?: boolean }) {
  const toast = useToast();
  const { can } = useSession();
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  const nextCode = useLoad(() => api.get<{ code: string }>('/api/products/next-code').catch(() => null));
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [code, setCode] = useState('');
  const [barcode, setBarcode] = useState('');
  const [pack, setPack] = useState<PackDraft>(ingredient ? { ...PACK_DEFAULTS.bag, size: 1000 } : PACK_DEFAULTS.single);
  const [sell, setSell] = useState<SellDraft>(ingredient ? { mode: 'ingredient', dose: null, priceCents: null } : defaultSell('single'));
  const packaging = previewPackaging(pack);
  // Insumo em g ou ml: digita direto em kg ou L (5 kg = 5.000 g).
  const startQty = (p: Packaging): QtyDraft => (ingredient && p.measure !== 'unit' ? { amount: null, mode: 'kilo' } : emptyQty(p));
  const startCost = (p: Packaging): CostDraft['mode'] => (ingredient && p.measure !== 'unit' && costModes(p).some((m) => m.value === 'kilo') ? 'kilo' : defaultCostMode(p));
  const [stock, setStock] = useState<QtyDraft>(startQty(packaging));
  const [cost, setCost] = useState<CostDraft>({ cents: null, mode: startCost(packaging) });
  const [min, setMin] = useState<QtyDraft>(startQty(packaging));
  const [optionGroupIds, setOptionGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const insumos = categories.data?.find((c) => /insum|ingredient/.test(plain(c.name)));
  const selectedCategory = categoryId || (ingredient ? insumos?.id ?? NEW_INSUMOS : '') || categories.data?.[0]?.id || '';
  const qty = qtyOf(stock, packaging);
  const minQty = qtyOf(min, packaging);
  const totalCost = totalCostOf(cost, qty, packaging);
  const dose = sell.mode === 'dose' && sell.dose ? Math.round(sell.dose * MILLI) : null;
  // Essência: o narguilé só oferece como sabor os produtos da categoria Essências (ou com "essência" no nome).
  const categoryName = categories.data?.find((c) => c.id === selectedCategory)?.name ?? '';
  const essenceCategory = categories.data?.find((c) => /essenc/.test(plain(c.name)));
  const looksEssence = /essenc|ziggy|zomo|adalya|narguil/.test(plain(name));
  const hookahHint = !ingredient && packaging.measure === 'mass' && sell.mode !== 'dose' && !/essenc|narguil|tabac|fumo/.test(plain(categoryName)) && !/essenc/.test(plain(name));

  const changePack = (next: PackDraft) => {
    if (next.buyMode !== pack.buyMode) {
      // Novo jeito de comprar: modos e venda voltam ao padrão mais comum daquele tipo.
      const p = previewPackaging(next);
      if (!ingredient) setSell(defaultSell(next.buyMode));
      setStock({ ...startQty(p), amount: stock.amount });
      setMin({ ...startQty(p), amount: min.amount });
      setCost({ ...cost, mode: startCost(p) });
    }
    setPack(next);
  };

  const submit = async () => {
    if (busy) return;
    if (name.trim().length < 2 || !selectedCategory) return toast.error('Informe o nome e a categoria do produto.');
    const pk = packagingFromDraft(pack);
    if (!pk.ok) return toast.error(pk.error);
    const pres = presentationsFor(sell, pk.value);
    if (!pres.ok) return toast.error(pres.error);
    if (min.amount !== null && min.amount < 0) return toast.error('O estoque mínimo não pode ser negativo.');
    const withStock = can('stock.entry') && (stock.amount ?? 0) > 0;
    const doseOnly = sell.mode === 'dose' && pres.value.length > 1;
    if (stock.amount !== null && (stock.amount < 0 || (stock.amount > 0 && qty <= 0) || (stock.mode === 'pack' && stock.amount > 100_000))) {
      return toast.error('Confira a quantidade em estoque.');
    }
    if (withStock && (totalCost === null || totalCost < 0)) return toast.error('Informe quanto você pagou. Use zero somente se não houve custo.');
    setBusy(true);
    try {
      let categoryId = selectedCategory;
      if (categoryId === NEW_INSUMOS) {
        categoryId = (await api.post<{ id: string }>('/api/categories', { name: 'Insumos', station: 'none', icon: 'carrot' })).id;
        // Se o cadastro abaixo falhar, tentar de novo usa a categoria já criada.
        setCategoryId(categoryId);
        void categories.reload();
      }
      const result = await api.post<{ id: string; internalCode: string | null }>('/api/products', {
        name: name.trim(), categoryId, internalCode: code.trim() || null, barcode: barcode.trim() || null,
        measure: pk.value.measure, packageQty: pk.value.packageQty, packageLabel: pk.value.packageLabel, unitLabel: pk.value.unitLabel,
        stockTracked: true, minStock: minQty, menuVisible: sell.mode !== 'ingredient',
        // Dose + garrafa fechada: as escolhas (energético, gelo) ficam só na dose; a garrafa sai sem perguntar.
        presentations: doseOnly ? pres.value.map((p, i) => (i === 0 ? { ...p, optionGroups: optionGroupIds.map((groupId) => ({ groupId })) } : p)) : pres.value,
        optionGroupIds: sell.mode !== 'ingredient' && !doseOnly ? optionGroupIds : [],
        initialStock: withStock ? { ...entryPayload(stock, pk.value), totalCostCents: totalCost } : undefined,
      });
      const codeText = result.internalCode ? ` (código ${result.internalCode})` : '';
      const what = ingredient ? 'Insumo' : 'Produto';
      toast.success(withStock ? `${what}${codeText} e saldo inicial cadastrados` : `${what}${codeText} cadastrado`);
      onSaved(result.id);
      onClose();
    } catch (error) { toast.error(error); }
    finally { setBusy(false); }
  };

  const minText = minQty > 0 ? describeStock(minQty, packaging) : null;

  const stockStep = (
    <Card title={<h3><span className="step-number">{ingredient ? 3 : 4}</span>Quanto tem agora?</h3>} className="form-section">
      <div className="stack">
        {can('stock.entry') && <>
          <QtyEntry label="Quantidade em estoque agora" packaging={packaging} value={stock} onChange={setStock}
            hint={buyModeOf(packaging) === 'single' ? 'Opcional. Deixe em branco para cadastrar sem saldo.' : packaging.measure === 'unit' ? 'Opcional. Escolha se está contando embalagens fechadas ou unidades soltas.' : `Opcional. Pode digitar em ${packaging.measure === 'mass' ? 'kg (5 kg = 5.000 g)' : 'litros (2 L = 2.000 ml)'}, na unidade solta ou em embalagens.`} />
          <CostEntry label="Quanto você pagou?" packaging={packaging} value={cost} onChange={setCost} hint="Custo de compra (não é o preço de venda)." />
          <EntrySentence packaging={packaging} qty={stock} cost={cost} doseQty={dose} verb="cadastrando" empty="Sem saldo inicial: o produto começa zerado." />
        </>}
        <QtyEntry label="Estoque mínimo" packaging={packaging} value={min} onChange={setMin} suggest={false}
          hint={minText ? `Avisamos quando ficar em ${minText.main}${minText.detail ? ` (${minText.detail})` : ''} ou menos.` : 'Opcional. Avisa quando chegar neste nível.'} />
        <p className="tiny muted">{ingredient ? 'O saldo inicial vira uma entrada no histórico. Cada venda de um prato baixa o insumo pela ficha técnica.' : 'O saldo inicial vira uma entrada no histórico. As vendas baixam o estoque sozinhas.'}</p>
      </div>
    </Card>
  );

  return <Modal title={ingredient ? 'Novo insumo' : 'Novo produto'} wide onClose={onClose} footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!categories.data} onClick={submit}>{ingredient ? 'Cadastrar insumo' : 'Cadastrar produto'}</Button></>}>
    {categories.error ? <ErrorBox error={categories.error} onRetry={categories.reload} /> : !categories.data ? <Loading /> : <div className="stack quick-product">
      <p className="muted small">{ingredient
        ? 'Insumo é o que entra nos pratos: batata, queijo, bacon, pão. Ele tem estoque, não aparece no cardápio e cada prato vendido baixa a quantidade da ficha técnica.'
        : 'Responda algumas perguntas simples. Fotos, fornecedor e outras apresentações você ajusta depois, abrindo o produto.'}</p>

      <Card title={<h3><span className="step-number">1</span>O que você está cadastrando?</h3>} className="form-section">
        <div className="grid-2">
          <Field label={ingredient ? 'Nome do insumo' : 'Nome do produto'}><Input autoFocus placeholder={ingredient ? 'Ex.: Batata congelada' : 'Ex.: Heineken lata 350 ml'} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Categoria"><Select value={selectedCategory} onChange={(e) => setCategoryId(e.target.value)}>
            {ingredient && !insumos && <option value={NEW_INSUMOS}>Insumos (nova)</option>}
            {categories.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></Field>
        </div>
        {hookahHint && essenceCategory && (looksEssence || sell.mode === 'unit') && (
          <div className="banner small" style={{ marginTop: 10 }}>
            <span className="grow">É essência de narguilé? Na categoria <strong>{essenceCategory.name}</strong> o mesmo produto vende o pacote fechado no cardápio e aparece como sabor no rosh, baixando por grama do mesmo estoque.</span>
            <Button size="small" onClick={() => setCategoryId(essenceCategory.id)}>Usar {essenceCategory.name}</Button>
          </div>
        )}
        <details className="optional-fields" style={{ marginTop: 14 }}>
          <summary>Código interno e código de barras (opcional)</summary>
          <div className="grid-2">
            <Field label="Código interno" hint={`Em branco: o sistema gera o próximo número${nextCode.data ? ` (${nextCode.data.code})` : ''}.`}>
              <Input value={code} placeholder={nextCode.data ? `Automático: ${nextCode.data.code}` : 'Automático'} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label="Código de barras" hint="Clique aqui e bipe o produto com o leitor."><Input inputMode="numeric" data-barcode="field" value={barcode} onChange={(e) => setBarcode(e.target.value)} /></Field>
          </div>
        </details>
      </Card>

      <Card title={<h3><span className="step-number">2</span>Como você compra este produto?</h3>} className="form-section">
        <BuyModePicker value={pack} onChange={changePack} />
      </Card>

      {ingredient ? stockStep : (
        <div className="grid-2">
          <Card title={<h3><span className="step-number">3</span>Como você vende?</h3>} className="form-section">
            <SellModePicker packaging={packaging} value={sell} onChange={setSell} />
          </Card>
          {stockStep}
        </div>
      )}

      {sell.mode !== 'ingredient' && (
        <Card title={<h3><span className="step-number">5</span>Tem escolhas no pedido? <span className="muted small">(opcional)</span></h3>} className="form-section">
          <OptionGroupsField value={optionGroupIds} onChange={setOptionGroupIds}
            example={sell.mode === 'dose' && sell.wholePriceCents ? 'As escolhas valem para a dose (ex.: energético e gelo); a garrafa fechada sai sem perguntar. Para garrafa com gelo e energético, use Produtos → Novo combo.' : undefined} />
        </Card>
      )}
    </div>}
  </Modal>;
}
