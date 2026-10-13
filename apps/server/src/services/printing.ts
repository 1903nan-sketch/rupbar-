import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffMs, comandaPixTxid, firstName, PAYMENT_METHODS, STATIONS, type PaymentMethod, type Station } from '@rupbar/core';
import {
  renderBillReceipt, renderCashClose, renderOrderTicket, renderTestPage, type CodePage, type PaperWidth, type PrintOptions,
} from '@rupbar/core/escpos';
import { printerSchema } from '@rupbar/core/schemas';
import { bool, json, type Row } from '../db/db';
import { badRequest, notFound } from '../lib/errors';
import { addMs } from '../lib/time';
import type { ComandasService } from './comandas';
import { requirePerm, type Actor, type Ctx } from './context';
import type { PixCharge, SettingsService } from './settings';

const MAX_ATTEMPTS = 8;
/** Impressoras com o QR Code desligado (guardado nas configurações; padrão: QR ligado). */
const QR_OFF_KEY = 'printers_qr_off';

export interface PrinterTransport {
  send(printer: Row, data: Uint8Array): Promise<void>;
}

/** Impressora de rede (Ethernet/Wi-Fi) em modo RAW, porta 9100. */
export function sendNetwork(host: string, port: number, data: Uint8Array, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Tempo esgotado ao conectar à impressora')));
    socket.once('error', (e) => finish(e));
    socket.connect(port, host, () => {
      socket.end(Buffer.from(data), () => finish());
    });
  });
}

/**
 * Impressora instalada no Windows (USB/compartilhada): envia bytes RAW ao
 * spooler via winspool.drv (OpenPrinter/StartDocPrinter/WritePrinter).
 * Nome da impressora e arquivo vão por variáveis de ambiente — nunca
 * concatenados no script — para evitar injeção de comandos.
 */
