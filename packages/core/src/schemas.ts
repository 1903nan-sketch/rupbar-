/**
 * Esquemas de entrada da API local (compartilhados entre servidor e interface).
 * O servidor SEMPRE valida com estes esquemas; a interface os usa para feedback
 * imediato no formulário.
 */
import { z } from 'zod';
import { LOSS_REASONS, PAYMENT_METHODS, STATIONS, TICKET_STATUS, HOOKAH_STATUS, CASH_MOVEMENT_TYPES } from './domain';
import { isValidCnpj, isValidCpf, isHexColor, normalizePhoneBR, onlyDigits } from './validators';

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

export const comandaOpenSchema = z.object({
  customerName: trimmed(80).min(1, 'Informe o nome do responsável'),
  customerPhone: zOptionalPhone,
  customerCpf: zOptionalCpf,
  table: optionalText(20),
  responsibleUserId: zUuid.optional(),
  notes: optionalText(200),
  clientRequestId: zUuid.optional(),
});

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
  pricingMode: z.enum(['fixed', 'per_period']),
  priceCents: zCents.min(0),
  periodMinutes: z.number().int().min(5).max(1440).default(60),
  toleranceMinutes: z.number().int().min(0).max(120).default(10),
  notes: optionalText(400),
  active: z.boolean().default(true),
});

export const essenceUseSchema = z.object({ productId: zUuid, qty: zMilli.positive() });

export const hookahStartSchema = z.object({
  hookahId: zUuid,
  comandaId: zUuid,
  essences: z.array(essenceUseSchema).default([]),
  coalProductId: zUuid.nullable().optional().transform((v) => v ?? null),
  coalUnits: z.number().int().min(0).max(50).default(0),
  notes: optionalText(200),
  clientRequestId: zUuid,
});

export const hookahRoshSchema = z.object({
  essences: z.array(essenceUseSchema).min(1),
  coalProductId: zUuid.nullable().optional().transform((v) => v ?? null),
  coalUnits: z.number().int().min(0).max(50).default(0),
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
  active: z.boolean().default(true),
});
export type PrinterInput = z.infer<typeof printerSchema>;

export const tvApproveSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Código de 6 dígitos'),
  name: trimmed(40).default('TV'),
});

export const cloudConnectSchema = z.object({
  supabaseUrl: z.string().trim().url(),
  anonKey: z.string().trim().min(20),
  email: zEmail,
  password: z.string().min(1).max(128),
});

export const whatsappSchema = z.object({
  provider: z.enum(['disabled', 'meta', 'twilio', 'webhook']),
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
});
export type WhatsAppInput = z.infer<typeof whatsappSchema>;
