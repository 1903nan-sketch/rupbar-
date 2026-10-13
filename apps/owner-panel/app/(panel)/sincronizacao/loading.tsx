import { TablePageSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return <TablePageSkeleton label="Carregando sincronização…" stats={3} rows={3} cols={3} />;
}
