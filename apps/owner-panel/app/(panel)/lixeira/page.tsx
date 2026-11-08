import { Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { LixeiraView } from './LixeiraView';

export const metadata = { title: 'Lixeira' };

/** Histórico do que foi apagado das comandas. Abre só com a senha da Lixeira. */
export default function Lixeira() {
  return (
    <div className="stack-l">
      <PageHeader title="Lixeira" eyebrow="Comandas" icon={Trash2}
        subtitle="Itens apagados das comandas: o quê, quanto, de qual comanda, quando, quem e o motivo. Abre com a senha da Lixeira." />
      <LixeiraView />
    </div>
  );
}
