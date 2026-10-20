import { importTemplateCsv } from '@rupbar/core';
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Loading, Modal, useToast } from '../components/ui';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';
import '../styles/stock.css';

interface PreviewItem {
  line: number;
  name: string;
  action: 'create' | 'update' | 'error';
  error: string | null;
  existingName: string | null;
  matchedBy: 'barcode' | 'code' | 'name' | null;
  category: string | null;
  newCategory: boolean;
  pack: string | null;
  stock: string | null;
  stockBefore: string | null;
  packageCostCents: number | null;
  presentations: { name: string; priceCents: number }[];
  warnings: string[];
}

interface ImportResponse {
  committed: boolean;
  items: PreviewItem[];
  total: number;
  create: number;
  update: number;
  errors: number;
  newCategories: string[];
  created?: number;
  updated?: number;
  divergences?: number;
}

/** O Excel brasileiro salva CSV em Windows-1252; o "CSV UTF-8" e o Google Planilhas em UTF-8. */
async function readCsv(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error('Este arquivo é do Excel (.xlsx). No Excel, vá em Arquivo → Salvar como → "CSV (separado por vírgulas)" e escolha o arquivo .csv.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([importTemplateCsv()], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modelo-estoque-rupbar.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const COLUMNS: [string, string][] = [
  ['nome', 'Nome do produto, como aparece no cardápio.'],
  ['como_compra', 'unidade, fardo, garrafa ou pacote.'],
  ['qtd_embalagem', 'Fardo: quantas unidades (12, 24). Garrafa: ml (1000 ou 1 L). Pacote: g (50).'],
  ['estoque_embalagens', 'Quantos fardos, garrafas ou pacotes fechados vocês contaram.'],
  ['estoque_soltas', 'O que sobrou aberto: latas soltas, ml da garrafa aberta, g do pacote aberto. Produto avulso: a quantidade.'],
  ['custo_embalagem', 'Quanto paga no fardo, na garrafa, no pacote (ou na unidade avulsa).'],
  ['preco_venda', 'Preço de venda da unidade ou da dose. Vazio = ingrediente, fora do cardápio.'],
  ['dose_ml / preco_garrafa', 'Destilados: tamanho da dose e preço da garrafa fechada.'],
  ['estoque_minimo', 'Avisa quando chegar nisso (unidades ou garrafas/pacotes).'],
];

const ACTION: Record<PreviewItem['action'], { label: string; color: 'green' | 'blue' | 'red' }> = {
  create: { label: 'Novo', color: 'green' },
  update: { label: 'Atualiza', color: 'blue' },
  error: { label: 'Erro', color: 'red' },
};
const MATCHED: Record<NonNullable<PreviewItem['matchedBy']>, string> = { barcode: 'pelo código de barras', code: 'pelo código', name: 'pelo nome' };

/**
 * Importar a contagem do estoque de uma planilha: baixa o modelo, escolhe o
 * CSV, confere linha a linha o que vai acontecer e importa tudo de uma vez.
 */
export function StockImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);

  const check = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy('check');
    setPreview(null);
    try {
      const csv = await readCsv(picked);
      setFile({ name: picked.name, csv });
      setPreview(await api.post<ImportResponse>('/api/stock/import', { csv }));
    } catch (e) {
      setFile(null);
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!file) return;
    setBusy('import');
    try {
      const r = await api.post<ImportResponse>('/api/stock/import', { csv: file.csv, commit: true });
      setResult(r);
      toast.success(`Planilha importada: ${r.created} novos, ${r.updated} atualizados`);
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const valid = preview ? preview.create + preview.update : 0;
  const items = preview?.items.filter((i) => !onlyIssues || i.action === 'error' || i.warnings.length) ?? [];

  if (result) {
    return (
      <Modal title="Planilha importada" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Ver o estoque</Button>}>
        <div className="stack import-done pop-in">
          <CircleCheck size={44} className="import-done-icon" />
          <div className="import-summary">
            <div><strong>{result.created}</strong><span>produtos novos com saldo e preço</span></div>
            <div><strong>{result.updated}</strong><span>já cadastrados com a contagem atualizada</span></div>
            {!!result.errors && <div className="bad"><strong>{result.errors}</strong><span>linhas com erro ficaram de fora</span></div>}
          </div>
          {!!result.updated && <p className="small muted">A contagem dos já cadastrados ficou registrada em Estoque → Inventário ("Importação de planilha"){result.divergences ? `, com ${result.divergences} diferença${result.divergences > 1 ? 's' : ''}` : ''}.</p>}
          {!!result.created && <p className="small muted">Os produtos com preço já aparecem no cardápio. Confira em Produtos se quiser trocar foto ou ajustar algum preço.</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Importar planilha do estoque" wide onClose={onClose} footer={<>
      <Button onClick={onClose} disabled={busy === 'import'}>Cancelar</Button>
      {preview && (
        <Button variant="primary" icon={<Upload size={16} />} loading={busy === 'import'} disabled={!valid} onClick={() => void commit()}>
          {valid ? `Importar ${valid} produto${valid > 1 ? 's' : ''}` : 'Nada para importar'}
        </Button>
      )}
    </>}>
      <div className="stack stock-import">
        {!preview && (
          <Card title={<h3><span className="step-number">1</span>Preencha o modelo</h3>} className="form-section">
            <div className="stack">
              <p className="small">Uma linha por produto. Abra o modelo no Excel ou no Google Planilhas, apague os exemplos, preencha com a contagem e salve como <strong>CSV</strong>.</p>
              <Button icon={<Download size={16} />} style={{ alignSelf: 'flex-start' }} onClick={downloadTemplate}>Baixar modelo (.csv)</Button>
              <dl className="import-columns">
                {COLUMNS.map(([c, d]) => <div key={c}><dt><code>{c}</code></dt><dd>{d}</dd></div>)}
              </dl>
              <p className="tiny muted">Produto que já existe (mesmo nome, código ou código de barras) só tem o estoque, o custo e o mínimo atualizados; os preços continuam os do sistema.</p>
            </div>
          </Card>
        )}

        <Card title={<h3><span className="step-number">{preview ? '1' : '2'}</span>{preview ? 'Planilha' : 'Escolha o arquivo'}</h3>} className="form-section">
          <label className={`import-drop ${busy === 'check' ? 'busy' : ''}`}>
            <FileSpreadsheet size={28} />
            <span>
              <strong>{file ? file.name : 'Escolher planilha (.csv)'}</strong>
              <span className="small muted">{file ? 'Escolha de novo depois de corrigir a planilha.' : 'Salva pelo Excel ("CSV separado por vírgulas") ou pelo Google Planilhas.'}</span>
            </span>
            {file && <RefreshCw size={18} className="muted" />}
            <input type="file" accept=".csv,.txt,text/csv" aria-label="Arquivo da planilha" hidden disabled={!!busy}
              onChange={(e) => { void check(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </Card>

        {busy === 'check' && <Loading />}
        {preview && (
          <Card title={<h3><span className="step-number">2</span>Confira antes de importar</h3>} className="form-section"
            actions={(preview.errors > 0 || preview.items.some((i) => i.warnings.length)) && (
              <Button size="small" variant="plain" onClick={() => setOnlyIssues((v) => !v)}>{onlyIssues ? 'Mostrar todas' : 'Só erros e avisos'}</Button>
            )}>
            <div className="stack">
              <div className="row wrap import-chips">
                <Badge color="green">{preview.create} novo{preview.create === 1 ? '' : 's'}</Badge>
                <Badge color="blue">{preview.update} atualiza{preview.update === 1 ? '' : 'm'} a contagem</Badge>
                {preview.errors > 0 && <Badge color="red">{preview.errors} com erro (ficam de fora)</Badge>}
                {preview.newCategories.length > 0 && <span className="small muted">Categorias novas: {preview.newCategories.join(', ')}</span>}
              </div>
              {preview.errors > 0 && (
                <div className="banner small warning"><CircleAlert size={16} style={{ flex: 'none' }} /> Corrija as linhas com erro na planilha e escolha o arquivo de novo, ou importe só as certas agora.</div>
              )}
              <div className="table-wrap">
                <table className="table import-table">
                  <thead><tr><th>Linha</th><th>Produto</th><th>Estoque contado</th><th>Venda</th><th>Custo</th></tr></thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.line} className={`import-row ${i.action}`}>
                        <td data-label="Linha" className="muted num">{i.line}</td>
                        <td data-label="Produto">
                          <div className="row" style={{ gap: 6 }}><Badge color={ACTION[i.action].color}>{ACTION[i.action].label}</Badge><span className="strong">{i.name || 'Sem nome'}</span></div>
                          {i.action === 'error' ? <div className="small import-error">{i.error}</div> : (
                            <div className="tiny muted">
                              {i.action === 'update'
                                ? `Já cadastrado ${MATCHED[i.matchedBy!]}${i.existingName !== i.name ? `: ${i.existingName}` : ''}`
                                : `${i.category}${i.newCategory ? ' (categoria nova)' : ''}`}
                              {i.pack && ` · ${i.pack}`}
                            </div>
                          )}
                          {i.warnings.map((w) => <div key={w} className="tiny import-warning">{w}</div>)}
                        </td>
                        <td data-label="Estoque">
                          {i.stock ?? <span className="muted">—</span>}
                          {i.stockBefore && <div className="tiny muted">no sistema: {i.stockBefore}</div>}
                        </td>
                        <td data-label="Venda">{i.presentations.length ? i.presentations.map((p) => <div key={p.name} className="small">{p.name} <span className="num strong">{formatBRL(p.priceCents)}</span></div>) : <span className="muted small">—</span>}</td>
                        <td data-label="Custo" className="num">{i.packageCostCents !== null ? formatBRL(i.packageCostCents) : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        )}
      </div>
    </Modal>
  );
}
