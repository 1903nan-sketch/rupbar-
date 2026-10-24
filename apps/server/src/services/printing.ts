import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backoffMs, comandaPixTxid, displayName, firstName, PAYMENT_METHODS, pickupCode, presentationSuffix, reportTitle, STATIONS, type FullReport, type PaymentMethod,
  type Station, comandaDisplayNumber,
} from '@rupbar/core';
import {
  renderBillReceipt, renderCashClose, renderOrderTicket, renderPickupTicket, renderReportTicket, renderTestPage, type CodePage, type PaperWidth, type PrintOptions,
} from '@rupbar/core/escpos';
import { printerSchema } from '@rupbar/core/schemas';
import { bool, json, type Row } from '../db/db';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { addMs } from '../lib/time';
import type { ComandasService } from './comandas';
import { hasPerm, requirePerm, type Actor, type Ctx } from './context';
import type { PixCharge, SettingsService } from './settings';

const MAX_ATTEMPTS = 8;
/** Impressoras com o QR Code desligado (guardado nas configurações; padrão: QR ligado). */
const QR_OFF_KEY = 'printers_qr_off';

export interface PrinterTransport {
  /** Envia o trabalho; um texto de volta é um aviso (enviado, mas algo no Windows impede a saída). */
  send(printer: Row, data: Uint8Array): Promise<void | string>;
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
 * spooler via winspool.drv (OpenPrinter/StartDocPrinter/WritePrinter) e, em
 * seguida, olha a fila do Windows para avisar se a impressora está offline,
 * pausada ou com trabalhos parados. Nome da impressora e arquivo vão por
 * variáveis de ambiente — nunca concatenados no script — para evitar injeção
 * de comandos. Só ASCII: o Windows PowerShell lê .ps1 sem BOM como ANSI.
 */
export const RAW_PRINT_PS = `$ErrorActionPreference = 'Stop'
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
  public static int Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("RUPBAR:NOT_FOUND:" + Marshal.GetLastWin32Error());
    try {
      int job = StartDocPrinter(h, 1, new DOCINFO { pDocName = "RupBar", pDataType = "RAW" });
      // Drivers v4 (pipeline XPS) recusam RAW (erro 1804): XPS_PASS entrega os bytes do mesmo jeito.
      if (job == 0 && Marshal.GetLastWin32Error() == 1804) job = StartDocPrinter(h, 1, new DOCINFO { pDocName = "RupBar", pDataType = "XPS_PASS" });
      if (job == 0) throw new Exception("RUPBAR:START_DOC:" + Marshal.GetLastWin32Error());
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Exception("RUPBAR:WRITE:" + Marshal.GetLastWin32Error());
      EndPagePrinter(h);
      EndDocPrinter(h);
      return job;
    } finally { ClosePrinter(h); }
  }
}
"@
$job = [RupBarRawPrinter]::Send($env:RUPBAR_PRINTER, [System.IO.File]::ReadAllBytes($env:RUPBAR_PRINT_FILE))
$info = @{ job = $job; stuck = 0; offline = $false; paused = $false; error = $false }
try {
  $p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $env:RUPBAR_PRINTER } | Select-Object -First 1
  if ($p) {
    $info.offline = [bool]$p.WorkOffline -or $p.ExtendedPrinterStatus -eq 7 -or $p.ExtendedPrinterStatus -eq 11 -or $p.PrinterStatus -eq 7
    $info.paused = $p.ExtendedPrinterStatus -eq 8
    $info.error = $p.ExtendedPrinterStatus -eq 9
  }
  $prefix = $env:RUPBAR_PRINTER + ','
  $info.stuck = @(Get-CimInstance Win32_PrintJob | Where-Object { $_.Name.StartsWith($prefix) -and $_.JobId -ne $job }).Count
} catch { }
[Console]::Out.Write((ConvertTo-Json $info -Compress))
`;

/** Erros do script em português, com o código do Windows para o suporte. */
export function windowsPrintError(printerName: string, rawStderr: string, code: number | null): string {
  // PowerShell 7 colore os erros (códigos ANSI); o texto vai para a tela de impressoras.
  const stderr = rawStderr.replace(/\x1b\[[0-9;]*m/g, '');
  const m = /RUPBAR:(NOT_FOUND|START_DOC|WRITE):(\d+)/.exec(stderr);
  if (m) {
    const n = Number(m[2]);
    if (m[1] === 'NOT_FOUND') return `O Windows não encontrou a impressora "${printerName}" (erro ${n}). Confira o nome em Impressoras e scanners e selecione de novo em Editar.`;
    if (m[1] === 'START_DOC') return `O Windows recusou o cupom na impressora "${printerName}" (erro ${n}). Confira o driver da impressora.`;
    return `Falha ao enviar o cupom para a impressora "${printerName}" (erro ${n}). Confira o cabo USB e se ela está ligada.`;
  }
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  return last || `PowerShell saiu com código ${code}`;
}

export interface WindowsQueueInfo {
  job?: number;
  stuck?: number;
  offline?: boolean;
  paused?: boolean;
  error?: boolean;
}

/** Aviso quando o Windows aceitou o cupom mas a fila não anda (ou null se está tudo certo). */
export function windowsQueueWarning(printerName: string, info: WindowsQueueInfo | null): string | null {
  if (!info) return null;
  const where = `Abra Configurações do Windows → Impressoras e scanners → ${printerName} → Abrir fila de impressão.`;
  if (info.paused) return `A fila da impressora "${printerName}" está pausada no Windows: os cupons ficam parados. ${where} e escolha Retomar.`;
  if (info.offline) return `A impressora "${printerName}" está offline no Windows: confira se está ligada e o cabo USB. ${where} Se aparecer "Usar impressora offline", desmarque.`;
  if (info.error) return `O Windows informa erro na impressora "${printerName}" (papel, tampa aberta ou cabo).`;
  if ((info.stuck ?? 0) > 0) {
    const n = info.stuck!;
    return `Há ${n} ${n === 1 ? 'impressão parada' : 'impressões paradas'} na fila do Windows da impressora "${printerName}". ${where} Se ela estiver na porta USB errada, troque a porta em Propriedades da impressora → Portas.`;
  }
  return null;
}

const POLICY_BLOCKED = /PSSecurityException|UnauthorizedAccess|execution polic|pol[ií]tica de execu/i;

/**
 * Roda um script do PowerShell e devolve a saída. Antes o script ia pela
 * entrada padrão (-Command -), e nesse modo o PowerShell ignora em silêncio
 * comandos de várias linhas: saía com sucesso sem imprimir nada. Agora vai
 * como arquivo .ps1 (-File); se uma política do Windows bloquear scripts,
 * tenta de novo com -EncodedCommand, que não depende dela.
 */
export async function runPowerShellScript(
  script: string, env: NodeJS.ProcessEnv, opts: { exe?: string; dir: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const exe = opts.exe ?? 'powershell.exe';
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const ps = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => ps.kill(), opts.timeoutMs ?? 30_000);
      ps.stdout.on('data', (d) => (stdout += String(d)));
      ps.stderr.on('data', (d) => (stderr += String(d)));
      ps.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ps.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  const file = join(opts.dir, 'rupbar-print.ps1');
  writeFileSync(file, script);
  const first = await run(['-File', file]);
  if (first.code === 0 || !POLICY_BLOCKED.test(first.stderr)) return first;
  return run(['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

export async function sendWindows(printerName: string, data: Uint8Array, opts: { exe?: string; timeoutMs?: number } = {}): Promise<string | undefined> {
  if (process.platform !== 'win32' && !opts.exe) throw new Error('Impressão pelo spooler disponível apenas no Windows');
  const dir = mkdtempSync(join(tmpdir(), 'rupbar-print-'));
  const file = join(dir, 'job.bin');
  writeFileSync(file, data);
  try {
    const r = await runPowerShellScript(RAW_PRINT_PS, { ...process.env, RUPBAR_PRINTER: printerName, RUPBAR_PRINT_FILE: file }, { exe: opts.exe, dir, timeoutMs: opts.timeoutMs });
    if (r.code !== 0) throw new Error(windowsPrintError(printerName, r.stderr, r.code));
    let info: WindowsQueueInfo | null = null;
    try {
      info = JSON.parse(r.stdout.trim()) as WindowsQueueInfo;
    } catch {
      // O PowerShell terminou sem a resposta do script: o cupom não foi enviado.
      throw new Error(`O PowerShell não confirmou o envio para a impressora "${printerName}". ${r.stderr.trim()}`.trim());
    }
    return windowsQueueWarning(printerName, info) ?? undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface WindowsPrinter {
  name: string;
  port: string | null;
  driver: string | null;
  offline: boolean;
}

/** Lê a saída JSON do PowerShell (um objeto ou uma lista). */
export function parseWindowsPrinters(out: string): WindowsPrinter[] {
  let data: unknown;
  try {
    data = JSON.parse(out.trim() || '[]');
  } catch {
    return [];
  }
  const list = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  return list
    .filter((p) => p && typeof p.Name === 'string' && p.Name)
    .map((p) => ({
      name: String(p.Name),
      port: typeof p.PortName === 'string' ? p.PortName : null,
      driver: typeof p.DriverName === 'string' ? p.DriverName : null,
      // 7 = offline, 11 = não disponível (ex.: cabo USB desligado).
      offline: p.WorkOffline === true || p.ExtendedPrinterStatus === 7 || p.ExtendedPrinterStatus === 11,
    }));
}

/**
 * Impressoras instaladas no Windows (inclusive as USB), com porta e driver.
 * Usa Win32_Printer, que funciona também no serviço (conta do sistema).
 */
export function listWindowsPrinters(timeoutMs = 15_000): Promise<WindowsPrinter[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        // UTF-8 na saída: nomes com acento ("Térmica") precisam chegar iguais para o spooler encontrar a impressora.
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | Select-Object Name,PortName,DriverName,WorkOffline,ExtendedPrinterStatus | ConvertTo-Json -Compress',
      ],
      { windowsHide: true },
    );
    let out = '';
    const timer = setTimeout(() => ps.kill(), timeoutMs);
    ps.stdout.on('data', (d) => (out += String(d)));
    ps.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    ps.on('close', () => {
      clearTimeout(timer);
      resolve(parseWindowsPrinters(out));
    });
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
      autoPrint: bool(p.auto_print), beep: bool(p.beep), printQr: !this.qrOff().has(String(p.id)), cashier: bool(p.cashier), active: bool(p.active),
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
             print_receipts=?, auto_print=?, beep=?, cashier=?, active=?, updated_at=? WHERE id=?`,
          input.name, input.transport, input.host, input.port, input.windowsName, input.filePath, input.paper, input.codepage,
          JSON.stringify(input.stations), input.printReceipts, input.autoPrint, input.beep, input.cashier, input.active, now, id,
        );
        if (!r.changes) throw notFound('Impressora');
      } else {
        this.ctx.db.run(
          `INSERT INTO printers (id, name, transport, host, port, windows_name, file_path, paper, codepage, stations_json, print_receipts,
             auto_print, beep, cashier, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          printerId, input.name, input.transport, input.host, input.port, input.windowsName, input.filePath, input.paper, input.codepage,
          JSON.stringify(input.stations), input.printReceipts, input.autoPrint, input.beep, input.cashier, input.active, now, now,
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

  /** Impressoras do caixa ativas (com `manual`, também as sem impressão automática). */
  private cashierPrinters(manual = false): Row[] {
    return this.ctx.db.all('SELECT * FROM printers WHERE active = 1 AND cashier = 1').filter((p) => manual || bool(p.auto_print));
  }

  /**
   * Cupons de um pedido. Setor com impressora própria recebe o cupom de
   * produção; a impressora do caixa recebe o ticket do pedido (o cliente leva
   * ao bar) com todos os itens, que também serve aos setores sem impressora.
   * Na venda rápida o ticket sai depois do pagamento (enqueuePickupTicket).
   */
  enqueueOrderTickets(orderId: string, opts: { reprint?: boolean; ticketId?: string; manual?: boolean; createdBy?: string | null } = {}): string[] {
    const tickets = this.ctx.db.all(
      `SELECT t.*, o.number, o.notes AS order_notes, o.created_at AS order_created, c.table_label, c.number AS comanda_number, c.card_number, c.kind AS comanda_kind, c.customer_name,
              u.name AS waiter_name
       FROM order_tickets t JOIN orders o ON o.id = t.order_id JOIN comandas c ON c.id = o.comanda_id LEFT JOIN users u ON u.id = o.created_by
       WHERE t.order_id = ? ${opts.ticketId ? 'AND t.id = ?' : ''}`,
      orderId, ...(opts.ticketId ? [opts.ticketId] : []),
    );
    const dedicated = this.ctx.db.all('SELECT * FROM printers WHERE active = 1 AND cashier = 0');
    const barName = this.settings.branding().tradeName;
    const jobs: string[] = [];
    for (const t of tickets) {
      if (t.status === 'canceled') continue;
      let targets = dedicated.filter((p) => json<string[]>(p.stations_json, []).includes(String(t.station)) && (opts.manual || bool(p.auto_print)));
      // Reimpressão pela produção de um setor sem impressora própria: sai no caixa.
      if (!targets.length && opts.ticketId) targets = this.cashierPrinters(true);
      if (!targets.length) continue;
      const items = this.ctx.db.all(
        "SELECT product_name, presentation_name, options_label, quantity, notes FROM comanda_items WHERE order_id = ? AND station = ? AND status = 'active' ORDER BY created_at",
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
            // Número do cartão (o que o cliente conhece); venda rápida não tem comanda.
            comandaNumber: comandaDisplayNumber({ number: Number(t.comanda_number), cardNumber: t.card_number as number | null, kind: String(t.comanda_kind) }),
            customerFirstName: firstName(t.customer_name as string) || null,
            waiterName: (t.waiter_name as string) ?? null,
            createdAt: new Date(String(t.order_created)),
            items: items.map((i) => ({
              quantity: Number(i.quantity),
              name: presentationSuffix(String(i.product_name), String(i.presentation_name)) ? `${i.product_name} (${i.presentation_name})` : String(i.product_name),
              options: (i.options_label as string) ?? null,
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
    if (!opts.ticketId && this.ctx.db.value('SELECT c.kind FROM orders o JOIN comandas c ON c.id = o.comanda_id WHERE o.id = ?', orderId) !== 'quick') {
      jobs.push(...this.enqueuePickupTicket(orderId, { manual: opts.manual, createdBy: opts.createdBy }));
    }
    return jobs;
  }

  /**
   * Ticket do pedido na impressora do caixa: número, nome, itens, PAGO (venda
   * rápida) ou a comanda, e o código de barras para conferir depois. Uma nova
   * impressão do mesmo pedido sai como "2ª via".
   */
  enqueuePickupTicket(orderId: string, opts: { manual?: boolean; createdBy?: string | null } = {}): string[] {
    const o = this.ctx.db.get(
      `SELECT o.id, o.number, o.business_day, o.notes, o.created_at, c.id AS comanda_id, c.number AS comanda_number, c.card_number, c.kind AS comanda_kind,
              c.status AS comanda_status, c.customer_name, c.table_label, u.name AS waiter_name
       FROM orders o JOIN comandas c ON c.id = o.comanda_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`,
      orderId,
    );
    if (!o) return [];
    const targets = this.cashierPrinters(opts.manual);
    if (!targets.length) return [];
    const items = this.ctx.db.all(
      "SELECT product_name, presentation_name, options_label, quantity, notes FROM comanda_items WHERE order_id = ? AND status = 'active' ORDER BY created_at",
      orderId,
    );
    if (!items.length) return [];
    const quick = o.comanda_kind === 'quick';
    const paid = quick && o.comanda_status === 'closed'
      ? {
          total: this.comandas.totals(String(o.comanda_id)).total,
          methods: this.ctx.db
            .all<{ method: string }>("SELECT DISTINCT method FROM payments WHERE comanda_id = ? AND status = 'active'", String(o.comanda_id))
            .map((r) => PAYMENT_METHODS[r.method as PaymentMethod] ?? r.method),
        }
      : null;
    const reprint = !!this.ctx.db.value("SELECT 1 FROM print_jobs WHERE kind = 'pickup_ticket' AND ref_id = ? AND status <> 'canceled' LIMIT 1", orderId);
    const barName = this.settings.branding().tradeName;
    return targets.map((p) =>
      this.enqueue(
        String(p.id), 'pickup_ticket', `Ticket do pedido ${o.number}${reprint ? ' (2ª via)' : ''}`,
        renderPickupTicket(
          {
            barName,
            orderNumber: Number(o.number),
            code: pickupCode(String(o.business_day), Number(o.number)),
            customerName: displayName(o.customer_name as string) || null,
            comandaNumber: quick ? null : comandaDisplayNumber({ number: Number(o.comanda_number), cardNumber: o.card_number as number | null, kind: String(o.comanda_kind) }),
            table: (o.table_label as string) ?? null,
            waiterName: (o.waiter_name as string) ?? null,
            createdAt: new Date(String(o.created_at)),
            items: items.map((i) => ({
              quantity: Number(i.quantity),
              name: presentationSuffix(String(i.product_name), String(i.presentation_name)) ? `${i.product_name} (${i.presentation_name})` : String(i.product_name),
              options: (i.options_label as string) ?? null,
              notes: (i.notes as string) ?? null,
            })),
            notes: (o.notes as string) ?? null,
            paid,
            reprint,
          },
          this.opts(p),
        ),
        { type: 'order', id: orderId }, opts.createdBy ?? null,
      ),
    );
  }

  /** Imprime de novo o ticket do pedido (cliente perdeu o papel): sai como 2ª via. */
  reprintPickupTicket(actor: Actor, orderId: string) {
    requirePerm(actor, 'cash.payment');
    if (!this.ctx.db.value('SELECT id FROM orders WHERE id = ?', orderId)) throw notFound('Pedido');
    if (!this.cashierPrinters(true).length) {
      throw badRequest('Nenhuma impressora do caixa. Em Configurações → Impressoras, marque "Impressora do caixa".', 'NO_CASHIER_PRINTER');
    }
    return this.ctx.tx(() => {
      const jobs = this.enqueuePickupTicket(orderId, { manual: true, createdBy: actor.userId });
      if (!jobs.length) throw badRequest('Este pedido não tem itens para imprimir.', 'EMPTY_ORDER');
      this.ctx.audit(actor, 'printing.pickup_ticket', 'order', orderId, { jobs: jobs.length });
      return { jobs };
    });
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
              comandaNumber: Number(d.displayNumber ?? d.number), table: (d.table as string) ?? null, customerFirstName: firstName(String(d.customerName)) || null,
              openedAt: new Date(String(d.openedAt)), printedAt: this.ctx.clock.now(),
              items: d.items.filter((i) => i.status === 'active').map((i) => ({
                quantity: Number(i.quantity),
                name: presentationSuffix(String(i.name), String(i.presentationName)) ? `${i.name} ${i.presentationName}` : String(i.name),
                options: i.options,
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

  /**
   * Liga e desliga rápidos (barra do topo e venda rápida). Ficam gravados até
   * mudar de novo e valem para todos os aparelhos.
   * - orders: pedidos das comandas (cozinha, balcão e ticket no caixa)
   * - quickTicket: ticket do pedido da venda rápida
   * - quickReceipt: comprovante de pagamento da venda rápida
   */
  switches() {
    return {
      orders: this.settings.operation().autoPrintOrders,
      quickTicket: this.ctx.meta('print_quick_ticket') !== '0',
      quickReceipt: this.ctx.meta('print_quick_receipt') === '1',
      queued: Number(this.ctx.db.value("SELECT COUNT(*) FROM print_jobs WHERE status IN ('pending','failed')")),
    };
  }

  /** Ligar ou desligar descarta a fila de pedidos parada: ao ligar, só saem os pedidos novos. */
  setSwitches(actor: Actor, raw: unknown) {
    if (!(['orders.create', 'cash.payment', 'printers.manage'] as const).some((p) => hasPerm(actor, p))) throw forbidden('Sem permissão para ligar ou desligar a impressão.');
    const input = z.object({ orders: z.boolean().optional(), quickTicket: z.boolean().optional(), quickReceipt: z.boolean().optional() }).parse(raw ?? {});
    return this.ctx.tx(() => {
      const before = this.switches();
      let discarded = 0;
      const ticketsChanged = (input.orders !== undefined && input.orders !== before.orders) || (input.quickTicket !== undefined && input.quickTicket !== before.quickTicket);
      if (ticketsChanged) {
        discarded = this.ctx.db.run(
          `UPDATE print_jobs SET status = 'canceled', last_error = 'Descartado ao ligar/desligar a impressão de pedidos'
           WHERE status IN ('pending','failed') AND kind IN ('order_ticket','pickup_ticket')`,
        ).changes;
      }
      if (input.orders !== undefined && input.orders !== before.orders) this.settings.saveOperation({ ...this.settings.operation(), autoPrintOrders: input.orders });
      if (input.quickTicket !== undefined) this.ctx.setMeta('print_quick_ticket', input.quickTicket ? '1' : '0');
      if (input.quickReceipt !== undefined) this.ctx.setMeta('print_quick_receipt', input.quickReceipt ? '1' : '0');
      const after = this.switches();
      this.ctx.audit(actor, 'printing.switches', 'settings', 'printing', { orders: after.orders, quickTicket: after.quickTicket, quickReceipt: after.quickReceipt, discarded });
      this.ctx.emit({ channel: 'system', type: 'print.switches', data: { ...after } });
      return { ...after, discarded };
    });
  }

  /** Venda do dia (ou período) na impressora de contas do caixa. */
  printReport(actor: Actor, report: FullReport) {
    requirePerm(actor, 'reports.financial');
    const printers = this.ctx.db.all('SELECT * FROM printers WHERE active = 1 AND print_receipts = 1');
    if (!printers.length) throw badRequest('Nenhuma impressora configurada para contas. Ative "Imprimir contas" em uma impressora.', 'NO_RECEIPT_PRINTER');
    const title = report.de === report.ate ? `Venda do dia ${reportTitle(report.de, report.ate)}` : `Vendas ${reportTitle(report.de, report.ate)}`;
    return this.ctx.tx(() => ({
      jobs: printers.map((p) => this.enqueue(String(p.id), 'report', title, renderReportTicket(report, this.opts(p)), { type: 'report', id: report.de }, actor.userId)),
    }));
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
          const warning = (await this.transport.send(job, job.payload as Uint8Array)) || null;
          this.ctx.tx(() => {
            this.ctx.db.run("UPDATE print_jobs SET status = 'done', printed_at = ?, last_error = ? WHERE id = ?", this.ctx.nowIso(), warning, String(job.id));
            // Aviso: o Windows aceitou o cupom, mas a fila dele está parada (offline, pausada...).
            this.ctx.db.run('UPDATE printers SET last_status = ?, last_error = ? WHERE id = ?', warning ? 'warning' : 'ok', warning, String(job.printer_id));
            this.ctx.emit({ channel: 'printing', type: 'job.done', data: { jobId: job.id, warning, printer: job.printer_name } });
          });
          if (warning) this.ctx.log.warn('impressão parada no Windows', { job: job.id, printer: job.printer_name, warning });
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
