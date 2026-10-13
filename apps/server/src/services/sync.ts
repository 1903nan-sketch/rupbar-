import { backoffMs, RUPBAR_CLOUD, type CommandResult, type PushResponse, type RemoteCommand, type SyncRecord, type SyncStatus } from '@rupbar/core';
import { cloudConnectSchema } from '@rupbar/core/schemas';
import { SYNCED_TABLES, TABLE_BY_ENTITY } from '../db/sync-tables';
import { AppError, badRequest } from '../lib/errors';
import { requirePerm, type Actor, type Ctx } from './context';
import type { LossesService } from './losses';
import type { SettingsService } from './settings';

const BATCH = 200;

/** Configuração da nuvem guardada localmente (segredo do dispositivo cifrado). */
interface CloudConfig {
  supabaseUrl: string;
  anonKey: string;
  deviceId: string;
  deviceSecretSealed: string;
  establishmentId: string;
  ownerEmail: string;
  connectedAt: string;
}

/** Falha antes de obter resposta da nuvem (sem internet, DNS, TLS, bloqueio). */
export class NetworkError extends AppError {
  constructor(readonly causeCode: string, detail: string) {
    super(502, 'CLOUD_UNREACHABLE', networkMessage(causeCode, detail));
  }
}

function networkMessage(code: string, detail: string): string {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return 'O PC não encontrou o endereço da nuvem. Confira se há internet no PC e se a URL do projeto está correta.';
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) {
    return 'A conexão segura com a nuvem foi bloqueada (certificado). Um antivírus ou firewall pode estar inspecionando conexões HTTPS: libere o RupBar nele ou atualize o RupBar.';
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'TimeoutError', 'AbortError'].includes(code)) {
    return 'A nuvem não respondeu. Verifique a internet do PC ou se um firewall está bloqueando o RupBar.';
  }
  return `Não foi possível falar com a nuvem (${code || detail}). Verifique a internet do PC.`;
}

function errorCode(err: unknown): { code: string; detail: string } {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string; name?: string } };
  const code = e?.cause?.code ?? e?.code ?? (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? e.name : '') ?? '';
  return { code: String(code), detail: e?.cause?.message ?? e?.message ?? 'falha de rede' };
}

/** Cliente das funções RPC do Supabase usadas pelo PC do bar. */
export interface CloudApi {
  signIn(url: string, anonKey: string, email: string, password: string): Promise<{ accessToken: string }>;
  registerDevice(url: string, anonKey: string, accessToken: string, args: { establishmentId: string; name: string; tradeName: string }): Promise<{ deviceId: string; deviceSecret: string; establishmentId: string }>;
  push(cfg: { url: string; anonKey: string; deviceId: string; secret: string }, records: SyncRecord[]): Promise<PushResponse>;
  pull(cfg: { url: string; anonKey: string; deviceId: string; secret: string }, limit: number): Promise<RemoteCommand[]>;
  ack(cfg: { url: string; anonKey: string; deviceId: string; secret: string }, results: CommandResult[]): Promise<void>;
  heartbeat(cfg: { url: string; anonKey: string; deviceId: string; secret: string }, status: Record<string, unknown>): Promise<void>;
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    const { code, detail } = errorCode(err);
    throw new NetworkError(code, detail);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; msg?: string; error_description?: string };
      msg = j.message ?? j.error_description ?? j.msg ?? msg;
    } catch {
      /* texto puro */
    }
    throw new AppError(res.status >= 500 ? 502 : 400, 'CLOUD_ERROR', translateCloudError(res.status, msg));
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Mensagens do Supabase em português, com a ação que resolve. */
export function translateCloudError(status: number, msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha do painel online incorretos. Use o mesmo login do painel (se você entra pelo Google, crie uma senha em "Esqueci minha senha" no painel).';
  if (/email not confirmed/i.test(msg)) return 'Este e-mail ainda não foi confirmado. Abra o e-mail de confirmação do Supabase e tente de novo.';
  if (/invalid api key|no api key/i.test(msg) || status === 401) return 'A chave pública (anon) não confere com a URL do projeto. Copie as duas de novo.';
  if (/pertence a outra conta/i.test(msg)) return 'Este bar já está ligado a outra conta do painel. Entre com o e-mail do proprietário original.';
  if (status === 404) return 'O RupBar não está instalado neste projeto da nuvem. Confira a URL do projeto.';
  return `Nuvem: ${msg}`;
}

