import { ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
import { ActionForm } from '@/components/ActionForm';
import { CommandFeed } from '@/components/CommandFeed';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { currentEstablishment } from '@/lib/data';
import { removeUser } from '../acoes';

export const metadata = { title: 'Equipe' };

/** Funcionários do bar (vindos do PC) com a opção de excluir. */
export default async function Team() {
  const { sb, est } = await currentEstablishment();
  if (!est) return null;
  const { data } = await sb.from('v_users').select('id, name, role_name, status').eq('establishment_id', est.id).neq('status', 'removed').order('name');
  const users = data ?? [];
  return (
    <div className="stack-l">
      <PageHeader title="Equipe" eyebrow="Funcionários" icon={Users}
        subtitle="Exclua quem saiu: não entra mais no PC nem no celular. Vendas, caixas e histórico continuam com o nome. Para cadastrar e mudar permissões, use o PC do bar." />
      <div className="split-form wide-first">
        <Card title="Funcionários" subtitle={`${users.length} cadastrado(s)`} icon={UserRound} flush>
          {!users.length ? (
            <Empty title="Nenhum funcionário" icon={Users}>Os funcionários cadastrados no PC do bar aparecem aqui.</Empty>
          ) : (
            <ul className="list">
              {users.map((u) => {
                const owner = u.role_name === 'Proprietário';
                return (
                  <li key={u.id as string} className="list-item">
                    <span className="avatar sm" aria-hidden="true">{String(u.name).split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
                    <div className="grow">
                      <div className="strong">{u.name as string}</div>
                      <div className="tiny muted">{u.role_name as string}</div>
                    </div>
                    {u.status === 'blocked' && <Badge color="gray">Bloqueado</Badge>}
                    {owner ? (
                      <Badge color="blue"><ShieldCheck size={12} aria-hidden="true" /> Proprietário</Badge>
                    ) : (
                      <ActionForm action={removeUser} compact reset={false} submit="Excluir" icon={<Trash2 size={14} aria-hidden="true" />} variant="ghost"
                        confirm={`Excluir ${u.name as string}? Não entra mais no sistema (nem no celular).`}>
                        <input type="hidden" name="userId" value={u.id as string} />
                        <input type="hidden" name="name" value={u.name as string} />
                      </ActionForm>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <CommandFeed types={['user.remove']} path="/equipe" />
      </div>
    </div>
  );
}
