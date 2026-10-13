import { BarChart3, Boxes, ClipboardList, Cloud, LayoutDashboard, PackageMinus, Wallet, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  short: string;
  icon: LucideIcon;
  /** Aparece na barra inferior do celular (os demais ficam em "Mais"). */
  primary?: boolean;
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Visão geral', short: 'Início', icon: LayoutDashboard, primary: true },
  { href: '/vendas', label: 'Vendas', short: 'Vendas', icon: BarChart3, primary: true },
  { href: '/comandas', label: 'Comandas', short: 'Comandas', icon: ClipboardList, primary: true },
  { href: '/estoque', label: 'Estoque', short: 'Estoque', icon: Boxes, primary: true },
  { href: '/perdas', label: 'Perdas', short: 'Perdas', icon: PackageMinus },
  { href: '/caixas', label: 'Caixas e sangrias', short: 'Caixas', icon: Wallet },
  { href: '/sincronizacao', label: 'Sincronização', short: 'Sincronização', icon: Cloud },
];

export function isActive(href: string, path: string): boolean {
  return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
}
