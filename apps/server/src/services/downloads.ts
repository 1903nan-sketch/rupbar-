import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './context';

/** App Android do garçom, servido pelo PC em /download/rupbar-garcom.apk. */
export const ANDROID_APK = 'rupbar-garcom.apk';

export interface DownloadFile {
  path: string;
  size: number;
  updatedAt: string;
}

/**
 * Procura um arquivo para download: primeiro na pasta do instalador
 * (`downloadsDir`), depois em `<dataDir>/downloads` (onde o suporte pode
 * colocar uma versão manualmente).
 */
export function findDownload(config: Pick<ServerConfig, 'downloadsDir' | 'dataDir'>, name: string): DownloadFile | null {
  for (const dir of [config.downloadsDir, join(config.dataDir, 'downloads')]) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && st.size > 0) return { path, size: st.size, updatedAt: st.mtime.toISOString() };
    } catch {
      /* ausente */
    }
  }
  return null;
}

/** Página exibida no celular quando o APK não está neste PC. */
export function apkMissingPage(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App do garçom indisponível</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#0b0b0d;color:#f5f5f7;font-family:system-ui,-apple-system,Roboto,sans-serif}
main{max-width:440px}h1{font-size:22px;line-height:1.3}p{color:#a1a1a6;line-height:1.55}b{color:#f5f5f7}
</style>
</head>
<body>
<main>
<h1>O app Android do garçom ainda não está neste PC</h1>
<p>Este computador não tem o arquivo <b>${ANDROID_APK}</b>. Atualize o RupBar no PC do bar (o instalador mais recente já inclui o app) ou peça o arquivo ao suporte da Ruptix.</p>
<p>Enquanto isso, use o RupBar pelo navegador: abra no Chrome o endereço mostrado no PC em <b>Configurações → Conectar dispositivo</b>.</p>
</main>
</body>
</html>`;
}
