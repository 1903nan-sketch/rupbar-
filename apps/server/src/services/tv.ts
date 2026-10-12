import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tvApproveSchema } from '@rupbar/core/schemas';
import { numericCode, randomToken, safeEqual, sha256 } from '../lib/crypto';
import { AppError, conflict, notFound } from '../lib/errors';
import { addMinutes } from '../lib/time';
import { requirePerm, type Actor, type Ctx } from './context';
import type { KitchenService } from './kitchen';
import type { SettingsService } from './settings';

const PAIRING_MINUTES = 10;
const MAX_CLAIM_ATTEMPTS = 300;

export interface TvDevice {
  id: string;
  name: string;
}

/**
 * Síntese de voz offline no Windows (SAPI / System.Speech). Gera WAV que a TV
 * reproduz pela rede local. Sem dependência de serviços online.
 */
const TTS_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1
if (-not $v) { exit 3 }
$s.SelectVoice($v.VoiceInfo.Name)
$s.Rate = -1
$s.SetOutputToWaveFile($env:RUPBAR_TTS_OUT)
$s.Speak($env:RUPBAR_TTS_TEXT)
$s.Dispose()
`;

export class TvService {
  private ttsAvailable: boolean | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly settings: SettingsService,
    private readonly kitchen: KitchenService,
  ) {}

  // ---------------------------------------------------------- pareamento

  /** A TV inicia o pareamento e exibe o código; somente ela conhece o `secret`. */
  startPairing(meta: { ip?: string | null; userAgent?: string | null }) {
    return this.ctx.tx(() => {
      const now = this.ctx.clock.now();
      this.ctx.db.run("UPDATE tv_pairings SET status = 'expired' WHERE status IN ('pending','approved') AND expires_at < ?", now.toISOString());
      const pending = Number(this.ctx.db.value("SELECT COUNT(*) FROM tv_pairings WHERE status = 'pending'"));
      if (pending > 20) throw new AppError(429, 'TOO_MANY_PAIRINGS', 'Muitos pareamentos pendentes. Aguarde alguns minutos.');
      let code: string;
      do code = numericCode(6);
      while (this.ctx.db.value("SELECT id FROM tv_pairings WHERE code = ? AND status = 'pending'", code));
      const id = this.ctx.id();
      const secret = randomToken(24);
      const expiresAt = addMinutes(now, PAIRING_MINUTES).toISOString();
      this.ctx.db.run(
        'INSERT INTO tv_pairings (id, code, secret_hash, status, ip, user_agent, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, code, sha256(secret), 'pending', meta.ip ?? null, meta.userAgent?.slice(0, 200) ?? null, expiresAt, now.toISOString(),
      );
      return { pairingId: id, code, secret, expiresAt };
    });
  }

  /** Proprietário/gerente digita o código exibido na TV e autoriza. */
  approve(actor: Actor, raw: unknown) {
    requirePerm(actor, 'devices.manage');
    const input = tvApproveSchema.parse(raw);
    return this.ctx.tx(() => {
      const p = this.ctx.db.get(
        "SELECT * FROM tv_pairings WHERE code = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
        input.code, this.ctx.nowIso(),
      );
      if (!p) throw notFound('Código de pareamento (verifique o número na TV ou gere um novo)');
      const deviceId = this.ctx.id();
      this.ctx.db.run(
        'INSERT INTO tv_devices (id, name, token_hash, approved_by, created_at, last_ip) VALUES (?,?,?,?,?,?)',
        deviceId, input.name, `pending:${p.id}`, actor.userId ?? 'system', this.ctx.nowIso(), p.ip as string | null,
      );
      this.ctx.db.run("UPDATE tv_pairings SET status = 'approved', device_id = ? WHERE id = ?", deviceId, String(p.id));
      this.ctx.audit(actor, 'tv.approved', 'tv_device', deviceId, { name: input.name, ip: p.ip });
      this.ctx.emit({ channel: 'system', type: 'tv.paired', data: { deviceId } });
      return { deviceId, name: input.name };
    });
  }

  /** A TV consulta o pareamento; após aprovado, recebe o token de acesso (uma única vez). */
  claim(pairingId: string, secret: string): { status: 'pending' } | { status: 'approved'; token: string; device: TvDevice } {
    return this.ctx.tx(() => {
      const p = this.ctx.db.get('SELECT * FROM tv_pairings WHERE id = ?', pairingId);
      if (!p || !safeEqual(String(p.secret_hash), sha256(secret))) throw new AppError(401, 'PAIRING_INVALID', 'Pareamento inválido.');
      this.ctx.db.run('UPDATE tv_pairings SET attempts = attempts + 1 WHERE id = ?', pairingId);
      if (Number(p.attempts) > MAX_CLAIM_ATTEMPTS || p.status === 'expired' || p.status === 'claimed' || Date.parse(String(p.expires_at)) < this.ctx.clock.now().getTime()) {
        throw new AppError(410, 'PAIRING_EXPIRED', 'Código expirado. Gere um novo código.');
      }
      if (p.status !== 'approved') return { status: 'pending' as const };
      const token = randomToken(32);
      this.ctx.db.run('UPDATE tv_devices SET token_hash = ? WHERE id = ?', sha256(token), String(p.device_id));
      this.ctx.db.run("UPDATE tv_pairings SET status = 'claimed' WHERE id = ?", pairingId);
      const name = this.ctx.db.value<string>('SELECT name FROM tv_devices WHERE id = ?', String(p.device_id))!;
      return { status: 'approved' as const, token, device: { id: String(p.device_id), name } };
    });
  }

  resolve(token: string | null | undefined, ip?: string | null): TvDevice | null {
    if (!token || token.length > 200) return null;
    const d = this.ctx.db.get('SELECT id, name, last_seen_at FROM tv_devices WHERE token_hash = ? AND revoked_at IS NULL', sha256(token));
    if (!d) return null;
    const last = d.last_seen_at ? Date.parse(String(d.last_seen_at)) : 0;
    if (this.ctx.clock.now().getTime() - last > 60_000) {
      this.ctx.db.run('UPDATE tv_devices SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?', this.ctx.nowIso(), ip ?? null, String(d.id));
    }
    return { id: String(d.id), name: String(d.name) };
  }

  devices(actor: Actor) {
    requirePerm(actor, 'devices.manage');
    return this.ctx.db.all(
      `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.last_ip, d.revoked_at, u.name AS approved_by_name
       FROM tv_devices d LEFT JOIN users u ON u.id = d.approved_by WHERE d.token_hash NOT LIKE 'pending:%' ORDER BY d.created_at DESC`,
    );
  }

  revoke(actor: Actor, id: string) {
    requirePerm(actor, 'devices.manage');
    this.ctx.tx(() => {
      const r = this.ctx.db.run('UPDATE tv_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', this.ctx.nowIso(), id);
      if (!r.changes) throw conflict('TV já desconectada.');
      this.ctx.audit(actor, 'tv.revoked', 'tv_device', id);
      this.ctx.emit({ channel: 'tv', type: 'device.revoked', data: { deviceId: id } });
    });
  }

  // ------------------------------------------------------------- painel

  board() {
    const b = this.settings.branding();
    return {
      branding: { tradeName: b.tradeName, initials: b.initials, primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, logoUrl: b.logoUrl, coverUrl: b.coverUrl },
      ...this.kitchen.tvBoard(),
      recentCalls: this.kitchen.recentCalls(5),
      voice: this.settings.operation().tvVoiceEnabled,
      serverTts: this.ttsAvailable === true,
      serverTime: this.ctx.nowIso(),
    };
  }

  // ------------------------------------------------------------- voz

  /** Verifica (uma vez) se há voz pt-BR instalada no Windows. */
  async detectTts(): Promise<boolean> {
    if (process.platform !== 'win32') return (this.ttsAvailable = false);
    try {
      const dir = join(this.ctx.config.dataDir, 'tts');
      mkdirSync(dir, { recursive: true });
      await this.synthesize('Teste', join(dir, 'probe.wav'));
      this.ttsAvailable = true;
    } catch {
      this.ttsAvailable = false;
    }
    return this.ttsAvailable;
  }

  private synthesize(text: string, out: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        env: { ...process.env, RUPBAR_TTS_TEXT: text, RUPBAR_TTS_OUT: out },
        windowsHide: true,
      });
      const timer = setTimeout(() => ps.kill(), 15_000);
      ps.on('error', reject);
      ps.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(out)) resolve();
        else reject(new Error(`TTS indisponível (código ${code})`));
      });
      ps.stdin.end(TTS_PS);
    });
  }

  /** Áudio WAV do anúncio de uma chamada (com cache em disco). */
  async callAudio(callId: string): Promise<Buffer> {
    if (!this.ttsAvailable) throw new AppError(404, 'TTS_UNAVAILABLE', 'Voz do Windows indisponível.');
    const text = this.ctx.db.value<string>('SELECT text FROM pickup_calls WHERE id = ?', callId);
    if (!text) throw notFound('Chamada');
    const dir = join(this.ctx.config.dataDir, 'tts');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sha256(text).slice(0, 24)}.wav`);
    if (!existsSync(file)) await this.synthesize(text, file);
    return readFileSync(file);
  }
}
