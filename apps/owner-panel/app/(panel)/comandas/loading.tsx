import { TablePageSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return <TablePageSkeleton label="Carregando comandas…" stats={3} rows={10} cols={6} />;
}
