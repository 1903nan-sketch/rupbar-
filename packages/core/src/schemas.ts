/**
 * Esquemas de entrada da API local (compartilhados entre servidor e interface).
 * O servidor SEMPRE valida com estes esquemas; a interface os usa para feedback
 * imediato no formulário.
 */
import { z } from 'zod';
import { LOSS_REASONS, PAYMENT_METHODS, STATIONS, TICKET_STATUS, HOOKAH_STATUS, CASH_MOVEMENT_TYPES } from './domain';
import { isValidCnpj, isValidCpf, isHexColor, normalizePhoneBR, onlyDigits } from './validators';
import { normalizePixKey, PIX_CITY_MAX, PIX_KEY_TYPES, PIX_NAME_MAX, sanitizePixText } from './pix';
import { EVOLUTION_INSTANCE_RE, normalizeEvolutionUrl } from './whatsapp';

const keys = <T extends Record<string, unknown>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

export const zUuid = z.string().uuid();
export const zCents = z.number().int().safe();
export const zPositiveCents = zCents.positive('Informe um valor maior que zero');
export const zMilli = z.number().int().safe();
const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const zEmail = z.string().trim().toLowerCase().email('E-mail inválido').max(254);
export const zPassword = z.string().min(8, 'A senha deve ter pelo menos 8 caracteres').max(128);

export const zPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return null;
    const n = normalizePhoneBR(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Telefone inválido (use DDD + número)' });
      return z.NEVER;
    }
    return n;
  });
export const zOptionalPhone = zPhone.optional().nullable().transform((v) => v ?? null);

export const zOptionalCpf = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!isValidCpf(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CPF inválido' });
      return z.NEVER;
    }
    return onlyDigits(v);
  });

export const zOptionalCnpj = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!isValidCnpj(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CNPJ inválido' });
      return z.NEVER;
    }
    return onlyDigits(v);
  });

export const zColor = z.string().refine(isHexColor, 'Cor inválida (use #RRGGBB)');
export const zStation = z.enum(keys(STATIONS));
export const zPaymentMethod = z.enum(keys(PAYMENT_METHODS));
export const zLossReason = z.enum(keys(LOSS_REASONS));
export const zTicketStatus = z.enum(keys(TICKET_STATUS));
export const zHookahStatus = z.enum(keys(HOOKAH_STATUS));
export const zMeasure = z.enum(['unit', 'volume', 'mass']);

export const addressSchema = z.object({
  street: trimmed(160).default(''),
  number: trimmed(20).default(''),
  complement: trimmed(80).default(''),
  district: trimmed(80).default(''),
  city: trimmed(80).default(''),
  state: trimmed(2).default(''),
  zip: trimmed(9).default(''),
});
export type Address = z.infer<typeof addressSchema>;

export const identitySchema = z.object({
  tradeName: trimmed(80).min(2, 'Informe o nome do estabelecimento'),
  legalName: optionalText(120),
  cnpj: zOptionalCnpj,
  phone: zOptionalPhone,
  address: addressSchema.default({}),
  primaryColor: zColor.default('#0A84FF'),
  secondaryColor: zColor.default('#1C1C1E'),
  instagram: optionalText(80),
  facebook: optionalText(120),
  whatsapp: zOptionalPhone,
  website: optionalText(120),
});
export type IdentityInput = z.infer<typeof identitySchema>;

export const operationSettingsSchema = z.object({
  allowNegativeStock: z.boolean().default(false),
  serviceFeeBp: z.number().int().min(0).max(3000).default(0),
  requireCashSessionForPayments: z.boolean().default(true),
  defaultOpeningBalanceCents: zCents.min(0).default(0),
  defaultGramsPerRosh: z.number().int().min(1_000).max(100_000).default(12_000),
  hookahRequiresCleaning: z.boolean().default(true),
  requireCustomerPhone: z.boolean().default(false),
  requireCustomerCpf: z.boolean().default(false),
  autoPrintOrders: z.boolean().default(true),
  pickupPlace: trimmed(40).default('no balcão'),
  tvVoiceEnabled: z.boolean().default(true),
  lowStockAlertsEnabled: z.boolean().default(true),
});
export type OperationSettings = z.infer<typeof operationSettingsSchema>;