export const supabaseCloudApi: CloudApi = {
  async signIn(url, anonKey, email, password) {
    const r = await call<{ access_token: string }>(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    return { accessToken: r.access_token };
  },
  async registerDevice(url, anonKey, accessToken, args) {
    const r = await call<{ device_id: string; device_secret: string; establishment_id: string }>(`${url}/rest/v1/rpc/rupbar_register_device`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_establishment_id: args.establishmentId, p_device_name: args.name, p_trade_name: args.tradeName }),
    });
    return { deviceId: r.device_id, deviceSecret: r.device_secret, establishmentId: r.establishment_id };
  },
  async push(cfg, records) {
    return call<PushResponse>(`${cfg.url}/rest/v1/rpc/rupbar_device_push`, {
      method: 'POST', headers: rpcHeaders(cfg.anonKey),
      body: JSON.stringify({ p_device_id: cfg.deviceId, p_secret: cfg.secret, p_records: records }),
    });
  },
  async pull(cfg, limit) {
    return call<RemoteCommand[]>(`${cfg.url}/rest/v1/rpc/rupbar_device_pull`, {
      method: 'POST', headers: rpcHeaders(cfg.anonKey), body: JSON.stringify({ p_device_id: cfg.deviceId, p_secret: cfg.secret, p_limit: limit }),
    });
  },
  async ack(cfg, results) {
    await call(`${cfg.url}/rest/v1/rpc/rupbar_device_ack`, {
      method: 'POST', headers: rpcHeaders(cfg.anonKey), body: JSON.stringify({ p_device_id: cfg.deviceId, p_secret: cfg.secret, p_results: results }),
    });
  },
  async heartbeat(cfg, status) {
    await call(`${cfg.url}/rest/v1/rpc/rupbar_device_heartbeat`, {
      method: 'POST', headers: rpcHeaders(cfg.anonKey), body: JSON.stringify({ p_device_id: cfg.deviceId, p_secret: cfg.secret, p_status: status }),
    });
  },
};

