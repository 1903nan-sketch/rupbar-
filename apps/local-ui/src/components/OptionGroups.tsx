import { ArrowUp, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import { useLoad } from '../lib/hooks';
import '../styles/menu.css';
import { Badge, Button, DecimalInput, Field, Input, Loading, MoneyInput, Select, Switch, useToast } from './ui';

type Measure = 'unit' | 'volume' | 'mass';

export interface OptionGroupView {
  id: string;
  name: string;
  required: boolean;
  active: boolean;
  choices: { id: string; name: string; priceDeltaCents: number; productId: string | null; productName: string | null; measure: Measure | null; qty: number; soldOut: boolean }[];
  products: { id: string; name: string }[];
}

interface StockProduct {
  id: string;
  name: string;
  measure: Measure;
  stockTracked: boolean;
  active: boolean;
}

const UNIT: Record<Measure, string> = { unit: 'un', volume: 'ml', mass: 'g' };
/** Quanto costuma sair por dose: 1 lata, 50 ml, 10 g. */
const DEFAULT_QTY: Record<Measure, number> = { unit: 1, volume: 50, mass: 10 };

interface ChoiceDraft {
  id?: string;
  name: string;
  priceDeltaCents: number | null;
  productId: string;
  qty: number | null;
}

const choiceText = (c: OptionGroupView['choices'][number]) => `${c.name}${c.priceDeltaCents > 0 ? ` +${formatBRL(c.priceDeltaCents)}` : ''}`;

/**
 * Escolhas pedidas ao lançar o produto (ex.: dose de gin → energético e gelo).
 * Cada opção tem o seu preço a mais e pode baixar um produto do estoque (a lata
 * de Red Bull, o gelo de coco). A mesma escolha serve para vários produtos.
 */
export function OptionGroupsField({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const groups = useLoad(() => api.get<OptionGroupView[]>('/api/option-groups'));
  const products = useLoad(() => api.get<StockProduct[]>('/api/products'));
  const [editing, setEditing] = useState<OptionGroupView | 'new' | null>(null);
  const [adding, setAdding] = useState('');

  if (!groups.data) return <Loading />;
  const byId = new Map(groups.data.map((g) => [g.id, g]));
  const attached = value.map((id) => byId.get(id)).filter((g): g is OptionGroupView => !!g);
  const available = groups.data.filter((g) => g.active && !value.includes(g.id));
  const move = (i: number) => {
    const next = [...value];
    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
    onChange(next);
  };

  return (
    <div className="stack option-groups-field">
      <p className="small muted">
        Ex.: dose de gin a {formatBRL(1200)} → no pedido o garçom escolhe o energético (Red Bull +{formatBRL(800)}, Monster +{formatBRL(500)}) e o gelo (coco +{formatBRL(200)}).
        O preço soma sozinho e o estoque baixa o que foi escolhido.
      </p>
      {attached.length === 0 && !editing && <div className="banner small"><ListChecks size={16} style={{ flex: 'none' }} /> Este produto entra direto no pedido, sem escolhas.</div>}
      {attached.map((g, i) => (
        <div key={g.id} className="card tight option-group-card">
          <div className="row between">
            <div className="row" style={{ gap: 6 }}>
              <span className="option-step">{i + 1}</span>
              <strong>{g.name}</strong>
              <Badge color={g.required ? 'blue' : undefined}>{g.required ? 'obrigatório' : 'opcional'}</Badge>
            </div>
            <div className="row" style={{ gap: 2 }}>
              {i > 0 && <Button size="small" variant="plain" icon={<ArrowUp size={15} />} aria-label={`Subir ${g.name}`} onClick={() => move(i)} />}
              <Button size="small" variant="plain" icon={<Pencil size={15} />} aria-label={`Editar ${g.name}`} onClick={() => setEditing(g)} />
              <Button size="small" variant="plain" icon={<X size={15} />} aria-label={`Tirar ${g.name} deste produto`} onClick={() => onChange(value.filter((x) => x !== g.id))} />
            </div>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>{g.choices.map(choiceText).join(' · ') || 'Sem opções'}</div>
          {g.products.length > 1 && <div className="tiny muted">Também usada em: {g.products.map((p) => p.name).slice(0, 4).join(', ')}{g.products.length > 4 ? '…' : ''}</div>}
        </div>
      ))}
      {editing ? (
        <OptionGroupEditor
          group={editing === 'new' ? null : editing}
          products={(products.data ?? []).filter((p) => p.active)}
          onCancel={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            void groups.reload();
            if (!value.includes(id)) onChange([...value, id]);
          }}
        />
      ) : (
        <div className="row wrap">
          {available.length > 0 && (
            <Select aria-label="Adicionar escolha já cadastrada" value={adding} style={{ maxWidth: 320 }} onChange={(e) => {
              if (e.target.value) onChange([...value, e.target.value]);
              setAdding('');
            }}>
              <option value="">Adicionar escolha já cadastrada…</option>
              {available.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.choices.length} opções)</option>)}
            </Select>
          )}
          <Button icon={<Plus size={16} />} onClick={() => setEditing('new')}>Criar nova escolha</Button>
        </div>
      )}
    </div>
  );
}