export const zPixKeyType = z.enum(keys(PIX_KEY_TYPES));

/**
 * Pix copia e cola estático. A chave é guardada normalizada (formato do DICT);
 * nome e cidade como digitados — o BR Code remove acentos e trunca na geração.
 * Com o Pix ativo, chave, nome e cidade são obrigatórios.
 */
export const pixSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    keyType: zPixKeyType.default('cnpj'),
    key: z.string().trim().max(100).default(''),
    merchantName: trimmed(60).default(''),
    merchantCity: trimmed(60).default(''),
  })
  .transform((v, ctx) => {
    let key = v.key;
    if (key) {
      const r = normalizePixKey(v.keyType, key);
      if (r.ok) key = r.key;
      else ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: r.error });
    } else if (v.enabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: 'Informe a chave Pix.' });
    }
    if (v.enabled && !sanitizePixText(v.merchantName, PIX_NAME_MAX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['merchantName'], message: 'Informe o nome do recebedor.' });
    }
    if (v.enabled && !sanitizePixText(v.merchantCity, PIX_CITY_MAX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['merchantCity'], message: 'Informe a cidade do recebedor.' });
    }
    return { ...v, key };
  });
export type PixSettings = z.infer<typeof pixSettingsSchema>;

/** Consulta do Pix copia e cola: valor em centavos (0 = cliente digita) e comanda opcional (txid). */
export const pixPayloadQuerySchema = z.object({
  amountCents: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? 0 : Number(v)),
    z.number({ invalid_type_error: 'Valor inválido' }).int('Valor inválido').min(0, 'Valor inválido').max(9_999_999_999, 'Valor muito alto'),
  ),
  comandaId: z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional()),
});

export const setupSchema = z.object({
  identity: identitySchema,
  owner: z.object({
    name: trimmed(80).min(2, 'Informe o nome do proprietário'),
    email: zEmail,
    password: zPassword,
  }),
  operation: operationSettingsSchema.default({}),
  seedCategories: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535).optional(),
});
export type SetupInput = z.infer<typeof setupSchema>;

export const loginSchema = z.object({
  email: zEmail,
  password: z.string().min(1).max(128),
  deviceLabel: optionalText(60),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: zPassword,
});

export const userCreateSchema = z.object({
  name: trimmed(80).min(2),
  email: zEmail,
  roleId: zUuid,
  grants: z.array(z.string()).default([]),
  denies: z.array(z.string()).default([]),
});

export const userUpdateSchema = z.object({
  name: trimmed(80).min(2).optional(),
  roleId: zUuid.optional(),
  grants: z.array(z.string()).optional(),
  denies: z.array(z.string()).optional(),
  status: z.enum(['active', 'blocked']).optional(),
});

export const roleSchema = z.object({
  name: trimmed(40).min(2),
  description: optionalText(200),
  permissions: z.array(z.string()).default([]),
});

export const categorySchema = z.object({
  name: trimmed(40).min(2),
  station: zStation.default('none'),
  icon: optionalText(30),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
});

export const componentSchema = z.object({
  /** null = o próprio produto (ex.: "Dose 50 ml" do próprio whisky). */
  productId: zUuid.nullable(),
  qty: zMilli.positive('Quantidade do ingrediente deve ser maior que zero'),
});