function rpcHeaders(anonKey: string) {
  return { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' };
}

type CommandHandler = (commandId: string, payload: unknown) => { status: CommandResult['status']; message: string; [k: string]: unknown };

export class SyncService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private attempt = 0;
  private nextRunAt = 0;
  private lastState: { status: SyncStatus; error: string | null } = { status: 'disabled', error: null };
  private handlers: Record<string, CommandHandler>;

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    losses: LossesService,
    private readonly api: CloudApi = supabaseCloudApi,
  ) {
    this.handlers = {
      'loss.register': (id, payload) => {
        const r = losses.applyRemote(id, payload);
        return { status: r.status, message: r.message, lossId: r.lossId };
      },
    };
  }

  private config(): CloudConfig | null {
    return this.settings.getJson<CloudConfig | null>('cloud', null);
  }

  private creds() {
    const c = this.config();
    if (!c) return null;
    return { url: c.supabaseUrl, anonKey: c.anonKey, deviceId: c.deviceId, secret: this.ctx.secrets.open(c.deviceSecretSealed) };
  }

  isEnabled(): boolean {
    return this.ctx.meta('sync_enabled') === '1' && !!this.config();
  }

  /** Conecta o PC à nuvem com o login do proprietário (o token não é guardado). */
  async connect(actor: Actor, raw: unknown) {
    requirePerm(actor, 'sync.manage');
    const parsed = cloudConnectSchema.parse(raw);
    const input = { ...parsed, supabaseUrl: parsed.supabaseUrl || RUPBAR_CLOUD.url, anonKey: parsed.anonKey || RUPBAR_CLOUD.anonKey };
    const url = input.supabaseUrl.replace(/\/+$/, '');
    const est = this.settings.establishmentRow();
    if (!est) throw badRequest('Conclua a configuração inicial antes.');
    const { accessToken } = await this.api.signIn(url, input.anonKey, input.email, input.password);
    const reg = await this.api.registerDevice(url, input.anonKey, accessToken, {
      establishmentId: String(est.id), name: 'PC do bar', tradeName: String(est.trade_name),
    });
    this.ctx.tx(() => {
      this.settings.setJson('cloud', {
        supabaseUrl: url, anonKey: input.anonKey, deviceId: reg.deviceId, deviceSecretSealed: this.ctx.secrets.seal(reg.deviceSecret),
        establishmentId: reg.establishmentId, ownerEmail: input.email, connectedAt: this.ctx.nowIso(),
      } satisfies CloudConfig);
      this.ctx.setMeta('sync_enabled', '1');
      this.enqueueSnapshot();
      this.ctx.audit(actor, 'sync.connected', 'settings', 'cloud', { url, email: input.email, deviceId: reg.deviceId });
    });
    this.attempt = 0;
    this.nextRunAt = 0;
    this.lastState = { status: 'pending', error: null };
    return this.status();
  }

  disconnect(actor: Actor) {
    requirePerm(actor, 'sync.manage');
    this.ctx.tx(() => {
      this.ctx.setMeta('sync_enabled', '0');
      this.settings.setJson('cloud', null);
      this.ctx.db.run('DELETE FROM sync_outbox');
      this.ctx.audit(actor, 'sync.disconnected', 'settings', 'cloud');
    });
    this.lastState = { status: 'disabled', error: null };
    return this.status();
  }

  /** Enfileira todos os registros (primeira sincronização ou reenvio completo). */
  enqueueSnapshot(): number {
    let n = 0;
    const now = this.ctx.nowIso();
    for (const t of SYNCED_TABLES) {
      n += this.ctx.db.run(`INSERT INTO sync_outbox (entity, entity_id, created_at) SELECT '${t.entity}', id, ? FROM ${t.table}`, now).changes;
    }
    return n;
  }

  resync(actor: Actor) {
    requirePerm(actor, 'sync.manage');
    const n = this.ctx.tx(() => this.enqueueSnapshot());
    this.nextRunAt = 0;
    return { queued: n };
  }

  pendingCount(): number {
    return Number(this.ctx.db.value('SELECT COUNT(DISTINCT entity || entity_id) FROM sync_outbox'));
  }

  status() {
    const c = this.config();
    const pending = this.pendingCount();
    let status: SyncStatus = this.lastState.status;
    if (!this.isEnabled()) status = 'disabled';
    else if (this.running) status = 'syncing';
    else if (status === 'synced' && pending > 0) status = 'pending';
    const pendingCommands = Number(this.ctx.db.value('SELECT COUNT(*) FROM remote_commands_applied WHERE acked_at IS NULL'));
    return {
      status,
      error: this.lastState.error,
      pending,
      pendingCommandAcks: pendingCommands,
      lastSuccessAt: this.ctx.meta('sync_last_success_at'),
      lastAttemptAt: this.ctx.meta('sync_last_attempt_at'),
      cloud: c ? { url: c.supabaseUrl, ownerEmail: c.ownerEmail, deviceId: c.deviceId, connectedAt: c.connectedAt } : null,
    };
  }

  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextRunAt) void this.runOnce();
    }, intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Um ciclo: envia registros, recebe comandos, confirma resultados, heartbeat. */
  async runOnce(): Promise<ReturnType<SyncService['status']>> {
    if (this.running || !this.isEnabled()) return this.status();
    const creds = this.creds();
    if (!creds) return this.status();
    this.running = true;
    this.ctx.bus.publish({ channel: 'sync', type: 'sync.status', data: { status: 'syncing' } });
    this.ctx.setMeta('sync_last_attempt_at', this.ctx.nowIso());
    try {
      for (let i = 0; i < 20; i++) {
        const sent = await this.pushBatch(creds);
        if (sent < BATCH) break;
      }
      await this.pullCommands(creds);
      await this.ackCommands(creds);
      await this.api.heartbeat(creds, { pending: this.pendingCount(), version: this.ctx.config.version, at: this.ctx.nowIso() });
      this.ctx.setMeta('sync_last_success_at', this.ctx.nowIso());
      this.lastState = { status: this.pendingCount() > 0 ? 'pending' : 'synced', error: null };
      this.attempt = 0;
      this.nextRunAt = 0;
    } catch (err) {
      this.attempt++;
      this.nextRunAt = Date.now() + backoffMs(this.attempt, 5_000, 5 * 60_000);
      const offline = err instanceof NetworkError;
      this.lastState = { status: offline ? 'offline' : 'error', error: err instanceof Error ? err.message : String(err) };
      if (!offline) this.ctx.log.warn('erro de sincronização', { error: this.lastState.error });
    } finally {
      this.running = false;
    }
    const s = this.status();
    this.ctx.bus.publish({ channel: 'sync', type: 'sync.status', data: s as unknown as Record<string, unknown> });
    return s;
  }

  private async pushBatch(creds: NonNullable<ReturnType<SyncService['creds']>>): Promise<number> {
    const rows = this.ctx.db.all<{ entity: string; entity_id: string; max_seq: number }>(
      'SELECT entity, entity_id, MAX(seq) AS max_seq FROM sync_outbox GROUP BY entity, entity_id ORDER BY MIN(seq) LIMIT ?',
      BATCH,
    );
    if (!rows.length) return 0;
    const records: SyncRecord[] = [];
    for (const r of rows) {
      const t = TABLE_BY_ENTITY.get(r.entity as SyncRecord['entity']);
      if (!t) continue;
      const row = this.ctx.db.get(`SELECT * FROM ${t.table} WHERE id = ?`, r.entity_id);
      records.push({
        outboxId: `${r.entity}:${r.entity_id}:${r.max_seq}`,
        entity: t.entity,
        id: r.entity_id,
        version: r.max_seq,
        deleted: !row,
        data: row ? t.serialize(this.ctx.db, row) : {},
        updatedAt: row ? String(row.updated_at ?? row.created_at ?? this.ctx.nowIso()) : this.ctx.nowIso(),
      });
    }
    const res = await this.api.push(creds, records);
    const acked = new Set(res.acked);
    this.ctx.tx(() => {
      for (const rec of records) {
        if (acked.has(rec.outboxId)) {
          this.ctx.db.run('DELETE FROM sync_outbox WHERE entity = ? AND entity_id = ? AND seq <= ?', rec.entity, rec.id, rec.version);
        }
      }
      for (const rej of res.rejected) {
        const [entity, id] = rej.outboxId.split(':');
        this.ctx.db.run('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE entity = ? AND entity_id = ?', rej.reason, entity ?? '', id ?? '');
      }
    });
    if (res.rejected.length) throw new AppError(502, 'SYNC_REJECTED', `${res.rejected.length} registro(s) recusado(s) pela nuvem: ${res.rejected[0]!.reason}`);
    return rows.length;
  }

  private async pullCommands(creds: NonNullable<ReturnType<SyncService['creds']>>) {
    const commands = await this.api.pull(creds, 50);
    for (const cmd of commands) this.applyCommand(cmd);
  }

  /** Aplica um comando remoto exatamente uma vez (resultado registrado com chave única). */
  applyCommand(cmd: RemoteCommand): CommandResult {
    return this.ctx.tx(() => {
      const done = this.ctx.db.get('SELECT * FROM remote_commands_applied WHERE command_id = ?', cmd.id);
      if (done) {
        return { commandId: cmd.id, status: done.status as CommandResult['status'], message: String(done.message), appliedAt: String(done.applied_at) };
      }
      const handler = this.handlers[cmd.type];
      const r = handler ? handler(cmd.id, cmd.payload) : { status: 'rejected' as const, message: `Comando desconhecido: ${cmd.type}` };
      const appliedAt = this.ctx.nowIso();
      const { status, message, ...rest } = r;
      this.ctx.db.run(
        'INSERT INTO remote_commands_applied (command_id, type, status, message, result_json, applied_at) VALUES (?,?,?,?,?,?)',
        cmd.id, cmd.type, status, message, JSON.stringify(rest), appliedAt,
      );
      this.ctx.emit({ channel: 'sync', type: 'command.applied', data: { commandId: cmd.id, type: cmd.type, status } });
      return { commandId: cmd.id, status, message, result: rest, appliedAt };
    });
  }

  private async ackCommands(creds: NonNullable<ReturnType<SyncService['creds']>>) {
    const pending = this.ctx.db.all('SELECT * FROM remote_commands_applied WHERE acked_at IS NULL LIMIT 100');
    if (!pending.length) return;
    const results: CommandResult[] = pending.map((p) => ({
      commandId: String(p.command_id),
      status: p.status as CommandResult['status'],
      message: String(p.message),
      result: JSON.parse(String(p.result_json ?? '{}')),
      appliedAt: String(p.applied_at),
    }));
    await this.api.ack(creds, results);
    this.ctx.tx(() => {
      for (const r of results) this.ctx.db.run('UPDATE remote_commands_applied SET acked_at = ? WHERE command_id = ?', this.ctx.nowIso(), r.commandId);
    });
  }
}
