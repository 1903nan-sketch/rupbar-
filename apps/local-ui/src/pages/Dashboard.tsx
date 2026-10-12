import { AlertTriangle, ChefHat, ClipboardList, PackageMinus, Printer, Wallet, Wind } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading, PageHeader, Stat } from '../components/ui';
import { api } from '../lib/api';
import { fmtLongDate, formatBRL } from '../lib/format';
import { useInterval, useLoad } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useSession } from '../lib/session';

interface Dashboard {
  businessDay: string;
  openComandas: number;
  ordersToday: number;
  inProduction: number;
  readyForPickup: number;
  stockAlerts: number;
  lossConflicts: number;
  hookahsInUse: number;
  cashOpen: boolean;
  failedPrints: number;
  financial: null | {
    salesCents: number;
    itemsSold: number;
    receivedCents: number;
    closedComandas: number;
    averageTicketCents: number;
    openComandasValueCents: number;
    byHour: { hour: number; total: number }[];
  };
}

export function DashboardPage() {
  const { user, can } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Dashboard>('/api/dashboard'));
  useRealtime(['comandas', 'kitchen', 'stock', 'cash'], () => void reload());
  useInterval(() => void reload(), 60_000);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const f = data.financial;
  const max = Math.max(1, ...(f?.byHour.map((h) => h.total) ?? [1]));
  const hello = new Date().getHours() < 12 ? 'Bom dia' : new Date().getHours() < 18 ? 'Boa tarde' : 'Boa noite';

  return (
    <div className="stack-l">
      <PageHeader title={`${hello}, ${user?.name.split(' ')[0]}`} subtitle={fmtLongDate(new Date())} />

      {(!data.cashOpen && can('cash.open')) || data.stockAlerts > 0 || data.lossConflicts > 0 || data.failedPrints > 0 ? (
        <div className="stack">
          {!data.cashOpen && can('cash.open') && (
            <Link to="/caixa" className="banner warning"><Wallet size={18} /><span className="grow">O caixa está fechado. Abra o caixa para receber pagamentos.</span></Link>
          )}
          {data.stockAlerts > 0 && (
            <Link to="/estoque?aba=alertas" className="banner warning"><AlertTriangle size={18} /><span className="grow">{data.stockAlerts} produto(s) no estoque mínimo ou abaixo.</span></Link>
          )}
          {data.lossConflicts > 0 && (
            <Link to="/perdas" className="banner danger"><PackageMinus size={18} /><span className="grow">{data.lossConflicts} perda(s) registradas no painel online aguardam resolução de conflito.</span></Link>
          )}
          {data.failedPrints > 0 && (
            <Link to="/configuracoes/impressoras" className="banner danger"><Printer size={18} /><span className="grow">{data.failedPrints} impressão(ões) falharam. Verifique as impressoras.</span></Link>
          )}
        </div>
      ) : null}

      {f && (
        <div className="grid-4">
          <Stat label="Vendas do dia" value={formatBRL(f.salesCents)} hint={`${f.itemsSold} itens`} />
          <Stat label="Recebido" value={formatBRL(f.receivedCents)} hint={`${f.closedComandas} comandas encerradas`} />
          <Stat label="Ticket médio" value={formatBRL(f.averageTicketCents)} />
          <Stat label="Em aberto" value={formatBRL(f.openComandasValueCents)} hint={`${data.openComandas} comandas abertas`} />
        </div>
      )}

      <div className="grid-4">
        <Link to="/comandas"><Stat label={<span className="row"><ClipboardList size={15} /> Comandas abertas</span>} value={data.openComandas} /></Link>
        <Link to="/producao"><Stat label={<span className="row"><ChefHat size={15} /> Em produção</span>} value={data.inProduction} hint={`${data.readyForPickup} prontos para retirada`} /></Link>
        <Stat label="Pedidos hoje" value={data.ordersToday} />
        <Link to="/narguiles"><Stat label={<span className="row"><Wind size={15} /> Narguilés em uso</span>} value={data.hookahsInUse} /></Link>
      </div>

      {f && f.byHour.length > 0 && (
        <Card title="Vendas por hora">
          <div className="bar-chart" aria-label="Vendas por hora">
            {Array.from({ length: 24 }, (_, h) => {
              const v = f.byHour.find((x) => x.hour === h)?.total ?? 0;
              return <div key={h} className="bar" style={{ height: `${(v / max) * 100}%`, opacity: v ? 0.85 : 0.15 }} title={`${h}h: ${formatBRL(v)}`} />;
            })}
          </div>
          <div className="row between tiny subtle" style={{ marginTop: 6 }}>
            <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
        </Card>
      )}
    </div>
  );
}
