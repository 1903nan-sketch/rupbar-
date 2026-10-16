import { buyModeOf, describeStock, MILLI } from '@rupbar/core';
import { useState } from 'react';
import { BuyModePicker, CostEntry, EntrySentence, QtyEntry, SellModePicker, totalCostOf } from '../components/stock-units';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, Select, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useSession } from '../lib/session';
import {
  defaultCostMode, defaultSell, emptyQty, entryPayload, PACK_DEFAULTS, packagingFromDraft, presentationsFor, previewPackaging, qtyOf,
  type CostDraft, type PackDraft, type QtyDraft, type SellDraft,
} from '../lib/stock-units';
import '../styles/stock.css';
import type { Category } from './Products';

/**
 * Cadastro e primeira entrada juntos, em perguntas simples:
 * o que é → como você compra → como você vende → quanto tem agora.
 */
export function QuickProductModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const { can } = useSession();
  const categories = useLoad(() => api.get<Category[]>('/api/categories'));
  const nextCode = useLoad(() => api.get<{ code: string }>('/api/products/next-code').catch(() => null));
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [code, setCode] = useState('');
  const [barcode, setBarcode] = useState('');
  const [pack, setPack] = useState<PackDraft>(PACK_DEFAULTS.single);
  const [sell, setSell] = useState<SellDraft>(defaultSell('single'));
  const packaging = previewPackaging(pack);
  const [stock, setStock] = useState<QtyDraft>(emptyQty(packaging));
  const [cost, setCost] = useState<CostDraft>({ cents: null, mode: defaultCostMode(packaging) });
  const [min, setMin] = useState<QtyDraft>(emptyQty(packaging));
  const [busy, setBusy] = useState(false);
  const selectedCategory = categoryId || categories.data?.[0]?.id || '';
  const qty = qtyOf(stock, packaging);
  const minQty = qtyOf(min, packaging);
  const totalCost = totalCostOf(cost, qty, packaging);
  const dose = sell.mode === 'dose' && sell.dose ? Math.round(sell.dose * MILLI) : null;

  const changePack = (next: PackDraft) => {
    if (next.buyMode !== pack.buyMode) {
      // Novo jeito de comprar: modos e venda voltam ao padrão mais comum daquele tipo.
      const p = previewPackaging(next);
      setSell(defaultSell(next.buyMode));
      setStock({ ...emptyQty(p), amount: stock.amount });
      setMin({ ...emptyQty(p), amount: min.amount });
      setCost({ ...cost, mode: defaultCostMode(p) });
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
    if (stock.amount !== null && (stock.amount < 0 || (stock.amount > 0 && qty <= 0) || (stock.mode === 'pack' && stock.amount > 100_000))) {
      return toast.error('Confira a quantidade em estoque.');
    }
    if (withStock && (totalCost === null || totalCost < 0)) return toast.error('Informe quanto você pagou. Use zero somente se não houve custo.');
    setBusy(true);
    try {
      const result = await api.post<{ id: string; internalCode: string | null }>('/api/products', {
        name: name.trim(), categoryId: selectedCategory, internalCode: code.trim() || null, barcode: barcode.trim() || null,
        measure: pk.value.measure, packageQty: pk.value.packageQty, packageLabel: pk.value.packageLabel, unitLabel: pk.value.unitLabel,
        stockTracked: true, minStock: minQty, menuVisible: sell.mode !== 'ingredient', presentations: pres.value,
        initialStock: withStock ? { ...entryPayload(stock, pk.value), totalCostCents: totalCost } : undefined,
      });
      const codeText = result.internalCode ? ` (código ${result.internalCode})` : '';
      toast.success(withStock ? `Produto${codeText} e saldo inicial cadastrados` : `Produto${codeText} cadastrado`);
      onSaved(result.id);
      onClose();
    } catch (error) { toast.error(error); }
    finally { setBusy(false); }
  };

  const minText = minQty > 0 ? describeStock(minQty, packaging) : null;

  return <Modal title="Novo produto" wide onClose={onClose} footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!categories.data?.length} onClick={submit}>Cadastrar produto</Button></>}>
    {categories.error ? <ErrorBox error={categories.error} onRetry={categories.reload} /> : !categories.data ? <Loading /> : <div className="stack quick-product">
      <p className="muted small">Responda quatro perguntas simples. Fotos, fornecedor e outras apresentações você ajusta depois, abrindo o produto.</p>

      <Card title={<h3><span className="step-number">1</span>O que você está cadastrando?</h3>} className="form-section">
        <div className="grid-2">
          <Field label="Nome do produto"><Input autoFocus placeholder="Ex.: Heineken lata 350 ml" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Categoria"><Select value={selectedCategory} onChange={(e) => setCategoryId(e.target.value)}>{categories.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        </div>
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

      <div className="grid-2">
        <Card title={<h3><span className="step-number">3</span>Como você vende?</h3>} className="form-section">
          <SellModePicker packaging={packaging} value={sell} onChange={setSell} />
        </Card>
        <Card title={<h3><span className="step-number">4</span>Quanto tem agora?</h3>} className="form-section">
          <div className="stack">
            {can('stock.entry') && <>
              <QtyEntry label="Quantidade em estoque agora" packaging={packaging} value={stock} onChange={setStock}
                hint={buyModeOf(packaging) === 'single' ? 'Opcional. Deixe em branco para cadastrar sem saldo.' : 'Opcional. Escolha se está contando embalagens fechadas ou unidades soltas.'} />
              <CostEntry label="Quanto você pagou?" packaging={packaging} value={cost} onChange={setCost} hint="Custo de compra (não é o preço de venda)." />
              <EntrySentence packaging={packaging} qty={stock} cost={cost} doseQty={dose} verb="cadastrando" empty="Sem saldo inicial: o produto começa zerado." />
            </>}
            <QtyEntry label="Estoque mínimo" packaging={packaging} value={min} onChange={setMin} suggest={false}
              hint={minText ? `Avisamos quando ficar em ${minText.main}${minText.detail ? ` (${minText.detail})` : ''} ou menos.` : 'Opcional. Avisa quando chegar neste nível.'} />
            <p className="tiny muted">O saldo inicial vira uma entrada no histórico. As vendas baixam o estoque sozinhas.</p>
          </div>
        </Card>
      </div>
    </div>}
  </Modal>;
}