/** Nome da escolha, se é obrigatória, e as opções com preço a mais e baixa de estoque. */
function OptionGroupEditor({ group, products, onCancel, onSaved }: {
  group: OptionGroupView | null; products: StockProduct[]; onCancel: () => void; onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? '');
  const [required, setRequired] = useState(group?.required ?? true);
  const [choices, setChoices] = useState<ChoiceDraft[]>(() =>
    group?.choices.length
      ? group.choices.map((c) => ({ id: c.id, name: c.name, priceDeltaCents: c.priceDeltaCents, productId: c.productId ?? '', qty: c.productId ? c.qty / 1000 : null }))
      : [{ name: '', priceDeltaCents: null, productId: '', qty: null }],
  );
  const [busy, setBusy] = useState(false);
  const stock = products.filter((p) => p.stockTracked);
  const set = (i: number, patch: Partial<ChoiceDraft>) => setChoices((c) => c.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  const save = async () => {
    const filled = choices.filter((c) => c.name.trim());
    if (!name.trim()) return toast.error('Dê um nome para a escolha (ex.: Energético, Gelo).');
    if (!filled.length) return toast.error('Cadastre ao menos uma opção.');
    const bad = filled.find((c) => c.productId && !(c.qty && c.qty > 0));
    if (bad) return toast.error(`Informe quanto sai do estoque em "${bad.name}".`);
    setBusy(true);
    try {
      const body = {
        name: name.trim(), required, active: true,
        choices: filled.map((c) => ({
          id: c.id, name: c.name.trim(), priceDeltaCents: c.priceDeltaCents ?? 0,
          productId: c.productId || null, qty: c.productId ? Math.round((c.qty ?? 0) * 1000) : 0,
        })),
      };
      const r = group ? await api.put<{ id: string }>(`/api/option-groups/${group.id}`, body) : await api.post<{ id: string }>('/api/option-groups', body);
      toast.success(group ? 'Escolha atualizada' : 'Escolha criada e adicionada ao produto');
      onSaved(r.id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card option-group-editor pop-in">
      <div className="stack">
        <div className="grid-2">
          <Field label="Nome da escolha" hint="O que o garçom vai escolher: Energético, Gelo, Sabor do gin…">
            <Input autoFocus value={name} maxLength={40} placeholder="Energético" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Switch checked={required} onChange={setRequired} label="Obrigatória" description={required ? 'O pedido só entra com uma opção escolhida.' : 'Pode lançar sem escolher.'} />
        </div>
        <div className="section-label">Opções</div>
        {choices.map((c, i) => {
          const product = stock.find((p) => p.id === c.productId);
          return (
            <div key={i} className="option-choice-row">
              <Field label="Opção"><Input value={c.name} maxLength={40} placeholder={i === 0 ? 'Red Bull Tropical' : 'Monster'} onChange={(e) => set(i, { name: e.target.value })} /></Field>
              <Field label="Preço a mais"><MoneyInput value={c.priceDeltaCents} placeholder="0,00" onChange={(v) => set(i, { priceDeltaCents: v })} /></Field>
              <Field label="Baixa do estoque">
                <Select value={c.productId} onChange={(e) => {
                  const p = stock.find((x) => x.id === e.target.value);
                  set(i, { productId: e.target.value, qty: p && !c.qty ? DEFAULT_QTY[p.measure] : c.qty });
                }}>
                  <option value="">Não baixa estoque</option>
                  {stock.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Quanto sai">
                <DecimalInput value={product ? c.qty : null} disabled={!product} onChange={(v) => set(i, { qty: v })} suffix={product ? UNIT[product.measure] : ''} placeholder={product ? String(DEFAULT_QTY[product.measure]) : '—'} />
              </Field>
              <Button variant="plain" icon={<Trash2 size={15} />} aria-label={`Remover opção ${c.name || i + 1}`} disabled={choices.length === 1} onClick={() => setChoices((x) => x.filter((_, k) => k !== i))} />
            </div>
          );
        })}
        <Button variant="plain" size="small" icon={<Plus size={15} />} style={{ alignSelf: 'flex-start' }} onClick={() => setChoices((x) => [...x, { name: '', priceDeltaCents: null, productId: '', qty: null }])}>Opção</Button>
        <p className="tiny muted">Ex.: Red Bull Tropical · +{formatBRL(800)} · baixa 1 un de "Red Bull Tropical lata". Para "Sem energético" ou "Gelo comum", deixe sem preço e sem baixa.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>{group ? 'Salvar escolha' : 'Criar e adicionar'}</Button>
        </div>
      </div>
    </div>
  );
}
