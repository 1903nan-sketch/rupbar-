/**
 * Peças do estoque autoexplicativo: "Como você compra?", "Como você vende?",
 * campos de quantidade com alternância embalagem/unidade, frase de conferência
 * e exibição do saldo nas duas formas.
 */
import {
  buyModeOf, costPer, describeEntry, describeStock, entrySuggestion, fmtCount, formatBRL, isFemininePt, MILLI, packName,
  theoreticalYield, totalCostFrom, unitName, unitsPerPack, type BuyMode, type Measure, type Packaging, type SellMode, type StockLevel,
} from '@rupbar/core';
import { Boxes, CircleAlert, Leaf, Package, UtensilsCrossed, Wine, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import {
  BUY_MEASURE, cap, costModes, modeLabel, PACK_DEFAULTS, previewPackaging, priceLabel, qtyOf, sellModesFor,
  type CostDraft, type PackDraft, type QtyDraft, type SellDraft,
} from '../lib/stock-units';
import { Button, DecimalInput, Field, Input, MoneyInput } from './ui';

// ------------------------------------------------------------------ peças pequenas

const LEVEL_TEXT: Record<StockLevel, string> = { ok: 'OK', low: 'Baixo', out: 'Zerado', negative: 'Negativo' };
const LEVEL_TITLE: Record<StockLevel, string> = {
  ok: 'Saldo acima do mínimo',
  low: 'Saldo no mínimo ou abaixo: hora de repor',
  out: 'Sem saldo',
  negative: 'Saldo negativo: vendas sem entrada lançada',
};

/** Situação do saldo: OK / Baixo / Zerado / Negativo. */
export function LevelChip({ level }: { level: StockLevel }) {
  return <span className={`status-chip ${level}`} title={LEVEL_TITLE[level]}><span className="status-dot" aria-hidden="true" />{LEVEL_TEXT[level]}</span>;
}

/** Código interno em destaque discreto: #0007. */
export function CodeTag({ code }: { code: string | null | undefined }) {
  if (!code) return null;
  return <span className="code-tag" title="Código interno do produto">#{code}</span>;
}

/** Saldo nas duas formas: "48 latas (4 fardos)" / "2,5 garrafas (2.500 ml)". */
export function StockQty({ qty, packaging, inline }: { qty: number; packaging: Packaging; inline?: boolean }) {
  const t = describeStock(qty, packaging);
  return (
    <span className={`stock-qty ${inline ? 'inline' : ''}`}>
      <span className="stock-qty-main">{t.main}</span>
      {t.detail && <span className="stock-qty-detail">({t.detail})</span>}
    </span>
  );
}

/** Alternância acessível (botões com aria-pressed) no visual de .segmented. */
export function ModeToggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented unit-toggle" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- quantidade

/**
 * Campo de quantidade com alternância "Fardos | Latas" (ou "Garrafas | ml").
 * Trocar o modo muda o significado do número digitado; a frase de conferência
 * mostra o resultado. Pergunta "Você quis dizer 2 fardos?" em enganos comuns.
 */
export function QtyEntry({ label, packaging, value, onChange, hint, autoFocus, placeholder, suggest = true }: {
  label: string; packaging: Packaging; value: QtyDraft; onChange: (v: QtyDraft) => void; hint?: ReactNode; autoFocus?: boolean; placeholder?: string; suggest?: boolean;
}) {
  const id = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const single = buyModeOf(packaging) === 'single';
  const suggestion = suggest ? entrySuggestion(value.amount, value.mode, packaging) : null;
  const key = `${value.amount}:${value.mode}:${packaging.packageQty}`;
  return (
    <div className="field qty-entry">
      <label htmlFor={id}>{label}</label>
      <div className="qty-entry-row">
        <DecimalInput id={id} value={value.amount} autoFocus={autoFocus} placeholder={placeholder ?? '0'} onChange={(amount) => onChange({ ...value, amount })} />
        {single
          ? <span className="qty-entry-unit">{modeLabel('unit', packaging)}</span>
          : <ModeToggle label={`${label}: contar em`} value={value.mode} onChange={(mode) => onChange({ ...value, mode })}
              options={[{ value: 'pack', label: modeLabel('pack', packaging) }, { value: 'unit', label: modeLabel('unit', packaging) }]} />}
      </div>
      {suggestion && dismissed !== key ? (
        <div className="entry-suggestion" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span className="grow">{suggestion.message}</span>
          <Button size="small" onClick={() => onChange({ ...value, mode: suggestion.mode })}>Sim, em {modeLabel(suggestion.mode, packaging).toLocaleLowerCase('pt-BR')}</Button>
          <Button size="small" variant="plain" onClick={() => setDismissed(key)}>Não, está certo</Button>
        </div>
      ) : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Custo da compra: por embalagem, por unidade solta ou o total pago. */
export function CostEntry({ label, packaging, value, onChange, hint }: { label: string; packaging: Packaging; value: CostDraft; onChange: (v: CostDraft) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field qty-entry">
      <label htmlFor={id}>{label}</label>
      <div className="qty-entry-row">
        <MoneyInput id={id} value={value.cents} onChange={(cents) => onChange({ ...value, cents })} />
        <ModeToggle label={`${label}: valor`} value={value.mode} options={costModes(packaging)} onChange={(mode) => onChange({ ...value, mode })} />
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Total pago, a partir do custo digitado no modo escolhido. */
export function totalCostOf(cost: CostDraft, qty: number, p: Packaging): number | null {
  return cost.cents === null ? null : totalCostFrom(cost.cents, cost.mode, qty, p);
}

export interface SaleRef {
  /** Quanto uma venda consome (ex.: 1 lata = 1000; dose = 50_000). */
  qty: number;
  priceCents: number;
  /** "lata", "dose de 50 ml". */
  label: string;
}

/**
 * Frase de conferência ao vivo:
 * "Você está lançando 2 fardos de 12 = 24 latas. Custo por lata: R$ 3,50".
 */
export function EntrySentence({ packaging, qty, cost, doseQty, sale, verb = 'lançando', empty = 'Digite a quantidade para ver a conta aqui.' }: {
  packaging: Packaging; qty: QtyDraft; cost?: CostDraft | null; doseQty?: number | null; sale?: SaleRef | null; verb?: string; empty?: string;
}) {
  const buy = buyModeOf(packaging);
  const mode = buy === 'single' ? 'unit' : qty.mode;
  const total = qtyOf(qty, packaging);
  if (!qty.amount || qty.amount <= 0 || total <= 0) return <div className="stock-entry-summary entry-sentence muted" aria-live="polite">{empty}</div>;
  const text = describeEntry(qty.amount, mode, packaging, doseQty);
  const totalCents = cost ? totalCostOf(cost, total, packaging) : null;
  const costs: ReactNode[] = [];
  if (totalCents !== null) {
    if (packaging.measure === 'unit') costs.push(<span key="u">Custo por {unitName(packaging, 1)}: <strong>{formatBRL(costPer(totalCents, total, MILLI)!)}</strong></span>);
    if (buy !== 'single') costs.push(<span key="p">por {packName(packaging, 1)}: <strong>{formatBRL(costPer(totalCents, total, packaging.packageQty)!)}</strong></span>);
    if (doseQty && packaging.measure !== 'unit') costs.push(<span key="d">por {packaging.measure === 'mass' ? 'porção' : 'dose'}: <strong>{formatBRL(costPer(totalCents, total, doseQty)!)}</strong></span>);
    costs.push(<span key="t">total: <strong>{formatBRL(totalCents)}</strong></span>);
  }
  const saleCost = totalCents !== null && sale ? costPer(totalCents, total, sale.qty) : null;
  return (
    <div className="stock-entry-summary entry-sentence" aria-live="polite">
      <p>Você está {verb} <strong>{text.lead}</strong>{text.equals.map((e) => <span key={e}> = <strong>{e}</strong></span>)}.</p>
      {costs.length > 0 && <p className="entry-costs">{costs.map((c, i) => <span key={i}>{i > 0 && ' · '}{i === 0 && packaging.measure !== 'unit' && 'Custo '}{c}</span>)}</p>}
      {saleCost !== null && sale && saleCost > sale.priceCents && (
        <p className="entry-warning" role="alert"><CircleAlert size={15} aria-hidden="true" /> O custo por {sale.label} ({formatBRL(saleCost)}) ficou maior que o preço de venda ({formatBRL(sale.priceCents)}). Confira se o valor é {costModes(packaging).map((m) => m.label.toLocaleLowerCase('pt-BR')).join(', ').replace(/, ([^,]*)$/, ' ou $1')}.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- contagem

/** Contagem física (inventário/ajuste): embalagens fechadas + o que está solto ou aberto. */
export function countLabels(p: Packaging): { closed: string | null; loose: string } {
  const buy = buyModeOf(p);
  if (buy === 'single') return { closed: null, loose: modeLabel('unit', p) };
  const pack = packName(p, 2);
  const fem = isFemininePt(packName(p, 1));
  const closed = `${cap(pack)} ${fem ? 'fechadas' : 'fechados'}`;
  if (p.measure === 'unit') {
    const unit = unitName(p, 2);
    return { closed, loose: `${cap(unit)} ${isFemininePt(unitName(p, 1)) ? 'soltas' : 'soltos'}` };
  }
  return { closed, loose: `${fem ? 'Na' : 'No'} ${packName(p, 1)} ${fem ? 'aberta' : 'aberto'} (${unitName(p)})` };
}

export function CountEntry({ packaging, closed, loose, onChange, autoFocus, context }: {
  packaging: Packaging; closed: number | null; loose: number | null; onChange: (closed: number | null, loose: number | null) => void; autoFocus?: boolean; context?: string;
}) {
  const labels = countLabels(packaging);
  const suffix = context ? ` — ${context}` : '';
  return (
    <div className="count-entry">
      {labels.closed && <Field label={<span>{labels.closed}<span className="sr-only">{suffix}</span></span>}><DecimalInput value={closed} autoFocus={autoFocus} placeholder="0" onChange={(v) => onChange(v, loose)} /></Field>}
      <Field label={<span>{labels.loose}<span className="sr-only">{suffix}</span></span>}><DecimalInput value={loose} autoFocus={autoFocus && !labels.closed} placeholder="0" onChange={(v) => onChange(closed, v)} /></Field>
    </div>
  );
}

// ------------------------------------------------------- como compra / vende

const BUY_OPTIONS: { value: BuyMode; title: string; hint: string; icon: LucideIcon }[] = [
  { value: 'single', title: 'Unidade avulsa', hint: 'Cada item é contado sozinho. Ex.: Coca 600 ml, maço de cigarro.', icon: Package },
  { value: 'pack', title: 'Fardo, caixa ou pacote com várias unidades', hint: 'Ex.: fardo com 12 latas. O estoque é contado em latas.', icon: Boxes },
  { value: 'bottle', title: 'Garrafa de X ml', hint: 'Destilados vendidos em dose. Ex.: whisky de 1.000 ml.', icon: Wine },
  { value: 'bag', title: 'Pacote de X g', hint: 'Essências e ingredientes. Ex.: essência de 50 g.', icon: Leaf },
];

const UNIT_SUGGESTIONS = ['lata', 'garrafa', 'long neck', 'unidade', 'maço', 'porção', 'copo'];
const PACK_SUGGESTIONS = ['fardo', 'caixa', 'pacote', 'engradado', 'display'];
const SIZE_CHIPS: Record<'bottle' | 'bag', number[]> = { bottle: [600, 700, 750, 1000], bag: [50, 100, 250, 1000] };

function Suggestions({ id, values }: { id: string; values: string[] }) {
  return <datalist id={id}>{values.map((v) => <option key={v} value={v} />)}</datalist>;
}

function QuickChips({ values, unit, current, onPick, label }: { values: number[]; unit: string; current: number | null; onPick: (v: number) => void; label: string }) {
  return (
    <div className="quick-chips" role="group" aria-label={label}>
      {values.map((v) => (
        <button key={v} type="button" className={`chip small ${current === v ? 'active' : ''}`} aria-pressed={current === v} onClick={() => onPick(v)}>
          {new Intl.NumberFormat('pt-BR').format(v)} {unit}
        </button>
      ))}
    </div>
  );
}

/**
 * "Como você compra este produto?" — define a embalagem (measure + packageQty)
 * em palavras. `lockedMeasure` impede trocar ml/g/unidade de um produto com saldo.
 */
export function BuyModePicker({ value, onChange, lockedMeasure }: { value: PackDraft; onChange: (d: PackDraft) => void; lockedMeasure?: Measure | null }) {
  const listId = useId();
  const preview = previewPackaging(value);
  const set = (patch: Partial<PackDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="stack buy-mode">
      <div className="buy-mode-options" role="group" aria-label="Como você compra este produto?">
        {BUY_OPTIONS.map((o) => {
          const Icon = o.icon;
          const locked = !!lockedMeasure && BUY_MEASURE[o.value] !== lockedMeasure;
          return (
            <button key={o.value} type="button" className={`product-kind ${value.buyMode === o.value ? 'active' : ''}`} aria-pressed={value.buyMode === o.value} disabled={locked}
              title={locked ? 'Zere o saldo com um ajuste para mudar entre unidade, ml e g.' : undefined}
              onClick={() => value.buyMode !== o.value && onChange({ ...PACK_DEFAULTS[o.value] })}>
              <Icon size={22} aria-hidden="true" /><strong>{o.title}</strong><span>{o.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="buy-mode-details">
        {value.buyMode === 'single' && (
          <Field label="Como você chama cada unidade?" hint="Aparece no estoque: “24 latas”, “10 maços”.">
            <Input list={`${listId}-u`} value={value.unitLabel} placeholder="lata, garrafa, maço…" onChange={(e) => set({ unitLabel: e.target.value })} />
          </Field>
        )}
        {value.buyMode === 'pack' && (
          <div className="grid-3">
            <Field label="Nome da embalagem" hint="fardo, caixa, pacote…"><Input list={`${listId}-p`} value={value.packageLabel} onChange={(e) => set({ packageLabel: e.target.value })} /></Field>
            <Field label="Quantas unidades vêm na embalagem?" hint="Ex.: 12 no fardo de latas."><DecimalInput value={value.perPack} onChange={(v) => set({ perPack: v })} placeholder="12" /></Field>
            <Field label="Nome de cada unidade" hint="lata, long neck, garrafa…"><Input list={`${listId}-u`} value={value.unitLabel} onChange={(e) => set({ unitLabel: e.target.value })} /></Field>
          </div>
        )}
        {(value.buyMode === 'bottle' || value.buyMode === 'bag') && (
          <div className="grid-2">
            <Field label={value.buyMode === 'bottle' ? 'Tamanho da garrafa (ml)' : 'Peso do pacote (g)'} hint={value.buyMode === 'bottle' ? '1 litro = 1.000 ml.' : '1 kg = 1.000 g.'}>
              <DecimalInput value={value.size} onChange={(v) => set({ size: v })} suffix={value.buyMode === 'bottle' ? 'ml' : 'g'} />
            </Field>
            <Field label="Nome da embalagem" hint={value.buyMode === 'bottle' ? 'garrafa, galão, barril…' : 'pacote, saco, pote…'}>
              <Input value={value.packageLabel} onChange={(e) => set({ packageLabel: e.target.value })} />
            </Field>
            <QuickChips label="Tamanhos comuns" values={SIZE_CHIPS[value.buyMode]} unit={value.buyMode === 'bottle' ? 'ml' : 'g'} current={value.size} onPick={(size) => set({ size })} />
          </div>
        )}
        <Suggestions id={`${listId}-u`} values={UNIT_SUGGESTIONS} />
        <Suggestions id={`${listId}-p`} values={PACK_SUGGESTIONS} />
      </div>
      <div className="pack-preview" aria-live="polite">
        {value.buyMode === 'single'
          ? <>O estoque será contado em <strong>{unitName(preview, 2)}</strong>.</>
          : <>1 {packName(preview, 1)} = <strong>{fmtCount(unitsPerPack(preview))} {unitName(preview, unitsPerPack(preview))}</strong>. O estoque mostra as duas formas.</>}
      </div>
    </div>
  );
}

const SELL_TEXT: Record<SellMode, (p: Packaging) => { title: string; hint: string }> = {
  unit: (p) => {
    if (buyModeOf(p) === 'single' || buyModeOf(p) === 'pack') return { title: 'Por unidade', hint: `Cada venda baixa 1 ${unitName(p, 1)}.` };
    const pack = packName(p, 1);
    const closed = `fechad${isFemininePt(pack) ? 'a' : 'o'}`;
    // Essência: o mesmo estoque vai por grama no narguilé e em pacote fechado no cardápio.
    if (p.measure === 'mass') return { title: `${cap(pack)} ${closed} + narguilé`, hint: `O cliente compra o ${pack} ${closed} no cardápio. O narguilé usa por grama, sem cobrar a essência.` };
    return { title: `${cap(pack)} inteir${isFemininePt(pack) ? 'a' : 'o'}`, hint: `Cada venda baixa 1 ${pack} ${closed}.` };
  },
  dose: (p) => p.measure === 'mass'
    ? { title: 'Por porção de X g', hint: 'Ex.: porção de 100 g.' }
    : { title: 'Por dose de X ml', hint: 'Ex.: dose de 50 ml.' },
  ingredient: (p) => p.measure === 'mass'
    ? { title: 'Só no narguilé ou em receitas', hint: 'Usado por grama, sem preço. Não aparece no cardápio.' }
    : { title: 'Como ingrediente de receita', hint: 'Drinks e porções. Não aparece no cardápio.' },
};

/** "Como você vende?" — cria a apresentação de venda do cadastro rápido. */
export function SellModePicker({ packaging, value, onChange }: { packaging: Packaging; value: SellDraft; onChange: (v: SellDraft) => void }) {
  const buy = buyModeOf(packaging);
  const modes = sellModesFor(buy);
  const doseQty = Math.round((value.dose ?? 0) * MILLI);
  const yieldN = value.mode === 'dose' && doseQty > 0 ? theoreticalYield(packaging.packageQty, doseQty) : 0;
  const unit = packaging.measure === 'mass' ? 'g' : 'ml';
  return (
    <div className="stack">
      <div className={`sell-mode-options cols-${modes.length}`} role="group" aria-label="Como você vende?">
        {modes.map((m) => {
          const t = SELL_TEXT[m](packaging);
          const Icon = m === 'ingredient' ? UtensilsCrossed : m === 'dose' ? Wine : Package;
          return (
            <button key={m} type="button" className={`product-kind compact ${value.mode === m ? 'active' : ''}`} aria-pressed={value.mode === m} onClick={() => onChange({ ...value, mode: m })}>
              <Icon size={18} aria-hidden="true" /><strong>{t.title}</strong><span>{t.hint}</span>
            </button>
          );
        })}
      </div>
      {value.mode !== 'ingredient' && (
        <div className={value.mode === 'dose' ? 'grid-2' : ''}>
          {value.mode === 'dose' && (
            <Field label={packaging.measure === 'mass' ? 'Tamanho da porção (g)' : 'Tamanho da dose (ml)'}
              hint={yieldN > 0 ? `1 ${packName(packaging, 1)} rende ${yieldN} ${yieldN === 1 ? (packaging.measure === 'mass' ? 'porção' : 'dose') : packaging.measure === 'mass' ? 'porções' : 'doses'}.` : undefined}>
              <DecimalInput value={value.dose} onChange={(dose) => onChange({ ...value, dose })} suffix={unit} />
            </Field>
          )}
          <Field label={priceLabel(value.mode, packaging)} hint="Preço de venda no cardápio (diferente do custo de compra).">
            <MoneyInput value={value.priceCents} onChange={(priceCents) => onChange({ ...value, priceCents })} />
          </Field>
        </div>
      )}
      {value.mode === 'ingredient' && <p className="small muted">Depois, use este produto na ficha técnica de drinks e porções (Produtos → Apresentações). O estoque baixa sozinho a cada venda.</p>}
    </div>
  );
}

/** Referência de venda (para alertar custo maior que o preço) a partir das apresentações do produto. */
export function saleRefOf(presentations: { priceCents: number; active: boolean; name: string; components: { isSelf: boolean; qty: number }[] }[], p: Packaging): SaleRef | null {
  const own = presentations
    .filter((pr) => pr.active && pr.components.length === 1 && pr.components[0]!.isSelf)
    .sort((a, b) => a.components[0]!.qty - b.components[0]!.qty)[0];
  if (!own) return null;
  const qty = own.components[0]!.qty;
  const label = p.measure === 'unit' && qty === MILLI ? unitName(p, 1) : own.name.toLocaleLowerCase('pt-BR');
  return { qty, priceCents: own.priceCents, label };
}
