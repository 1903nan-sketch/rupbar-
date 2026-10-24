import { AlertTriangle, ChefHat, ClipboardList, ClipboardPlus, FileBarChart, Maximize2, Minimize2, PackageMinus, Printer, ScanBarcode, Wallet, Wind, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, ErrorBox, Loading, PageHeader, Stat } from '../components/ui';
import { useShellActions } from '../layouts/DesktopShell';
import '../styles/dashboard.css';
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

  const shell = useShellActions();
  const navigate = useNavigate();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const f = data.financial;
  const max = Math.max(1, ...(f?.byHour.map((h) => h.total) ?? [1]));
  const hello = new Date().getHours() < 12 ? 'Bom dia' : new Date().getHours() < 18 ? 'Boa tarde' : 'Boa noite';

  return (
    <div className="stack-l">
      <PageHeader title={`${hello}, ${user?.name.split(' ')[0]}`} subtitle={fmtLongDate(new Date())} />

      <div className="action-tiles">
        {can('orders.create') && can('cash.payment') && (
          <ActionTile primary icon={<Zap size={26} />} title="Venda rápida" hint="Balcão: paga na hora e chama pelo nome na TV" kbd="F2" onClick={shell.openQuickSale} />
        )}
        {can('orders.create') && (
          <ActionTile icon={<ClipboardPlus size={26} />} title="Lançar na comanda" hint="Digite o número do cartão e escolha os itens" kbd="F3" onClick={() => shell.openLaunch()} />
        )}
        {can('orders.view') && (
          <ActionTile icon={<ScanBarcode size={26} />} title="Conferir pedido" hint="Cliente perdeu o ticket? Veja se pagou e se já retirou" kbd="F4" onClick={shell.openLookup} />
        )}
        {can('comandas.view') && (
          <ActionTile icon={<ClipboardList size={26} />} title="Comandas" hint={plural(data.openComandas, 'aberta agora', 'abertas agora')} onClick={() => navigate('/comandas')} />
        )}
        {can('reports.financial') && (
          <ActionTile icon={<FileBarChart size={26} />} title="Venda do dia" hint="Quanto vendeu, imprimir e salvar em PDF" onClick={() => navigate('/relatorios')} />
        )}
        <ActionTile
          icon={shell.fullscreen ? <Minimize2 size={26} /> : <Maximize2 size={26} />}
          title={shell.fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          hint="Esconde a barra do Windows"
          kbd="F11"
          onClick={shell.toggleFullscreen}
        />
      </div>

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
          <Stat label="Vendas do dia" value={formatBRL(f.salesCents)} hint={plural(f.itemsSold, 'item', 'itens')} />
          <Stat label="Recebido" value={formatBRL(f.receivedCents)} hint={plural(f.closedComandas, 'comanda encerrada', 'comandas encerradas')} />
          <Stat label="Ticket médio" value={formatBRL(f.averageTicketCents)} />
          <Stat label="Em aberto" value={formatBRL(f.openComandasValueCents)} hint={plural(data.openComandas, 'comanda aberta', 'comandas abertas')} />
        </div>
      )}

      <div className="grid-4">
        <Link to="/comandas"><Stat label={<span className="row"><ClipboardList size={15} /> Comandas abertas</span>} value={data.openComandas} /></Link>
        <Link to="/producao"><Stat label={<span className="row"><ChefHat size={15} /> Em produção</span>} value={data.inProduction} hint={plural(data.readyForPickup, 'pronto para retirada', 'prontos para retirada')} /></Link>
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

function ActionTile({ icon, title, hint, kbd, primary, onClick }: { icon: ReactNode; title: string; hint: string; kbd?: string; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`action-tile ${primary ? 'primary' : ''}`} onClick={onClick}>
      <span className="action-tile-icon">{icon}</span>
      <span className="action-tile-text">
        <span className="action-tile-title">{title}</span>
        <span className="action-tile-hint">{hint}</span>
      </span>
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
