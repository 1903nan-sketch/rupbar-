import { CircleCheck, Cloud, Eraser, FileSpreadsheet, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Switch, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { formatBRL } from '../../lib/format';
import { useLoad } from '../../lib/hooks';

interface Preview {
  comandas: number;
  orders: number;
  salesCents: number;
  cashSessions: number;
  openCashSessions: number;
  openComandas: number;
  losses: number;
  hookahSessions: number;
  products: number;
  optionGroups: number;
  stockMovements: number;
  purchases: number;
  cloud: boolean;
}

const n = (v: number, one: string, many: string) => `${v.toLocaleString('pt-BR')} ${v === 1 ? one : many}`;

/**
 * Conta mestre: apagar o que foi lançado nos testes (vendas, caixas,
 * relatórios, estoque e produtos) para começar a operação do zero.
 */
export function ResetTestData() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api.get<Preview>('/api/admin/test-data'));
  const [keepProducts, setKeepProducts] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ backup: string; keepProducts: boolean } | null>(null);
  const ready = confirm.trim().toUpperCase() === 'APAGAR' && password.length > 0;

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ backup: string; keepProducts: boolean }>('/api/admin/test-data/reset', { password, confirm, keepProducts });
      setDone(r);
      setPassword('');
      setConfirm('');
      toast.success('Dados de teste apagados');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="stack-l">
        <PageHeader title="Apagar dados de teste" />
        <Card>
          <div className="stack reset-done pop-in">
            <CircleCheck size={44} />
            <h3>Pronto: o sistema está zerado para começar</h3>
            <p className="small muted">
              Vendas, caixas, relatórios e estoque{done.keepProducts ? '' : ', produtos'} foram apagados. A numeração de comandas e pedidos recomeça do 1.
              {data?.cloud && ' O painel online some com eles na próxima sincronização.'}
            </p>
            <p className="tiny muted">Cópia de segurança de antes da limpeza: {done.backup} (em Configurações → Backup).</p>
            <Link to="/estoque" className="btn primary"><FileSpreadsheet size={16} /> {done.keepProducts ? 'Ir para o estoque' : 'Importar a planilha do estoque'}</Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="stack-l">
      <PageHeader title="Apagar dados de teste" subtitle="Para começar a operar de verdade: apaga tudo o que foi lançado nos testes, sem deixar divergência nos relatórios." />
      {error ? <ErrorBox error={error} onRetry={reload} /> : !data ? <Loading /> : (
        <div className="stack reset-page">
          <Card title={<h3>O que vai ser apagado</h3>}>
            <ul className="reset-list">
              <li><strong>{n(data.comandas, 'comanda', 'comandas')}</strong> e {n(data.orders, 'pedido', 'pedidos')} (vendas de {formatBRL(data.salesCents)})</li>
              <li><strong>{n(data.cashSessions, 'caixa', 'caixas')}</strong> com sangrias e suprimentos{data.openCashSessions ? ' (inclusive o caixa aberto)' : ''}</li>
              <li><strong>{n(data.stockMovements, 'movimentação', 'movimentações')} de estoque</strong>, {n(data.purchases, 'entrada', 'entradas')}, inventários e alertas</li>
              <li>{n(data.losses, 'perda', 'perdas')} e {n(data.hookahSessions, 'locação', 'locações')} de narguilé</li>
              {!keepProducts && <li><strong>{n(data.products, 'produto', 'produtos')}</strong> com preços, combos e {n(data.optionGroups, 'escolha', 'escolhas')} (energético, gelo…)</li>}
              <li>Relatórios e painel online: tudo isso some deles{data.cloud ? '' : ' (o painel online não está conectado)'}</li>
            </ul>
            {data.openComandas > 0 && <p className="small reset-warn">Há {n(data.openComandas, 'comanda aberta', 'comandas abertas')}: também serão apagadas.</p>}
            <div className="reset-keep">
              <ShieldCheck size={16} />
              <span className="small">Continuam: funcionários e senhas, configurações, Pix, impressoras, TV, categorias, fornecedores e os narguilés da casa.</span>
            </div>
          </Card>

          <Card title={<h3>Produtos</h3>}>
            <Switch checked={keepProducts} onChange={setKeepProducts} label="Manter o cadastro dos produtos"
              description={keepProducts
                ? 'Os produtos, preços, combos e escolhas ficam; só o estoque volta a zero.'
                : 'Os produtos também saem. Depois é só importar a planilha do estoque com tudo.'} />
          </Card>

          <Card title={<h3>Confirmar</h3>}>
            <div className="stack">
              <div className="grid-2">
                <Field label="Sua senha (proprietário)"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                <Field label="Digite APAGAR" hint="Para não apagar sem querer."><Input value={confirm} autoComplete="off" placeholder="APAGAR" onChange={(e) => setConfirm(e.target.value)} /></Field>
              </div>
              <p className="tiny muted"><Cloud size={13} style={{ verticalAlign: -2 }} /> Antes de apagar o sistema faz uma cópia de segurança do banco. Não use depois que o bar começar a vender de verdade.</p>
              <Button variant="danger" icon={<Eraser size={16} />} loading={busy} disabled={!ready} style={{ alignSelf: 'flex-start' }} onClick={() => void run()}>
                Apagar dados de teste
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
