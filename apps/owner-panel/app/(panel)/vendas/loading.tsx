import { TablePageSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return <TablePageSkeleton label="Carregando vendas…" stats={4} chart rows={6} cols={5} />;
}
