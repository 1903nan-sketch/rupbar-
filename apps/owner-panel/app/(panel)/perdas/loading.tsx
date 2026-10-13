import { TablePageSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return <TablePageSkeleton label="Carregando perdas…" stats={3} chart rows={6} cols={7} />;
}