export const presentationSchema = z.object({
  id: zUuid.optional(),
  name: trimmed(60).min(1),
  priceCents: zCents.min(0),
  components: z.array(componentSchema).default([]),
  menuVisible: z.boolean().default(true),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const productSchema = z.object({
  name: trimmed(80).min(2),
  categoryId: zUuid,
  internalCode: optionalText(30),
  barcode: optionalText(32),
  description: optionalText(400),
  supplierId: zUuid.nullable().optional().transform((v) => v ?? null),
  measure: zMeasure,
  /** Conteúdo de uma embalagem em milli (ex.: garrafa 1 L = 1_000_000). */
  packageQty: zMilli.positive().default(1000),
  packageLabel: optionalText(30),
  stockTracked: z.boolean().default(true),
  minStock: zMilli.min(0).default(0),
  /** Custo por unidade-base × 10⁴ (opcional; normalmente vem das entradas). */
  unitCostE4: z.number().int().min(0).optional(),
  expiryTracked: z.boolean().default(false),
  menuVisible: z.boolean().default(true),
  station: zStation.nullable().optional().transform((v) => v ?? null),
  active: z.boolean().default(true),
  presentations: z.array(presentationSchema).default([]),
  /** Entrada opcional no cadastro inicial, registrada na mesma transação. */
  initialStock: z.object({
    packages: z.number().positive().max(100_000),
    totalCostCents: zCents.min(0),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).optional(),
});
export type ProductInput = z.infer<typeof productSchema>;

export const supplierSchema = z.object({
  name: trimmed(80).min(2),
  cnpj: zOptionalCnpj,
  phone: zOptionalPhone,
  email: zEmail.optional().nullable().or(z.literal('')).transform((v) => v || null),
  contactName: optionalText(80),
  notes: optionalText(400),
  active: z.boolean().default(true),
});

export const purchaseSchema = z.object({
  supplierId: zUuid.nullable().optional().transform((v) => v ?? null),
  invoiceNumber: optionalText(40),
  purchasedAt: z.string().datetime().optional(),
  notes: optionalText(400),
  attachmentId: zUuid.nullable().optional().transform((v) => v ?? null),
  items: z
    .array(
      z.object({
        productId: zUuid,
        /** Número de embalagens (pode ser fracionário, ex.: 0,5 kg). */
        packages: z.number().positive().max(100_000),
        /** Tamanho de cada embalagem em milli (permite 50 g e 100 g do mesmo produto). */
        packageQty: zMilli.positive(),
        totalCostCents: zCents.min(0),
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
        lotCode: optionalText(40),
      }),
    )
    .min(1, 'Inclua ao menos um item'),
});

export const adjustmentSchema = z.object({
  productId: zUuid,
  /** Novo saldo contado (milli). */
  countedQty: zMilli,
  reason: trimmed(200).min(3, 'Informe o motivo do ajuste'),
});

export const inventorySchema = z.object({
  notes: optionalText(400),
  items: z.array(z.object({ productId: zUuid, countedQty: zMilli.min(0) })).min(1),
});

export const zCardNumber = z.number().int('Número do cartão inválido').min(1, 'Número do cartão inválido').max(99_999, 'Número do cartão inválido');

export const comandaOpenSchema = z
  .object({
    customerName: trimmed(80).default(''),
    /** Número do cartão/comanda física (opcional). Único entre as comandas abertas. */
    cardNumber: zCardNumber.nullable().optional().transform((v) => v ?? null),
    customerPhone: zOptionalPhone,
    customerCpf: zOptionalCpf,
    table: optionalText(20),
    responsibleUserId: zUuid.optional(),
    notes: optionalText(200),
    clientRequestId: zUuid.optional(),
  })
  .refine((v) => v.customerName.length > 0 || v.cardNumber !== null, { message: 'Informe o nome do cliente ou o número do cartão', path: ['customerName'] });

export const comandaEditSchema = z
  .object({
    customerName: trimmed(80).default(''),
    cardNumber: zCardNumber.nullable().optional().transform((v) => v ?? null),
    table: optionalText(20),
    notes: optionalText(200),
    expectedVersion: z.number().int(),
  })
  .refine((v) => v.customerName.length > 0 || v.cardNumber !== null, { message: 'Informe o nome do cliente ou o número do cartão', path: ['customerName'] });

export const orderItemSchema = z.object({
  presentationId: zUuid,
  quantity: z.number().int().min(1).max(99),
  notes: optionalText(140),
});

export const orderCreateSchema = z.object({
  comandaId: zUuid,
  /** Gerado no dispositivo; repetir o envio com o mesmo id não duplica o pedido. */
  clientRequestId: zUuid,
  items: z.array(orderItemSchema).min(1, 'Adicione ao menos um item').max(60),
  notes: optionalText(200),
});

export const cancelItemSchema = z.object({
  reason: trimmed(200).min(3, 'Informe a justificativa'),
  returnToStock: z.boolean().default(true),
});

export const versionSchema = z.object({ expectedVersion: z.number().int().min(1) });

export const transferSchema = versionSchema.extend({ table: trimmed(20).min(1) });

export const moveItemsSchema = versionSchema.extend({
  itemIds: z.array(zUuid).min(1),
  targetComandaId: zUuid,
});

export const discountSchema = versionSchema.extend({
  discountCents: zCents.min(0),
  reason: trimmed(200).min(3),
});

export const serviceFeeSchema = versionSchema.extend({ serviceFeeBp: z.number().int().min(0).max(3000) });

export const paymentSchema = z.object({
  comandaId: zUuid,
  method: zPaymentMethod,
  amountCents: zPositiveCents,
  /** Valor entregue pelo cliente (dinheiro), para cálculo de troco. */
  receivedCents: zCents.min(0).optional(),
  payerLabel: optionalText(40),
  clientRequestId: zUuid,
});

export const reversePaymentSchema = z.object({ reason: trimmed(200).min(3) });

// ------------------------------------------------- correções da conta mestre

const zOverrideReason = trimmed(200).min(3, 'Informe o motivo da correção');
export const overrideReasonSchema = z.object({ reason: zOverrideReason });
export const overrideDeleteSchema = z.object({ reason: zOverrideReason, returnToStock: z.boolean().default(true) });
export const overrideItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
  unitPriceCents: zCents.min(0),
  reason: zOverrideReason,
});
export const overridePaymentSchema = z.object({ method: zPaymentMethod, amountCents: zPositiveCents, reason: zOverrideReason });
export const overrideCashMovementSchema = z.object({ amountCents: zPositiveCents, description: trimmed(200).min(3), reason: zOverrideReason });
export const overrideCashSessionSchema = z.object({
  openingBalanceCents: zCents.min(0).optional(),
  countedCashCents: zCents.min(0).nullable().optional(),
  reason: zOverrideReason,
});

/** Venda rápida (balcão): itens + pagamento na hora; o cliente é chamado pelo nome na TV. */
export const quickSaleSchema = z.object({
  clientRequestId: zUuid,
  customerName: trimmed(60).default(''),
  items: z.array(orderItemSchema).min(1, 'Adicione ao menos um item').max(60),
  payments: z
    .array(z.object({ method: zPaymentMethod, amountCents: zPositiveCents, receivedCents: zCents.min(0).optional() }))
    .min(1, 'Informe o pagamento')
    .max(6),
  notes: optionalText(200),
  printReceipt: z.boolean().default(false),
});

export const closeComandaSchema = versionSchema;
export const cancelComandaSchema = versionSchema.extend({
  reason: trimmed(200).min(3),
  returnToStock: z.boolean().default(true),
});

export const cashOpenSchema = z.object({
  openingBalanceCents: zCents.min(0),
  notes: optionalText(200),
});

export const cashMovementSchema = z.object({
  type: z.enum(keys(CASH_MOVEMENT_TYPES)),
  amountCents: zPositiveCents,
  reason: trimmed(200).min(3, 'Informe o motivo'),
  attachmentId: zUuid.nullable().optional().transform((v) => v ?? null),
  clientRequestId: zUuid,
});

export const cashCloseSchema = z.object({
  countedCashCents: zCents.min(0),
  notes: optionalText(400),
});

export const lossSchema = z.object({
  productId: zUuid,
  qty: zMilli.positive('Quantidade deve ser maior que zero'),
  /** Unidade em que o usuário informou (apenas exibição: un, ml, l, g, kg). */
  unit: z.enum(['un', 'ml', 'l', 'g', 'kg']),
  reason: zLossReason,
  occurredAt: z.string().datetime().optional(),
  notes: optionalText(400),
  attachmentId: zUuid.nullable().optional().transform((v) => v ?? null),
  clientRequestId: zUuid.optional(),
});
export type LossInput = z.infer<typeof lossSchema>;

export const lossResolveSchema = z.object({
  action: z.enum(['apply_available', 'apply_full', 'reject']),
  note: trimmed(200).min(3),
});

export const hookahSchema = z.object({
  code: trimmed(20).min(1),
  model: trimmed(60).default(''),
  /** Legado: o preço agora vem da tabela única (hookahPricingSchema). */
  pricingMode: z.enum(['fixed', 'per_period']).default('fixed'),
  priceCents: zCents.min(0).default(0),
  periodMinutes: z.number().int().min(5).max(1440).default(60),
  toleranceMinutes: z.number().int().min(0).max(120).default(10),
  notes: optionalText(400),
  active: z.boolean().default(true),
});

export const essenceUseSchema = z.object({ productId: zUuid, qty: zMilli.positive() });

/**
 * Tabela de preços do narguilé (uma só para a casa, fácil de alterar):
 *  - aluguel: aparelho da casa, já inclui a 1ª essência e o carvão;
 *  - troca de rosh: nova essência/carvão no aparelho da casa;
 *  - rosh do narguilé próprio: cliente traz o aparelho e compra essência + carvão.
 * Essências não têm preço de venda: só controlam estoque e custo.
 */
export const hookahPricingSchema = z.object({
  rentalCents: zCents.min(0).default(2000),
  roshSwapCents: zCents.min(0).default(1000),
  ownRoshCents: zCents.min(0).default(1500),
});
export type HookahPricingTable = z.infer<typeof hookahPricingSchema>;

export const hookahStartSchema = z
  .object({
    /** 'house' = aparelho do bar (aluguel); 'own' = narguilé do cliente. */
    mode: z.enum(['house', 'own']).default('house'),
    hookahId: zUuid.nullable().optional().transform((v) => v ?? null),
    /** Identificação do narguilé próprio (ex.: "do Pedro", "preto"). */
    ownLabel: optionalText(40),
    comandaId: zUuid,
    essences: z.array(essenceUseSchema).default([]),
    coalProductId: zUuid.nullable().optional().transform((v) => v ?? null),
    coalUnits: z.number().int().min(0).max(50).default(0),
    notes: optionalText(200),
    clientRequestId: zUuid,
  })
  .refine((v) => v.mode === 'own' || v.hookahId !== null, { message: 'Escolha o narguilé', path: ['hookahId'] });

export const hookahRoshSchema = z.object({
  essences: z.array(essenceUseSchema).default([]),
  coalProductId: zUuid.nullable().optional().transform((v) => v ?? null),
  coalUnits: z.number().int().min(0).max(50).default(0),
  /** Troca cortesia: registra o consumo sem cobrar. */
  charge: z.boolean().default(true),
  clientRequestId: zUuid.optional(),
});

export const hookahFinishSchema = z.object({
  sendToCleaning: z.boolean().default(true),
  notes: optionalText(200),
});

export const hookahStatusSchema = z.object({
  status: zHookahStatus,
  notes: optionalText(200),
});

export const ticketStatusSchema = z.object({ status: zTicketStatus });

export const printerSchema = z.object({
  name: trimmed(40).min(1),
  transport: z.enum(['network', 'windows', 'file']),
  host: optionalText(120),
  port: z.number().int().min(1).max(65535).default(9100),
  windowsName: optionalText(120),
  filePath: optionalText(260),
  paper: z.union([z.literal(58), z.literal(80)]).default(80),
  codepage: z.enum(['cp850', 'cp860', 'ascii']).default('cp850'),
  stations: z.array(zStation).default([]),
  printReceipts: z.boolean().default(false),
  autoPrint: z.boolean().default(true),
  beep: z.boolean().default(false),
  /** Imprime o QR Code do Pix na conta (desative em impressoras sem suporte a QR). */
  printQr: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type PrinterInput = z.infer<typeof printerSchema>;

export const tvApproveSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Código de 6 dígitos'),
  name: trimmed(40).default('TV'),
});

const asciiOnly = (v: unknown) => (typeof v === 'string' ? v.replace(/[^\x21-\x7E]/g, '') : v);

export const cloudConnectSchema = z.object({
  /** Vazios = nuvem padrão do RupBar. */
  // Valores colados de chats/PDFs podem trazer caracteres invisíveis: URL e chave são ASCII puro.
  supabaseUrl: z.preprocess(asciiOnly, z.string().url('URL do projeto inválida (ex.: https://xxxx.supabase.co)').or(z.literal('')).default('')),
  anonKey: z.preprocess(asciiOnly, z.string().min(20, 'Chave pública incompleta').or(z.literal('')).default('')),
  email: zEmail,
  password: z.string().min(1).max(128),
});

/** Texto vazio vira "não informado" (mantém o valor já salvo). */
const blankAsUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/**
 * Dados da Evolution API. Todos opcionais: o que não vier mantém o valor salvo
 * (a chave nunca volta para a tela, então "em branco" = manter).
 */
export const evolutionCredentialsSchema = z.object({
  baseUrl: z.preprocess(
    (v) => blankAsUndefined(typeof v === 'string' ? normalizeEvolutionUrl(v) : v),
    z
      .string()
      .max(300)
      .url('Endereço da Evolution inválido (ex.: https://evo.seudominio.com.br)')
      .refine((v) => /^https?:\/\//i.test(v), 'O endereço deve começar com http:// ou https://')
      .optional(),
  ),
  apiKey: z.preprocess((v) => blankAsUndefined(asciiOnly(v)), z.string().max(400, 'Chave da API muito longa').optional()),
  instance: z.preprocess(
    blankAsUndefined,
    z.string().trim().regex(EVOLUTION_INSTANCE_RE, 'Nome da instância: use letras, números, "-" ou "_", sem espaços (ex.: rupbar)').optional(),
  ),
});
export type EvolutionCredentialsInput = z.infer<typeof evolutionCredentialsSchema>;

/** Quais avisos o proprietário quer receber. */
export const whatsappAlertsSchema = z.object({ stockLow: z.boolean(), cashClosed: z.boolean() }).partial();

export const whatsappSchema = z.object({
  provider: z.enum(['disabled', 'meta', 'twilio', 'webhook', 'evolution']),
  ownerPhone: zOptionalPhone,
  meta: z
    .object({
      phoneNumberId: trimmed(40),
      accessToken: z.string().max(400),
      /** Mensagens iniciadas pela empresa exigem modelo aprovado na Meta. */
      templateName: trimmed(80),
      templateLanguage: trimmed(10),
    })
    .partial()
    .optional(),
  twilio: z.object({ accountSid: trimmed(64), authToken: z.string().max(128), from: trimmed(32) }).partial().optional(),
  webhook: z.object({ url: z.string().trim().url(), token: z.string().max(400) }).partial().optional(),
  evolution: evolutionCredentialsSchema.optional(),
  alerts: whatsappAlertsSchema.optional(),
});
export type WhatsAppInput = z.infer<typeof whatsappSchema>;

/** Mensagem de teste: telefone digitado na tela ou, em branco, o do proprietário. */
export const whatsappSendTestSchema = z.object({ phone: zOptionalPhone }).partial();
