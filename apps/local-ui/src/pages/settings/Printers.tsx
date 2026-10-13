import { PRINT_JOB_KINDS, type PrintJobKind } from '@rupbar/core';
import { Plus, Printer, RefreshCw, RotateCcw, TestTube2 } from 'lucide-react';
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
      <PageHeader title="Impressoras" subtitle="Térmicas ESC/POS de 58 mm ou 80 mm, por rede (porta 9100) ou instaladas no Windows (USB)." actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit('new')}>Adicionar impressora</Button>} />
      {!data ? <Loading /> : data.length === 0 ? <Card><Empty icon={<Printer size={40} />} title="Nenhuma impressora">Adicione as impressoras da cozinha, do balcão e do caixa.</Empty></Card> : (
        <div className="grid-auto">
          {data.map((p) => (
            <Card key={p.id}>
              <div className="row between"><strong>{p.name}</strong>{!p.active ? <Badge>Inativa</Badge> : p.lastStatus === 'error' ? <Badge color="red">Erro</Badge> : p.lastStatus === 'ok' ? <Badge color="green">OK</Badge> : <Badge>Sem uso</Badge>}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {p.transport === 'network' ? `Rede ${p.host}:${p.port}` : p.transport === 'windows' ? `Windows: ${p.windowsName}` : `Arquivo: ${p.filePath}`} · {p.paper} mm
              </div>
              <div className="row wrap" style={{ marginTop: 8, gap: 4 }}>
                {p.stations.includes('kitchen') && <Badge color="orange">Cozinha</Badge>}
                {p.stations.includes('bar') && <Badge color="blue">Bebidas</Badge>}
                {p.printReceipts && <Badge color="purple">Contas e caixa</Badge>}
                {p.autoPrint && <Badge>Automática</Badge>}
              </div>
              {p.lastError && <div className="tiny danger-text" style={{ marginTop: 6 }}>{p.lastError}</div>}
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
                  <td><Badge color={JOB_STATUS[j.status]?.color}>{JOB_STATUS[j.status]?.label ?? j.status}</Badge>{j.last_error && j.status !== 'done' && <div className="tiny danger-text">{j.last_error} ({j.attempts}×)</div>}</td>
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
      {edit && <PrinterModal printer={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={reload} />}
    </div>
  );
}

function PrinterModal({ printer, onClose, onDone }: { printer: PrinterCfg | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const winPrinters = useLoad(() => api.get<{ printers: string[]; platform: string }>('/api/printers/windows'));
  const [f, setF] = useState({
    name: printer?.name ?? '', transport: printer?.transport ?? ('network' as PrinterCfg['transport']), host: printer?.host ?? '', port: printer?.port ?? 9100,
    windowsName: printer?.windowsName ?? '', filePath: printer?.filePath ?? '', paper: printer?.paper ?? 80, codepage: printer?.codepage ?? 'cp850',
    stations: printer?.stations ?? ['kitchen'], printReceipts: printer?.printReceipts ?? false, autoPrint: printer?.autoPrint ?? true, beep: printer?.beep ?? false, printQr: printer?.printQr ?? true, active: printer?.active ?? true,
  });
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
            <option value="network">Rede (Ethernet/Wi-Fi, porta 9100)</option>
            <option value="windows">Instalada no Windows (USB/compartilhada)</option>
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
          <Field label="Impressora do Windows" hint="Instale o driver “Generic / Text Only” ou o do fabricante.">
            {winPrinters.data?.printers.length ? (
              <Select value={f.windowsName} onChange={(e) => setF({ ...f, windowsName: e.target.value })}><option value="">Selecione…</option>{winPrinters.data.printers.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
            ) : <Input value={f.windowsName} onChange={(e) => setF({ ...f, windowsName: e.target.value })} placeholder="Nome exato da impressora" />}
          </Field>
        )}
        {f.transport === 'file' && <Field label="Caminho do arquivo"><Input value={f.filePath} onChange={(e) => setF({ ...f, filePath: e.target.value })} /></Field>}
        <div className="grid-2">
          <Field label="Papel"><Select value={f.paper} onChange={(e) => setF({ ...f, paper: Number(e.target.value) as 58 | 80 })}><option value={80}>80 mm (48 colunas)</option><option value={58}>58 mm (32 colunas)</option></Select></Field>
          <Field label="Acentuação" hint="Se sair errado no teste, troque."><Select value={f.codepage} onChange={(e) => setF({ ...f, codepage: e.target.value as PrinterCfg['codepage'] })}><option value="cp850">CP850 (padrão)</option><option value="cp860">CP860 (português)</option><option value="ascii">Sem acentos</option></Select></Field>
        </div>
        <div className="section-label">O que imprimir</div>
        <label className="check"><input type="checkbox" checked={f.stations.includes('kitchen')} onChange={() => toggleStation('kitchen')} /> Pedidos da cozinha</label>
        <label className="check"><input type="checkbox" checked={f.stations.includes('bar')} onChange={() => toggleStation('bar')} /> Pedidos de bebidas (balcão)</label>
        <label className="check"><input type="checkbox" checked={f.printReceipts} onChange={(e) => setF({ ...f, printReceipts: e.target.checked })} /> Conferência de conta e fechamento de caixa</label>
        <Switch checked={f.autoPrint} onChange={(v) => setF({ ...f, autoPrint: v })} label="Impressão automática de pedidos" />
        <Switch checked={f.beep} onChange={(v) => setF({ ...f, beep: v })} label="Bipe ao imprimir" description="Para impressoras de cozinha com buzzer." />
        {f.printReceipts && <Switch checked={f.printQr} onChange={(v) => setF({ ...f, printQr: v })} label="QR Code do Pix na conta" description="Desative se a impressora não imprimir QR Code (sai a chave Pix em texto)." />}
      </div>
    </Modal>
  );
}
