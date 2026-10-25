'use client';
import { Search, SearchX, X } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';

export interface StockRow {
  id: string;
  name: string;
  category: string;
  qty: string;
  packages: string | null;
  min: string | null;
  label: string;
  color: 'green' | 'orange' | 'red';
  /** Medidor (0–100). */
  fill: number;
}

/** Busca sem acento e sem maiúscula: "agua" acha "Água", "aneis" acha "Anéis". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR');

/** Lista do estoque com busca por produto/categoria e filtro de categoria. No celular vira lista. */
export function StockBrowser({ rows }: { rows: StockRow[] }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const indexed = useMemo(() => rows.map((r) => ({ r, key: fold(`${r.name} ${r.category}`) })), [rows]);
  const categories = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of rows) count.set(r.category, (count.get(r.category) ?? 0) + 1);
    return [...count].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  }, [rows]);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const shown = indexed.filter(({ r, key }) => (!cat || r.category === cat) && words.every((w) => key.includes(w))).map(({ r }) => r);
  const filtering = words.length > 0 || cat !== null;

  return (
    <>
      <div className="stock-toolbar">
        <div className="input-icon">
          <Search size={16} aria-hidden="true" />
          <input
            className="input"
            type="search"
            enterKeyHint="search"
            placeholder="Buscar produto ou categoria"
            aria-label="Buscar produto ou categoria"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button type="button" className="input-action" onClick={() => setQ('')} aria-label="Limpar busca">
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        {categories.length > 1 && (
          <div className="chips stock-cats" role="group" aria-label="Categoria">
            <button type="button" className={`chip ${cat === null ? 'active' : ''}`} aria-pressed={cat === null} onClick={() => setCat(null)}>
              Todas
            </button>
            {categories.map(([name, n]) => (
              <button key={name} type="button" className={`chip ${cat === name ? 'active' : ''}`} aria-pressed={cat === name} onClick={() => setCat(cat === name ? null : name)}>
                {name} <span className="chip-count">{n}</span>
              </button>
            ))}
          </div>
        )}
        {filtering && (
          <p className="tiny muted" aria-live="polite">
            {shown.length === 1 ? '1 produto' : `${shown.length.toLocaleString('pt-BR')} produtos`} de {rows.length.toLocaleString('pt-BR')}
          </p>
        )}
      </div>

      {!shown.length ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">
            <SearchX size={26} strokeWidth={1.8} />
          </span>
          <div className="empty-title">Nada encontrado</div>
          <div className="empty-text">Tente outro nome ou outra categoria.</div>
          <button type="button" className="btn ghost" onClick={() => { setQ(''); setCat(null); }}>
            Limpar busca
          </button>
        </div>
      ) : (
        <>
          <div className="table-wrap tall hide-sm">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col">Categoria</th>
                  <th scope="col" className="right">Saldo</th>
                  <th scope="col">Nível</th>
                  <th scope="col" className="right">Embalagens</th>
                  <th scope="col" className="right">Mínimo</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td className="strong">{p.name}</td>
                    <td className="muted">{p.category}</td>
                    <td className="right num strong">{p.qty}</td>
                    <td>
                      <Meter color={p.color} fill={p.fill} />
                    </td>
                    <td className="right small muted">{p.packages ?? '—'}</td>
                    <td className="right num muted">{p.min ?? '—'}</td>
                    <td>
                      <Level color={p.color} label={p.label} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="list only-sm stock-list">
            {shown.map((p) => (
              <li key={p.id} className="list-item">
                <div className="grow">
                  <div className="strong">{p.name}</div>
                  <div className="tiny muted">
                    {p.category}
                    {p.packages ? ` · ${p.packages}` : ''}
                    {p.min ? ` · mín. ${p.min}` : ''}
                  </div>
                  <Meter color={p.color} fill={p.fill} />
                </div>
                <div className="stock-side">
                  <span className="num strong">{p.qty}</span>
                  <Level color={p.color} label={p.label} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Meter({ color, fill }: { color: StockRow['color']; fill: number }) {
  return (
    <span className={`meter ${color}`} aria-hidden="true">
      <span style={{ ['--w' as string]: `${fill}%` } as CSSProperties} />
    </span>
  );
}

function Level({ color, label }: { color: StockRow['color']; label: string }) {
  return (
    <span className={`badge ${color}`}>
      <span className="badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
