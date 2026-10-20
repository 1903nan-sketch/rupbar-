/**
 * Catálogo de permissões e perfis iniciais.
 *
 * O backend valida TODA requisição contra este catálogo; a interface apenas
 * esconde o que o usuário não pode fazer.
 */

export const PERMISSIONS = {
  // Comandas e pedidos
  'comandas.view': 'Ver comandas',
  'comandas.open': 'Abrir comandas',
  'comandas.edit': 'Lançar itens e editar comandas',
  'comandas.transfer': 'Transferir mesa / mover itens',
  'comandas.cancel_item': 'Cancelar itens (com justificativa)',
  'comandas.cancel': 'Cancelar comandas inteiras',
  'comandas.discount': 'Conceder descontos',
  'comandas.close': 'Encerrar comandas',
  'menu.view': 'Ver cardápio',
  'orders.create': 'Enviar pedidos',
  'orders.view': 'Acompanhar pedidos',
  // Produção
  'kitchen.view': 'Ver painel da cozinha/balcão',
  'kitchen.update': 'Atualizar status de pedidos',
  'kitchen.call': 'Chamar clientes na TV',
  // Caixa
  'cash.view': 'Ver caixa atual',
  'cash.open': 'Abrir caixa',
  'cash.close': 'Fechar caixa',
  'cash.payment': 'Receber pagamentos',
  'cash.payment_reverse': 'Estornar pagamentos',
  'cash.withdrawal': 'Realizar sangrias',
  'cash.supply': 'Registrar suprimentos',
  // Produtos e estoque
  'products.view': 'Ver produtos',
  'products.manage': 'Cadastrar e editar produtos',
  'stock.view': 'Ver estoque',
  'stock.entry': 'Registrar entrada de mercadorias',
  'stock.adjust': 'Ajustar estoque / inventário',
  'suppliers.manage': 'Gerenciar fornecedores',
  'losses.view': 'Ver perdas',
  'losses.confirm': 'Registrar/confirmar perdas',
  // Narguilés
  'hookah.view': 'Ver narguilés',
  'hookah.rent': 'Registrar locações',
  'hookah.manage': 'Cadastrar aparelhos e status',
  // Relatórios
  'reports.operational': 'Relatórios operacionais (sem valores financeiros)',
  'reports.financial': 'Relatórios financeiros',
  // Administração
  'users.manage': 'Gerenciar funcionários e permissões',
  'roles.manage': 'Gerenciar cargos',
  'settings.manage': 'Alterar configurações',
  'devices.manage': 'Conectar dispositivos e TV',
  'printers.manage': 'Configurar impressoras',
  'audit.view': 'Ver auditoria',
  'sync.manage': 'Configurar sincronização',
  'admin.override': 'Editar e excluir qualquer lançamento (conta mestre)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Permissões exclusivas do proprietário: nunca podem ser concedidas a outro cargo.
 * ("Somente o proprietário poderá criar contas, alterar permissões, redefinir
 * credenciais e confirmar perdas.")
 */
export const OWNER_ONLY: readonly Permission[] = ['users.manage', 'roles.manage', 'losses.confirm', 'sync.manage', 'admin.override'];

/** Permissões sensíveis: podem ser concedidas, mas a interface exige confirmação. */
/**
 * "Também trabalha no caixa": o que um garçom (ou outro cargo) ganha para abrir
 * e fechar o caixa, receber pagamentos, encerrar comandas, sangria e suprimento.
 * Estornos ficam de fora (são sensíveis).
 */
export const CASHIER_EXTRA: readonly Permission[] = [
  'cash.view', 'cash.open', 'cash.close', 'cash.payment', 'cash.withdrawal', 'cash.supply', 'comandas.close',
];

/**
 * "Cobra no celular": o garçom recebe (Pix, dinheiro, cartão), encerra a
 * comanda paga e faz venda rápida, sem abrir nem fechar o caixa.
 */
export const CHARGE_EXTRA: readonly Permission[] = ['cash.payment', 'comandas.close'];

export const SENSITIVE: readonly Permission[] = ['reports.financial', 'cash.payment_reverse', 'comandas.cancel', 'stock.adjust'];

export type SystemRoleKey = 'owner' | 'manager' | 'cashier' | 'waiter' | 'kitchen';

const operational: Permission[] = [
  'comandas.view', 'comandas.open', 'comandas.edit', 'menu.view', 'orders.create', 'orders.view',
];

export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; description: string; permissions: Permission[] }> = {
  owner: {
    name: 'Proprietário',
    description: 'Acesso administrativo completo.',
    permissions: [...ALL_PERMISSIONS],
  },
  manager: {
    name: 'Gerente',
    description: 'Operação e relatórios autorizados, sem criar contas e sem registrar perdas.',
    permissions: [
      ...operational,
      'comandas.transfer', 'comandas.cancel_item', 'comandas.cancel', 'comandas.discount', 'comandas.close',
      'kitchen.view', 'kitchen.update', 'kitchen.call',
      'cash.view', 'cash.open', 'cash.close', 'cash.payment', 'cash.payment_reverse', 'cash.withdrawal', 'cash.supply',
      'products.view', 'products.manage', 'stock.view', 'stock.entry', 'stock.adjust', 'suppliers.manage', 'losses.view',
      'hookah.view', 'hookah.rent', 'hookah.manage',
      'reports.operational',
      'devices.manage', 'printers.manage', 'audit.view',
    ],
  },
  cashier: {
    name: 'Caixa',
    description: 'Abertura, movimentação e fechamento de caixa, pagamentos e sangrias.',
    permissions: [
      'comandas.view', 'comandas.open', 'comandas.edit', 'comandas.close', 'menu.view', 'orders.create', 'orders.view',
      'cash.view', 'cash.open', 'cash.close', 'cash.payment', 'cash.withdrawal', 'cash.supply',
      'products.view', 'hookah.view', 'hookah.rent',
    ],
  },
  waiter: {
    name: 'Garçom',
    description: 'Comandas, cardápio, registro e acompanhamento de pedidos.',
    permissions: [...operational, 'products.view', 'hookah.view', 'hookah.rent'],
  },
  kitchen: {
    name: 'Cozinha/Balcão',
    description: 'Visualização de pedidos, atualização de status e chamada de clientes.',
    permissions: ['kitchen.view', 'kitchen.update', 'kitchen.call', 'orders.view', 'menu.view'],
  },
};

export interface PermissionSubject {
  roleKey: string | null;
  rolePermissions: readonly string[];
  /** Ajustes individuais: concedidas além do cargo. */
  grants?: readonly string[];
  /** Ajustes individuais: removidas do cargo. */
  denies?: readonly string[];
}

/** Calcula o conjunto efetivo de permissões de um usuário. */
export function effectivePermissions(subject: PermissionSubject): Set<Permission> {
  const isOwner = subject.roleKey === 'owner';
  if (isOwner) return new Set(ALL_PERMISSIONS);
  const set = new Set<Permission>();
  for (const p of subject.rolePermissions) if (p in PERMISSIONS) set.add(p as Permission);
  for (const p of subject.grants ?? []) if (p in PERMISSIONS) set.add(p as Permission);
  for (const p of subject.denies ?? []) set.delete(p as Permission);
  for (const p of OWNER_ONLY) set.delete(p);
  return set;
}

/** Remove de uma lista as permissões inválidas ou exclusivas do proprietário. */
export function sanitizeGrantable(perms: readonly string[]): Permission[] {
  return Array.from(new Set(perms)).filter(
    (p): p is Permission => p in PERMISSIONS && !OWNER_ONLY.includes(p as Permission),
  );
}

/** Agrupamento para a tela de permissões. */
export const PERMISSION_GROUPS: { label: string; prefix: string[] }[] = [
  { label: 'Comandas e pedidos', prefix: ['comandas.', 'menu.', 'orders.'] },
  { label: 'Cozinha e balcão', prefix: ['kitchen.'] },
  { label: 'Caixa', prefix: ['cash.'] },
  { label: 'Produtos e estoque', prefix: ['products.', 'stock.', 'suppliers.', 'losses.'] },
  { label: 'Narguilés', prefix: ['hookah.'] },
  { label: 'Relatórios', prefix: ['reports.'] },
  { label: 'Administração', prefix: ['users.', 'roles.', 'settings.', 'devices.', 'printers.', 'audit.', 'sync.'] },
];
