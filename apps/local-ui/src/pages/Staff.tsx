import { CASHIER_EXTRA, CHARGE_EXTRA } from '@rupbar/core';
import { Copy, History, KeyRound, Plus, ShieldCheck, Smartphone, Trash2, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Switch, Tabs, Textarea, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useLoad } from '../lib/hooks';

interface StaffUser {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'blocked';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roleId: string;
  roleName: string;
  roleKey: string | null;
  grants: string[];
  denies: string[];
}
interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}
interface PermCatalog {
  permissions: Record<string, string>;
  groups: { label: string; prefix: string[] }[];
  ownerOnly: string[];
  sensitive: string[];
}

export function StaffPage() {
  const [tab, setTab] = useState<'funcionarios' | 'cargos'>('funcionarios');
  return (
    <div className="stack">
      <PageHeader title="Funcionários" subtitle="Somente o proprietário cria contas, altera permissões e redefine senhas." />
      <Tabs value={tab} onChange={setTab} options={[{ value: 'funcionarios', label: 'Funcionários' }, { value: 'cargos', label: 'Cargos e permissões' }]} />
      {tab === 'funcionarios' ? <Users /> : <Roles />}
    </div>
  );
}

function TempPassword({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title="Senha temporária" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Pronto</Button>}>
      <div className="stack" style={{ textAlign: 'center' }}>
        <p className="muted">Informe esta senha a <strong>{name}</strong>. Ela será trocada obrigatoriamente no primeiro acesso e não será exibida novamente.</p>
        <div className="mono strong" style={{ fontSize: 30, letterSpacing: '.08em' }}>{password}</div>
        <Button icon={<Copy size={16} />} onClick={() => navigator.clipboard?.writeText(password).then(() => toast.success('Copiada'))}>Copiar</Button>
      </div>
    </Modal>
  );
}