const RAW_PRINT_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RupBarRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr h, int level, DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Impressora nao encontrada: " + printer);
    try {
      var di = new DOCINFO { pDocName = "RupBar", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("Falha ao iniciar documento");
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Exception("Falha ao enviar dados");
      EndPagePrinter(h);
      EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
"@
[RupBarRawPrinter]::Send($env:RUPBAR_PRINTER, [System.IO.File]::ReadAllBytes($env:RUPBAR_PRINT_FILE))
`;

export function sendWindows(printerName: string, data: Uint8Array, timeoutMs = 20_000): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Impressão pelo spooler disponível apenas no Windows'));
  const dir = mkdtempSync(join(tmpdir(), 'rupbar-print-'));
  const file = join(dir, 'job.bin');
  writeFileSync(file, data);
  return new Promise<void>((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      env: { ...process.env, RUPBAR_PRINTER: printerName, RUPBAR_PRINT_FILE: file },
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => ps.kill(), timeoutMs);
    ps.stderr.on('data', (d) => (stderr += String(d)));
    ps.on('error', reject);
    ps.on('close', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').slice(-2).join(' ') || `PowerShell saiu com código ${code}`));
    });
    ps.stdin.end(RAW_PRINT_PS);
  });
}

export function listWindowsPrinters(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += String(d)));
    ps.on('error', () => resolve([]));
    ps.on('close', () => resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
}

export const defaultTransport: PrinterTransport = {
  async send(printer, data) {
    switch (printer.transport) {
      case 'network':
        if (!printer.host) throw new Error('Endereço da impressora não configurado');
        return sendNetwork(String(printer.host), Number(printer.port), data);
      case 'windows':
        if (!printer.windows_name) throw new Error('Nome da impressora do Windows não configurado');
        return sendWindows(String(printer.windows_name), data);
      case 'file':
        if (!printer.file_path) throw new Error('Arquivo de saída não configurado');
        appendFileSync(String(printer.file_path), Buffer.from(data));
        return;
      default:
        throw new Error('Tipo de conexão desconhecido');
    }
  },
};

export class PrintingService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kick = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly comandas: ComandasService,
    private readonly transport: PrinterTransport = defaultTransport,
  ) {}

  private printerView(p: Row) {
    return {
      id: p.id, name: p.name, transport: p.transport, host: p.host, port: p.port, windowsName: p.windows_name, filePath: p.file_path,
      paper: p.paper, codepage: p.codepage, stations: json<Station[]>(p.stations_json, []), printReceipts: bool(p.print_receipts),
      autoPrint: bool(p.auto_print), beep: bool(p.beep), printQr: !this.qrOff().has(String(p.id)), active: bool(p.active),
      lastStatus: p.last_status, lastError: p.last_error,
    };
  }

  /** Impressoras que não imprimem QR Code nativo (modelos antigos ou genéricos). */
  private qrOff(): Set<string> {
    return new Set(this.settings.getJson<string[]>(QR_OFF_KEY, []));
  }

  private setPrintQr(printerId: string, on: boolean): void {
    const off = this.qrOff();
    if (on === !off.has(printerId)) return;
    if (on) off.delete(printerId);
    else off.add(printerId);
    this.settings.setJson(QR_OFF_KEY, [...off]);
  }

  list(actor: Actor) {
    requirePerm(actor, 'printers.manage');
    return this.ctx.db.all('SELECT * FROM printers ORDER BY name').map((p) => this.printerView(p));
  }

  save(actor: Actor, id: string | null, raw: unknown) {
    requirePerm(actor, 'printers.manage');
    const input = printerSchema.parse(raw);
    if (input.transport === 'network' && !input.host) throw badRequest('Informe o IP da impressora.');
    if (input.transport === 'windows' && !input.windowsName) throw badRequest('Selecione a impressora do Windows.');
    if (input.transport === 'file' && !input.filePath) throw badRequest('Informe o arquivo de saída.');
    const printerId = id ?? this.ctx.id();
    this.ctx.tx(() => {
      const now = this.ctx.nowIso();
      if (id) {
        const r = this.ctx.db.run(
          `UPDATE printers SET name=?, transport=?, host=?, port=?, windows_name=?, file_path=?, paper=?, codepage=?, stations_json=?,
             print_receipts=?, auto_print=?, beep=?, active=?, updated_at=? WHERE id=?`,
          input.name, input.transport, input.host, input.port, input.windowsName, input.filePath, input.paper, input.codepage,
          JSON.stringify(input.stations), input.printReceipts, input.autoPrint, input.beep, input.active, now, id,
        );
        if (!r.changes) throw notFound('Impressora');
      } else {
        this.ctx.db.run(
          `INSERT INTO printers (id, name, transport, host, port, windows_name, file_path, paper, codepage, stations_json, print_receipts,
             auto_print, beep, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          printerId, input.name, input.transport, input.host, input.port, input.windowsName, input.filePath, input.paper, input.codepage,
          JSON.stringify(input.stations), input.printReceipts, input.autoPrint, input.beep, input.active, now, now,
        );
      }
      this.setPrintQr(printerId, input.printQr);
      this.ctx.audit(actor, id ? 'printers.updated' : 'printers.created', 'printer', printerId, { name: input.name, transport: input.transport });
    });
    return { id: printerId };
  }

  remove(actor: Actor, id: string) {
    requirePerm(actor, 'printers.manage');
    this.ctx.tx(() => {
      this.ctx.db.run("UPDATE print_jobs SET status = 'canceled' WHERE printer_id = ? AND status IN ('pending','failed')", id);
      this.ctx.db.run('UPDATE printers SET active = 0, updated_at = ? WHERE id = ?', this.ctx.nowIso(), id);
      this.ctx.audit(actor, 'printers.disabled', 'printer', id);
    });
  }

  private opts(p: Row): PrintOptions {
    return { paper: Number(p.paper) as PaperWidth, codepage: p.codepage as CodePage, beep: bool(p.beep), qr: !this.qrOff().has(String(p.id)) };
  }

  enqueue(printerId: string, kind: string, title: string, payload: Uint8Array, ref: { type?: string; id?: string } = {}, createdBy: string | null = null, reprintOf: string | null = null): string {
    const id = this.ctx.id();
    const now = this.ctx.nowIso();
    this.ctx.db.run(
      `INSERT INTO print_jobs (id, printer_id, kind, ref_type, ref_id, title, payload, status, next_attempt_at, reprint_of, created_by, created_at)
       VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?,?)`,
      id, printerId, kind, ref.type ?? null, ref.id ?? null, title, payload, now, reprintOf, createdBy, now,
    );
    this.ctx.emit({ channel: 'printing', type: 'job.queued', data: { jobId: id } });
    this.kick = true;
    return id;
  }

  /** Gera os cupons de produção de um pedido, um por setor, para as impressoras do setor. */
  enqueueOrderTickets(orderId: string, opts: { reprint?: boolean; ticketId?: string; manual?: boolean; createdBy?: string | null } = {}): string[] {
    const tickets = this.ctx.db.all(
      `SELECT t.*, o.number, o.notes AS order_notes, o.created_at AS order_created, c.table_label, c.number AS comanda_number, c.customer_name,
              u.name AS waiter_name
       FROM order_tickets t JOIN orders o ON o.id = t.order_id JOIN comandas c ON c.id = o.comanda_id LEFT JOIN users u ON u.id = o.created_by
       WHERE t.order_id = ? ${opts.ticketId ? 'AND t.id = ?' : ''}`,
      orderId, ...(opts.ticketId ? [opts.ticketId] : []),
    );
    const printers = this.ctx.db.all('SELECT * FROM printers WHERE active = 1');
    const barName = this.settings.branding().tradeName;
    const jobs: string[] = [];
    for (const t of tickets) {
      if (t.status === 'canceled') continue;
      const targets = printers.filter((p) => json<string[]>(p.stations_json, []).includes(String(t.station)) && (opts.manual || bool(p.auto_print)));
      if (!targets.length) continue;
      const items = this.ctx.db.all(
        "SELECT product_name, presentation_name, quantity, notes FROM comanda_items WHERE order_id = ? AND station = ? AND status = 'active' ORDER BY created_at",
        orderId, String(t.station),
      );
      if (!items.length) continue;
      for (const p of targets) {
        const payload = renderOrderTicket(
          {
            barName,
            orderNumber: Number(t.number),
            stationLabel: STATIONS[t.station as Station],
            table: (t.table_label as string) ?? null,
            comandaNumber: Number(t.comanda_number),
            customerFirstName: firstName(t.customer_name as string) || null,
            waiterName: (t.waiter_name as string) ?? null,
            createdAt: new Date(String(t.order_created)),
            items: items.map((i) => ({
              quantity: Number(i.quantity),
              name: i.presentation_name === 'Unidade' ? String(i.product_name) : `${i.product_name} (${i.presentation_name})`,
              notes: (i.notes as string) ?? null,
            })),
            notes: (t.order_notes as string) ?? null,
            reprint: opts.reprint,
          },
          this.opts(p),
        );
        jobs.push(this.enqueue(String(p.id), 'order_ticket', `Pedido ${t.number} — ${STATIONS[t.station as Station]}`, payload, { type: 'order_ticket', id: String(t.id) }, opts.createdBy ?? null));
      }
    }
    return jobs;
  }

  printBill(actor: Actor, comandaId: string) {
    requirePerm(actor, 'comandas.view');
    const d = this.comandas.detail(actor, comandaId);
    const printers = this.ctx.db.all('SELECT * FROM printers WHERE active = 1 AND print_receipts = 1');
    if (!printers.length) throw badRequest('Nenhuma impressora configurada para contas. Ative "Imprimir contas" em uma impressora.', 'NO_RECEIPT_PRINTER');
    const b = this.settings.branding();
    // Pix ativo e saldo em aberto: a conta sai com o QR do valor a pagar.
    const remaining = Math.max(0, d.remaining);
    let charge: PixCharge | null = null;
    try {
      charge = remaining > 0 ? this.settings.pixCharge(remaining, comandaPixTxid(Number(d.number))) : null;
    } catch (err) {
      // Um Pix mal configurado nunca impede a conta de sair.
      this.ctx.log.warn('pix indisponível na conta', { comanda: d.number, error: err instanceof Error ? err.message : String(err) });
    }
    const pix = charge
      ? { payload: charge.payload, amount: remaining, merchantName: charge.merchantName, keyLabel: charge.keyLabel, key: charge.key }
      : null;
    return this.ctx.tx(() =>
      printers.map((p) =>
        this.enqueue(
          String(p.id), 'receipt', `Conta da comanda ${d.number}`,
          renderBillReceipt(
            {
              barName: b.tradeName,
              headerLines: [b.phone ? `Tel: ${b.phone}` : '', b.instagram ? `@${b.instagram.replace(/^@/, '')}` : ''].filter(Boolean),
              comandaNumber: Number(d.number), table: (d.table as string) ?? null, customerFirstName: firstName(String(d.customerName)) || null,
              openedAt: new Date(String(d.openedAt)), printedAt: this.ctx.clock.now(),
              items: d.items.filter((i) => i.status === 'active').map((i) => ({
                quantity: Number(i.quantity),
                name: i.presentationName === 'Unidade' ? String(i.name) : `${i.name} ${i.presentationName}`,
                total: Number(i.totalCents),
              })),
              subtotal: d.subtotal, discount: d.discount, serviceFee: d.serviceFee, total: d.total,
              payments: d.payments.filter((x) => x.status === 'active').map((x) => ({ label: PAYMENT_METHODS[x.method as PaymentMethod] ?? String(x.method), amount: Number(x.amount_cents) })),
              remaining: d.remaining,
              pix,
            },
            this.opts(p),
          ),
          { type: 'comanda', id: comandaId }, actor.userId,
        ),
      ),
    );
  }

  printCashClose(sessionId: string, createdBy: string | null) {
    const s = this.ctx.db.get(
      `SELECT s.*, uo.name AS opened_name, uc.name AS closed_name FROM cash_sessions s
       JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by WHERE s.id = ?`,
      sessionId,
    );
    if (!s || s.status !== 'closed') return [];
    const summary = json<{ byMethod: Record<string, number>; withdrawals: number; supplies: number; expectedCash: number } | null>(s.summary_json, null);
    if (!summary) return [];
    const printers = this.ctx.db.all('SELECT * FROM printers WHERE active = 1 AND print_receipts = 1');
    return printers.map((p) =>
      this.enqueue(
        String(p.id), 'cash_close', `Fechamento do caixa ${s.number}`,
        renderCashClose(
          {
            barName: this.settings.branding().tradeName, sessionLabel: `Caixa nº ${s.number}`,
            openedBy: String(s.opened_name), openedAt: new Date(String(s.opened_at)),
            closedBy: String(s.closed_name ?? ''), closedAt: new Date(String(s.closed_at)),
            openingBalance: Number(s.opening_balance_cents),
            byMethod: Object.entries(summary.byMethod).map(([m, v]) => ({ label: PAYMENT_METHODS[m as PaymentMethod] ?? m, amount: v })),
            withdrawals: summary.withdrawals, supplies: summary.supplies, expectedCash: summary.expectedCash,
            countedCash: Number(s.counted_cash_cents), difference: Number(s.difference_cents),
          },
          this.opts(p),
        ),
        { type: 'cash_session', id: sessionId }, createdBy,
      ),
    );
  }

  test(actor: Actor, printerId: string) {
    requirePerm(actor, 'printers.manage');
    const p = this.ctx.db.get('SELECT * FROM printers WHERE id = ?', printerId);
    if (!p) throw notFound('Impressora');
    return this.ctx.tx(() => ({
      jobId: this.enqueue(printerId, 'test', 'Teste de impressão', renderTestPage(this.settings.branding().tradeName, String(p.name), this.opts(p)), {}, actor.userId),
    }));
  }

  jobs(actor: Actor, filter: { status?: string; limit?: number } = {}) {
    requirePerm(actor, 'kitchen.view');
    return this.ctx.db.all(
      `SELECT j.id, j.printer_id, p.name AS printer_name, j.kind, j.ref_type, j.ref_id, j.title, j.status, j.attempts, j.last_error,
              j.reprint_of, j.created_at, j.printed_at, u.name AS created_by_name
       FROM print_jobs j JOIN printers p ON p.id = j.printer_id LEFT JOIN users u ON u.id = j.created_by
       ${filter.status ? 'WHERE j.status = ?' : ''} ORDER BY j.created_at DESC LIMIT ?`,
      ...(filter.status ? [filter.status] : []), Math.min(filter.limit ?? 100, 500),
    );
  }

  retry(actor: Actor, jobId: string) {
    requirePerm(actor, 'kitchen.view');
    this.ctx.tx(() => {
      const r = this.ctx.db.run(
        "UPDATE print_jobs SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE id = ? AND status IN ('failed','canceled')",
        this.ctx.nowIso(), jobId,
      );
      if (!r.changes) throw notFound('Impressão');
      this.kick = true;
    });
  }

  reprintJob(actor: Actor, jobId: string) {
    requirePerm(actor, 'kitchen.view');
    return this.ctx.tx(() => {
      const j = this.ctx.db.get('SELECT * FROM print_jobs WHERE id = ?', jobId);
      if (!j) throw notFound('Impressão');
      const newId = this.enqueue(String(j.printer_id), String(j.kind), `${j.title} (reimpressão)`, j.payload as Uint8Array, { type: j.ref_type as string, id: j.ref_id as string }, actor.userId, jobId);
      this.ctx.audit(actor, 'printing.reprint', 'print_job', jobId);
      return { jobId: newId };
    });
  }

  // ------------------------------------------------------------- fila

  /** Recupera trabalhos interrompidos (queda de energia durante a impressão). */
  recover(): number {
    return this.ctx.db.run("UPDATE print_jobs SET status = 'pending' WHERE status = 'printing'").changes;
  }

  start(intervalMs = 1_000): void {
    this.recover();
    this.timer = setInterval(() => void this.processQueue(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processa a fila em ordem. Retorna quantos trabalhos foram concluídos. */
  async processQueue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      for (;;) {
        this.kick = false;
        const job = this.ctx.db.get(
          `SELECT j.*, p.transport, p.host, p.port, p.windows_name, p.file_path, p.name AS printer_name, p.active AS printer_active
           FROM print_jobs j JOIN printers p ON p.id = j.printer_id
           WHERE j.status = 'pending' AND j.next_attempt_at <= ? ORDER BY j.created_at LIMIT 1`,
          this.ctx.nowIso(),
        );
        if (!job) break;
        if (job.printer_active !== 1) {
          this.ctx.db.run("UPDATE print_jobs SET status = 'canceled', last_error = 'Impressora desativada' WHERE id = ?", String(job.id));
          continue;
        }
        this.ctx.db.run("UPDATE print_jobs SET status = 'printing', attempts = attempts + 1 WHERE id = ?", String(job.id));
        try {
          await this.transport.send(job, job.payload as Uint8Array);
          this.ctx.tx(() => {
            this.ctx.db.run("UPDATE print_jobs SET status = 'done', printed_at = ?, last_error = NULL WHERE id = ?", this.ctx.nowIso(), String(job.id));
            this.ctx.db.run("UPDATE printers SET last_status = 'ok', last_error = NULL WHERE id = ?", String(job.printer_id));
            this.ctx.emit({ channel: 'printing', type: 'job.done', data: { jobId: job.id } });
          });
          done++;
        } catch (err) {
          const attempts = Number(job.attempts) + 1;
          const msg = err instanceof Error ? err.message : String(err);
          const failed = attempts >= MAX_ATTEMPTS;
          const retryAt = addMs(this.ctx.clock.now(), backoffMs(attempts, 2_000, 60_000)).toISOString();
          this.ctx.tx(() => {
            this.ctx.db.run(
              'UPDATE print_jobs SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
              failed ? 'failed' : 'pending', msg, retryAt, String(job.id),
            );
            // Adia os demais trabalhos da mesma impressora: uma impressora desligada
            // não pode atrasar as outras, e a ordem dos cupons é preservada.
            this.ctx.db.run(
              "UPDATE print_jobs SET next_attempt_at = ? WHERE printer_id = ? AND status = 'pending' AND next_attempt_at < ?",
              retryAt, String(job.printer_id), retryAt,
            );
            this.ctx.db.run("UPDATE printers SET last_status = 'error', last_error = ? WHERE id = ?", msg, String(job.printer_id));
            this.ctx.emit({ channel: 'printing', type: failed ? 'job.failed' : 'job.retry', data: { jobId: job.id, error: msg, printer: job.printer_name } });
          });
          this.ctx.log.warn('falha de impressão', { job: job.id, printer: job.printer_name, attempts, error: msg });
        }
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  get pendingKick(): boolean {
    return this.kick;
  }
}
