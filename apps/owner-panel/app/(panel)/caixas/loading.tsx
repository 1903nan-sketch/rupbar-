import { TablePageSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return <TablePageSkeleton label="Carregando caixas…" stats={3} rows={6} cols={6} />;
}