function Users() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api.get<StaffUser[]>('/api/users'));
  const roles = useLoad(() => api.get<Role[]>('/api/roles'));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [temp, setTemp] = useState<{ name: string; password: string } | null>(null);
  const [resetFor, setResetFor] = useState<StaffUser | null>(null);
  const [history, setHistory] = useState<StaffUser | null>(null);
  const [removing, setRemoving] = useState<StaffUser | null>(null);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <Button variant="primary" icon={<UserPlus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setCreating(true)}>Novo funcionário</Button>
      <Card flush>
        <div className="list">
          {data.map((u) => (
            <div key={u.id} className="list-item" style={{ opacity: u.status === 'blocked' ? 0.55 : 1 }}>
              <div className="logo" style={{ width: 36, height: 36, fontSize: 14, borderRadius: '50%' }}>{u.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}</div>
              <div className="grow">
                <div className="strong">{u.name} {u.status === 'blocked' && <Badge color="red">Bloqueado</Badge>} {u.mustChangePassword && <Badge color="orange">Senha temporária</Badge>}</div>
                <div className="small muted">{u.email} · último acesso {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'nunca'}</div>
              </div>
              <Badge color={u.roleKey === 'owner' ? 'accent' : undefined}>{u.roleName}</Badge>
              {u.roleKey !== 'owner' && (
                <>
                  <Button size="small" variant="plain" icon={<History size={15} />} aria-label="Histórico de acessos" onClick={() => setHistory(u)} />
                  <Button size="small" variant="plain" icon={<KeyRound size={15} />} aria-label="Redefinir senha" onClick={() => setResetFor(u)} />
                  <Button size="small" onClick={() => setEditing(u)}>Editar</Button>
                  <Button size="small" variant="plain" icon={<Trash2 size={15} />} aria-label={`Excluir ${u.name}`} onClick={() => setRemoving(u)} />
                </>
              )}
            </div>
          ))}
        </div>
      </Card>
      {creating && roles.data && (
        <UserModal roles={roles.data} onClose={() => setCreating(false)} onSaved={async (body) => {
          const r = await api.post<{ temporaryPassword: string }>('/api/users', body);
          setTemp({ name: body.name, password: r.temporaryPassword });
          void reload();
        }} />
      )}
      {editing && roles.data && (
        <UserModal roles={roles.data} user={editing} onClose={() => setEditing(null)} onSaved={async (body) => {
          await api.patch(`/api/users/${editing.id}`, body);
          toast.success('Funcionário atualizado. Sessões abertas foram encerradas se as permissões mudaram.');
          void reload();
        }} />
      )}
      {resetFor && (
        <Confirm title={`Redefinir senha de ${resetFor.name}?`} message="Uma nova senha temporária será gerada e todas as sessões do funcionário serão encerradas." confirmLabel="Redefinir" onClose={() => setResetFor(null)}
          onConfirm={async () => { const r = await api.post<{ temporaryPassword: string }>(`/api/users/${resetFor.id}/reset-password`); setTemp({ name: resetFor.name, password: r.temporaryPassword }); void reload(); }} />
      )}
      {removing && (
        <Confirm title={`Excluir ${removing.name}?`} confirmLabel="Excluir funcionário" danger onClose={() => setRemoving(null)}
          message="Sai da lista e não entra mais no sistema (nem no celular). As vendas, caixas e o histórico continuam com o nome. O e-mail fica livre para um novo cadastro."
          onConfirm={async () => { await api.post(`/api/users/${removing.id}/remove`); toast.success(`${removing.name} excluído(a)`); void reload(); }} />
      )}
      {temp && <TempPassword name={temp.name} password={temp.password} onClose={() => setTemp(null)} />}
      {history && <AccessHistory user={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function UserModal({ roles, user, onClose, onSaved }: { roles: Role[]; user?: StaffUser; onClose: () => void; onSaved: (body: any) => Promise<void> }) {
  const toast = useToast();
  const catalog = useLoad(() => api.get<PermCatalog>('/api/permissions'));
  const assignable = roles.filter((r) => r.key !== 'owner');
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', roleId: user?.roleId ?? assignable.find((r) => r.key === 'waiter')?.id ?? '', status: user?.status ?? 'active' });
  const [grants, setGrants] = useState<string[]>(user?.grants ?? []);
  const [denies, setDenies] = useState<string[]>(user?.denies ?? []);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const role = roles.find((r) => r.id === f.roleId);

  const toggle = (p: string) => {
    const inRole = role?.permissions.includes(p);
    if (inRole) setDenies(denies.includes(p) ? denies.filter((x) => x !== p) : [...denies, p]);
    else setGrants(grants.includes(p) ? grants.filter((x) => x !== p) : [...grants, p]);
  };
  const effective = (p: string) => (role?.permissions.includes(p) && !denies.includes(p)) || grants.includes(p);
  // Atalhos "Também trabalha no caixa" e "Cobra no celular": ligam/desligam um pacote de permissões para esta pessoa.
  const setPack = (pack: readonly string[], on: boolean) => {
    if (on) {
      setDenies(denies.filter((p) => !pack.includes(p)));
      setGrants([...new Set([...grants, ...pack.filter((p) => !role?.permissions.includes(p))])]);
    } else {
      setGrants(grants.filter((p) => !pack.includes(p)));
      setDenies([...new Set([...denies, ...pack.filter((p) => role?.permissions.includes(p))])]);
    }
  };
  const cashier = CASHIER_EXTRA.every(effective);
  const roleHasCash = CASHIER_EXTRA.every((p) => role?.permissions.includes(p));
  const setCashier = (on: boolean) => setPack(CASHIER_EXTRA, on);
  const charges = CHARGE_EXTRA.every(effective);
  const roleCharges = CHARGE_EXTRA.every((p) => role?.permissions.includes(p));

  return (
    <Modal title={user ? `Editar ${user.name}` : 'Novo funcionário'} wide onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={async () => {
      setBusy(true);
      try {
        await onSaved(user ? { name: f.name, roleId: f.roleId, status: f.status, grants, denies } : { name: f.name, email: f.email, roleId: f.roleId, grants, denies });
        onClose();
      } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>{user ? 'Salvar' : 'Criar e gerar senha temporária'}</Button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Nome *"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail *"><Input type="email" disabled={!!user} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Cargo">
            <Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
          </Field>
          {user && (
            <Field label="Situação">
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' | 'blocked' })}><option value="active">Ativo</option><option value="blocked">Bloqueado</option></Select>
            </Field>
          )}
        </div>
        {role?.description && <p className="small muted">{role.description}</p>}
        {!roleHasCash && (
          <Card tight>
            {!roleCharges && !cashier && (
              <Switch checked={charges} onChange={(on) => setPack(CHARGE_EXTRA, on)} label={<span className="row"><Smartphone size={16} /> Cobra no celular</span>}
                description="Recebe na mesa (Pix, dinheiro, cartão), encerra a comanda paga e faz venda rápida pelo celular. Não abre nem fecha o caixa." />
            )}
            <Switch checked={cashier} onChange={setCashier} label={<span className="row"><Wallet size={16} /> Também trabalha no caixa</span>}
              description="Abre e fecha o caixa, recebe pagamentos (Pix, dinheiro, cartão), faz venda rápida, encerra comandas, sangria e suprimento. Pelo PC ou pelo celular." />
          </Card>
        )}
        <Button variant="plain" icon={<ShieldCheck size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setCustom(!custom)}>{custom ? 'Ocultar' : 'Ajustar'} permissões individuais{grants.length + denies.length ? ` (${grants.length + denies.length})` : ''}</Button>
        {custom && catalog.data && <PermissionGrid catalog={catalog.data} isOn={effective} onToggle={toggle} />}
      </div>
    </Modal>
  );
}

function PermissionGrid({ catalog, isOn, onToggle }: { catalog: PermCatalog; isOn: (p: string) => boolean; onToggle: (p: string) => void }) {
  return (
    <div className="grid-2">
      {catalog.groups.map((g) => (
        <Card key={g.label} tight>
          <div className="section-label">{g.label}</div>
          {Object.entries(catalog.permissions).filter(([k]) => g.prefix.some((p) => k.startsWith(p))).map(([k, label]) => {
            const ownerOnly = catalog.ownerOnly.includes(k);
            return (
              <label key={k} className="check small" style={{ padding: '4px 0', opacity: ownerOnly ? 0.45 : 1 }}>
                <input type="checkbox" disabled={ownerOnly} checked={!ownerOnly && isOn(k)} onChange={() => onToggle(k)} />
                <span>{label}{ownerOnly && ' (exclusiva do proprietário)'}{catalog.sensitive.includes(k) && <Badge color="orange">sensível</Badge>}</span>
              </label>
            );
          })}
        </Card>
      ))}
    </div>
  );
}

function AccessHistory({ user, onClose }: { user: StaffUser; onClose: () => void }) {
  const { data, reload } = useLoad(() => api.get<{ events: { event: string; ip: string | null; user_agent: string | null; created_at: string }[]; sessions: { id: string; device_label: string | null; ip: string | null; last_seen_at: string }[] }>(`/api/users/${user.id}/access`));
  const label: Record<string, string> = { login_success: 'Entrou', login_failed: 'Senha incorreta', logout: 'Saiu', password_changed: 'Trocou a senha', locked: 'Bloqueio temporário', login_blocked: 'Tentou entrar bloqueado', login_locked: 'Tentou durante bloqueio' };
  return (
    <Modal title={`Acessos — ${user.name}`} wide onClose={onClose}>
      {!data ? <Loading /> : (
        <div className="grid-2">
          <div>
            <div className="section-label">Sessões ativas</div>
            <div className="list card flush">
              {data.sessions.length === 0 && <div className="list-item muted">Nenhuma.</div>}
              {data.sessions.map((s) => (
                <div key={s.id} className="list-item">
                  <div className="grow"><div>{s.device_label ?? 'Dispositivo'}</div><div className="tiny muted">{s.ip} · {fmtDateTime(s.last_seen_at)}</div></div>
                  <Button size="small" variant="danger" onClick={async () => { await api.del(`/api/users/${user.id}/sessions/${s.id}`); void reload(); }}>Encerrar</Button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="section-label">Histórico</div>
            <div className="list card flush" style={{ maxHeight: 420, overflow: 'auto' }}>
              {data.events.map((e, i) => <div key={i} className="list-item"><div className="grow"><div>{label[e.event] ?? e.event}</div><div className="tiny muted">{fmtDateTime(e.created_at)} · {e.ip}</div></div></div>)}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Roles() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<Role[]>('/api/roles'));
  const catalog = useLoad(() => api.get<PermCatalog>('/api/permissions'));
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string; permissions: string[]; isSystem: boolean } | null>(null);
  if (!data || !catalog.data) return <Loading />;
  return (
    <div className="stack">
      <Button variant="primary" icon={<Plus size={16} />} style={{ alignSelf: 'flex-start' }} onClick={() => setEdit({ name: '', description: '', permissions: [], isSystem: false })}>Novo cargo</Button>
      <div className="grid-auto">
        {data.map((r) => (
          <Card key={r.id}>
            <div className="row between"><strong>{r.name}</strong>{r.isSystem ? <Badge>Padrão</Badge> : <Badge color="purple">Personalizado</Badge>}</div>
            <p className="small muted" style={{ margin: '6px 0 10px' }}>{r.description}</p>
            <div className="small">{r.key === 'owner' ? 'Todas as permissões' : `${r.permissions.length} permissões`} · {r.userCount} funcionário(s)</div>
            {r.key !== 'owner' && <Button size="small" style={{ marginTop: 10 }} onClick={() => setEdit({ id: r.id, name: r.name, description: r.description ?? '', permissions: r.permissions, isSystem: r.isSystem })}>Editar permissões</Button>}
          </Card>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? `Cargo: ${edit.name}` : 'Novo cargo'} wide onClose={() => setEdit(null)} footer={<>
          {edit.id && !edit.isSystem && <Button variant="danger" onClick={async () => { try { await api.del(`/api/roles/${edit.id}`); setEdit(null); void reload(); } catch (e) { toast.error(e); } }}>Excluir</Button>}
          <span className="grow" />
          <Button onClick={() => setEdit(null)}>Cancelar</Button>
          <Button variant="primary" onClick={async () => {
            try {
              const body = { name: edit.name, description: edit.description || null, permissions: edit.permissions };
              if (edit.id) await api.put(`/api/roles/${edit.id}`, body); else await api.post('/api/roles', body);
              toast.success('Cargo salvo. Funcionários deste cargo precisarão entrar novamente.');
              setEdit(null);
              void reload();
            } catch (e) { toast.error(e); }
          }}>Salvar</Button>
        </>}>
          <div className="stack">
            <div className="grid-2">
              <Field label="Nome"><Input value={edit.name} disabled={edit.isSystem} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Descrição"><Textarea rows={1} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            </div>
            <p className="small muted">Relatórios financeiros, estornos e ajustes de estoque são permissões sensíveis: conceda apenas a pessoas de confiança.</p>
            <PermissionGrid catalog={catalog.data} isOn={(p) => edit.permissions.includes(p)} onToggle={(p) => setEdit({ ...edit, permissions: edit.permissions.includes(p) ? edit.permissions.filter((x) => x !== p) : [...edit.permissions, p] })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
