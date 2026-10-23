import { PRINT_JOB_KINDS, type PrintJobKind } from '@rupbar/core';
import { Info, Plus, Printer, RefreshCw, RotateCcw, TestTube2, Usb } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, Switch, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useLoad } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';

interface PrinterCfg {
  id: string;
  name: string;
  transport: 'network' | 'windows' | 'file';
  host: string | null;
  port: number;
  windowsName: string | null;
  filePath: string | null;
  paper: 58 | 80;
  codepage: 'cp850' | 'cp860' | 'ascii';
  stations: string[];
  printReceipts: boolean;
  autoPrint: boolean;
  beep: boolean;
  printQr: boolean;
  cashier: boolean;
  active: boolean;
  lastStatus: string | null;
  lastError: string | null;
}

const JOB_STATUS: Record<string, { label: string; color?: 'green' | 'orange' | 'red' | 'blue' }> = {
  pending: { label: 'Na fila', color: 'orange' },
  printing: { label: 'Imprimindo', color: 'blue' },
  done: { label: 'Impresso', color: 'green' },
  failed: { label: 'Falhou', color: 'red' },
  canceled: { label: 'Cancelado' },
};

export function PrintersSettings() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<PrinterCfg[]>('/api/printers'));
  const jobs = useLoad(() => api.get<{ id: string; printer_name: string; kind: PrintJobKind; title: string; status: string; attempts: number; last_error: string | null; created_at: string; printed_at: string | null }[]>('/api/print-jobs'));
  useRealtime(['printing'], () => { void jobs.reload(); void reload(); });
  const [edit, setEdit] = useState<PrinterCfg | 'new' | null>(null);

  return (
    <div className="stack-l">
      <PageHeader title="Impressoras" subtitle="Térmicas ESC/POS de 58 mm ou 80 mm, ligadas por USB no PC ou pela rede." actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit('new')}>Adicionar impressora</Button>} />
      {!data ? <Loading /> : data.length === 0 ? (
        <Card>
          <Empty icon={<Printer size={40} />} title="Nenhuma impressora">
            Comece pela impressora do caixa: ela imprime o ticket de cada pedido (venda rápida e comandas) e, enquanto não houver outras, também os pedidos da cozinha e do bar.
          </Empty>
        </Card>
      ) : (
        <div className="grid-auto">
          {data.map((p) => (
            <Card key={p.id}>
              <div className="row between"><strong>{p.name}</strong>{!p.active ? <Badge>Inativa</Badge> : p.lastStatus === 'error' ? <Badge color="red">Erro</Badge> : p.lastStatus === 'warning' ? <Badge color="orange">Atenção</Badge> : p.lastStatus === 'ok' ? <Badge color="green">OK</Badge> : <Badge>Sem uso</Badge>}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {p.transport === 'network' ? `Rede ${p.host}:${p.port}` : p.transport === 'windows' ? `Windows: ${p.windowsName}` : `Arquivo: ${p.filePath}`} · {p.paper} mm
              </div>
              <div className="row wrap" style={{ marginTop: 8, gap: 4 }}>
                {p.cashier && <Badge color="green">Caixa · ticket de cada pedido</Badge>}
                {!p.cashier && p.stations.includes('kitchen') && <Badge color="orange">Cozinha</Badge>}
                {!p.cashier && p.stations.includes('bar') && <Badge color="blue">Bebidas</Badge>}
                {p.printReceipts && <Badge color="purple">Contas e caixa</Badge>}
                {p.autoPrint && <Badge>Automática</Badge>}
              </div>
              {p.lastError && <div className={`tiny ${p.lastStatus === 'warning' ? 'warning-text' : 'danger-text'}`} style={{ marginTop: 6 }}>{p.lastError}</div>}
              <div className="row" style={{ marginTop: 12 }}>
                <Button size="small" icon={<TestTube2 size={14} />} onClick={async () => { try { await api.post(`/api/printers/${p.id}/test`); toast.success('Teste enviado'); } catch (e) { toast.error(e); } }}>Testar</Button>
                <Button size="small" variant="plain" onClick={() => setEdit(p)}>Editar</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Card title="Histórico de impressão" actions={<Button size="small" variant="plain" icon={<RefreshCw size={14} />} onClick={() => void jobs.reload()} />} flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Data</th><th>Impressora</th><th>Documento</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {jobs.data?.map((j) => (
                <tr key={j.id}>
                  <td className="small nowrap">{fmtDateTime(j.created_at)}</td>
                  <td>{j.printer_name}</td>
                  <td>{j.title}<div className="tiny muted">{PRINT_JOB_KINDS[j.kind] ?? j.kind}</div></td>
                  <td><Badge color={JOB_STATUS[j.status]?.color}>{JOB_STATUS[j.status]?.label ?? j.status}</Badge>{j.last_error && (j.status === 'done' ? <div className="tiny warning-text">{j.last_error}</div> : <div className="tiny danger-text">{j.last_error} ({j.attempts}×)</div>)}</td>
                  <td className="right">
                    {(j.status === 'failed' || j.status === 'canceled') && <Button size="small" variant="plain" icon={<RefreshCw size={14} />} onClick={async () => { await api.post(`/api/print-jobs/${j.id}/retry`); void jobs.reload(); }}>Tentar de novo</Button>}
                    {j.status === 'done' && <Button size="small" variant="plain" icon={<RotateCcw size={14} />} onClick={async () => { await api.post(`/api/print-jobs/${j.id}/reprint`); toast.success('Reimpressão enviada'); void jobs.reload(); }}>Reimprimir</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit && <PrinterModal printer={edit === 'new' ? null : edit} first={!data?.some((p) => p.active)} hasCashier={!!data?.some((p) => p.active && p.cashier)} onClose={() => setEdit(null)} onDone={reload} />}
    </div>
  );
}

interface WindowsPrinter {
  name: string;
  port: string | null;
  driver: string | null;
  offline: boolean;
}

function PrinterModal({ printer, first, hasCashier, onClose, onDone }: { printer: PrinterCfg | null; first: boolean; hasCashier: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const winPrinters = useLoad(() => api.get<{ printers: string[]; details?: WindowsPrinter[]; platform: string }>('/api/printers/windows'));
  // A primeira impressora é a do caixa: tudo sai nela até existirem outras.
  const cashierDefault = !printer && (first || !hasCashier);
  const [f, setF] = useState({
    name: printer?.name ?? (cashierDefault ? 'Caixa' : ''), transport: printer?.transport ?? ('windows' as PrinterCfg['transport']), host: printer?.host ?? '', port: printer?.port ?? 9100,
    windowsName: printer?.windowsName ?? '', filePath: printer?.filePath ?? '', paper: printer?.paper ?? 58, codepage: printer?.codepage ?? 'cp850',
    stations: printer?.stations ?? (cashierDefault ? [] : ['kitchen']), printReceipts: printer?.printReceipts ?? cashierDefault, autoPrint: printer?.autoPrint ?? true,
    beep: printer?.beep ?? false, printQr: printer?.printQr ?? true, cashier: printer?.cashier ?? cashierDefault, active: printer?.active ?? true,
  });
  const details: WindowsPrinter[] = winPrinters.data?.details ?? (winPrinters.data?.printers ?? []).map((name) => ({ name, port: null, driver: null, offline: false }));
  const onWindows = winPrinters.data?.platform === 'win32';
  const toggleStation = (s: string) => setF({ ...f, stations: f.stations.includes(s) ? f.stations.filter((x) => x !== s) : [...f.stations, s] });
  return (
    <Modal title={printer ? printer.name : 'Nova impressora'} onClose={onClose} footer={<>
      {printer && <Button variant="danger" onClick={async () => { await api.del(`/api/printers/${printer.id}`); onDone(); onClose(); }}>Desativar</Button>}
      <span className="grow" />
      <Button onClick={onClose}>Cancelar</Button>
      <Button variant="primary" onClick={async () => {
        try {
          const body = { ...f, host: f.host || null, windowsName: f.windowsName || null, filePath: f.filePath || null };
          if (printer) await api.put(`/api/printers/${printer.id}`, body); else await api.post('/api/printers', body);
          toast.success('Impressora salva'); onDone(); onClose();
        } catch (e) { toast.error(e); }
      }}>Salvar</Button>
    </>}>
      <div className="stack">
        <Field label="Nome"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Cozinha" /></Field>
        <Field label="Conexão">
          <Select value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value as PrinterCfg['transport'] })}>
            <option value="windows">USB (instalada no Windows)</option>
            <option value="network">Rede (cabo ou Wi-Fi, porta 9100)</option>
            <option value="file">Arquivo (testes)</option>
          </Select>
        </Field>
        {f.transport === 'network' && (
          <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <Field label="IP da impressora" hint="Veja na página de autoteste da impressora."><Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="192.168.0.200" /></Field>
            <Field label="Porta"><Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></Field>
          </div>
        )}
        {f.transport === 'windows' && (
          <>
            <Field label="Impressora USB" hint="A lista mostra as impressoras instaladas no Windows deste PC.">
              <div className="row">
                {details.length ? (
                  <Select className="grow" value={f.windowsName} onChange={(e) => setF({ ...f, windowsName: e.target.value })}>
                    <option value="">Selecione…</option>
                    {details.map((p) => <option key={p.name} value={p.name}>{p.name}{p.port ? ` — porta ${p.port}` : ''}{p.offline ? ' (desligada)' : ''}</option>)}
                  </Select>
                ) : <Input className="grow" value={f.windowsName} onChange={(e) => setF({ ...f, windowsName: e.target.value })} placeholder="Nome exato da impressora no Windows" />}
                <Button icon={<RefreshCw size={15} />} loading={!winPrinters.data && !winPrinters.error} onClick={() => void winPrinters.reload()}>Atualizar</Button>
              </div>
            </Field>
            {winPrinters.data && !details.length && (
              <div className="banner small">
                <Usb size={18} style={{ flex: 'none', marginTop: 2 }} />
                <div>
                  {onWindows ? <strong>Nenhuma impressora instalada no Windows.</strong> : <strong>A lista aparece no PC do bar (Windows).</strong>}
                  <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    <li>Ligue a impressora no USB do PC do bar e ligue o botão de energia.</li>
                    <li>Instale o driver que veio com ela (CD ou site do fabricante; nas genéricas de 58 mm costuma se chamar “POS-58”).</li>
                    <li>Sem driver: Configurações do Windows → Impressoras → Adicionar manualmente → porta <strong>USB001</strong> → fabricante “Generic”, modelo <strong>“Generic / Text Only”</strong>.</li>
                    <li>Volte aqui e toque em <strong>Atualizar</strong>.</li>
                  </ol>
                </div>
              </div>
            )}
          </>
        )}
        {f.transport === 'file' && <Field label="Caminho do arquivo"><Input value={f.filePath} onChange={(e) => setF({ ...f, filePath: e.target.value })} /></Field>}
        <div className="grid-2">
          <Field label="Papel"><Select value={f.paper} onChange={(e) => setF({ ...f, paper: Number(e.target.value) as 58 | 80 })}><option value={80}>80 mm (48 colunas)</option><option value={58}>58 mm (32 colunas)</option></Select></Field>
          <Field label="Acentuação" hint="Se sair errado no teste, troque."><Select value={f.codepage} onChange={(e) => setF({ ...f, codepage: e.target.value as PrinterCfg['codepage'] })}><option value="cp850">CP850 (padrão)</option><option value="cp860">CP860 (português)</option><option value="ascii">Sem acentos</option></Select></Field>
        </div>
        <div className="section-label">O que imprimir</div>
        <Switch checked={f.cashier} onChange={(v) => setF({ ...f, cashier: v, printReceipts: v || f.printReceipts })} label="Impressora do caixa"
          description="Imprime o ticket de cada pedido (venda rápida e comandas) para o cliente levar ao bar, com código de barras para conferir. Pedidos de setores sem impressora própria também saem aqui." />
        {f.cashier ? (
          <div className="banner small"><Info size={16} style={{ flex: 'none', marginTop: 2 }} /> Com uma impressora só, tudo sai nela. Quando colocar uma impressora na cozinha ou no bar, cadastre-a com o setor: os pedidos daquele setor passam a sair lá e o caixa continua com o ticket do cliente.</div>
        ) : (
          <>
            <label className="check"><input type="checkbox" checked={f.stations.includes('kitchen')} onChange={() => toggleStation('kitchen')} /> Pedidos da cozinha</label>
            <label className="check"><input type="checkbox" checked={f.stations.includes('bar')} onChange={() => toggleStation('bar')} /> Pedidos de bebidas (bar)</label>
          </>
        )}
        <label className="check"><input type="checkbox" checked={f.printReceipts} onChange={(e) => setF({ ...f, printReceipts: e.target.checked })} /> Conferência de conta e fechamento de caixa</label>
        <Switch checked={f.autoPrint} onChange={(v) => setF({ ...f, autoPrint: v })} label="Impressão automática de pedidos" />
        <Switch checked={f.beep} onChange={(v) => setF({ ...f, beep: v })} label="Bipe ao imprimir" description="Para impressoras de cozinha com buzzer." />
        {f.printReceipts && <Switch checked={f.printQr} onChange={(v) => setF({ ...f, printQr: v })} label="QR Code do Pix na conta" description="Desative se a impressora não imprimir QR Code (sai a chave Pix em texto)." />}
      </div>
    </Modal>
  );
}
