import type { TvAdsMode, TvDisplaySettings } from '@rupbar/core/schemas';
import { ArrowDown, ArrowUp, BellRing, Clapperboard, Film, ImageIcon, ImageOff, Megaphone, Send, Trash2, Upload, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Input, Loading, Segmented, Switch, useToast } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { useRealtime } from '../../lib/realtime';
import '../../styles/tv-settings.css';

interface MediaView {
  id: string;
  kind: 'image' | 'video';
  mime: string;
  size: number;
  title: string;
  originalName: string | null;
  durationSeconds: number;
  position: number;
  enabled: boolean;
  missing: boolean;
  url: string;
  createdAt: string;
}

const MB = 1024 * 1024;
const MAX_VIDEO = 300 * MB;
const MAX_IMAGE = 20 * MB;
const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/webm';

const MODES: { value: TvAdsMode; label: string; text: string }[] = [
  { value: 'off', label: 'Desligado', text: 'A TV mostra somente os pedidos.' },
  { value: 'carousel', label: 'Alternar com pedidos', text: 'A TV alterna entre o painel de pedidos e os anúncios. Um vídeo sempre é exibido até o fim.' },
  { value: 'ads_first', label: 'Anúncios primeiro', text: 'Os anúncios ficam na tela o tempo todo; o painel de pedidos aparece quando alguém é chamado e depois volta aos anúncios.' },
];

const fmtSize = (n: number) => (n >= MB ? `${(n / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Envio com barra de progresso (fetch não informa o progresso do upload). */
function uploadWithProgress<T>(url: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-rupbar', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { error?: { code: string; message: string } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* resposta sem JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else if (xhr.status === 413) reject(new ApiError(413, 'FILE_TOO_LARGE', body?.error?.message ?? 'Arquivo muito grande.'));
      else reject(new ApiError(xhr.status, body?.error?.code ?? `HTTP_${xhr.status}`, body?.error?.message ?? 'Não foi possível enviar o arquivo.'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Sem conexão com o PC do bar.'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

/** Conferência rápida antes de enviar (o servidor confere de novo pelo conteúdo). */
function checkFile(f: File): string | null {
  const video = f.type.startsWith('video/') || /\.(mp4|webm)$/i.test(f.name);
  const image = f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name);
  if (!video && !image) return 'formato não suportado (use JPG, PNG, WEBP, MP4 ou WEBM).';
  if (video && f.size > MAX_VIDEO) return `vídeo acima de ${MAX_VIDEO / MB} MB.`;
  if (image && !video && f.size > MAX_IMAGE) return `foto acima de ${MAX_IMAGE / MB} MB.`;
  return null;
}

/** Campo de segundos: aceita digitação livre e grava ao sair do campo (dentro dos limites). */
function SecondsInput({ value, min, max, onCommit, id }: { value: number; min: number; max: number; onCommit: (v: number) => void; id?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    const v = text.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <div className="input-group tvs-seconds">
      <input
        id={id}
        className="input num"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 4))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        style={{ paddingRight: 34 }}
      />
      <span className="suffix">s</span>
    </div>
  );
}

function SecondsField({ label, hint, value, min, max, onCommit }: { label: string; hint?: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <SecondsInput id={id} value={value} min={min} max={max} onCommit={onCommit} />
      <span className="hint">{hint ?? `Entre ${min} e ${max} segundos.`}</span>
    </div>
  );
}

function VolumeSlider({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="tvs-volume">
      <label htmlFor={id}>{label}</label>
      <div className="tvs-volume-row">
        {value === 0 ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
        <input
          id={id}
          type="range"
          className="tvs-range"
          min={0}
          max={100}
          step={5}
          value={value}
          disabled={disabled}
          style={{ '--fill': `${value}%` } as CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="tvs-volume-value">{value}%</span>
      </div>
    </div>
  );
}

/**
 * Configurações → TV: som da chamada, modo de anúncios e fotos/vídeos.
 * As alterações são gravadas na hora e chegam às TVs em tempo real.
 */
export function TvDisplayPanel() {
  const toast = useToast();
  const { data, error, reload, setData } = useLoad(() => api.get<TvDisplaySettings>('/api/tv/display'));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const pending = useRef<Partial<TvDisplaySettings>>({});
  const timer = useRef<number | undefined>(undefined);
  const media = useLoad(() => api.get<MediaView[]>('/api/tv/media'));
  useRealtime('tv.config', () => void media.reload());

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = async () => {
    const body = pending.current;
    pending.current = {};
    if (!Object.keys(body).length) return;
    setStatus('saving');
    try {
      setData(await api.put<TvDisplaySettings>('/api/tv/display', body));
      setStatus('saved');
    } catch (e) {
      toast.error(e);
      setStatus('idle');
      void reload();
    }
  };

  /** Atualiza na tela e grava (com espera curta para controles deslizantes). */
  const save = (patch: Partial<TvDisplaySettings>, delay = 0) => {
    setData((d) => (d ? { ...d, ...patch } : d));
    pending.current = { ...pending.current, ...patch };
    setStatus('saving');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), delay);
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const d = data;
  const enabledMedia = media.data?.filter((m) => m.enabled && !m.missing).length ?? 0;
  const statusText = status === 'saving' ? 'Salvando…' : status === 'saved' ? 'Salvo — as TVs já receberam' : 'Alterações gravadas automaticamente';

  return (
    <div className="stack-l">
      <div className="tvs-status small muted" aria-live="polite">{statusText}</div>
      <div className="grid-2">
        <Card title={<span className="row"><BellRing size={18} /> Som da chamada</span>}>
          <div className="stack">
            <VolumeSlider label="Volume do toque e da voz" value={d.volume} onChange={(v) => save({ volume: v }, 400)} />
            <Field label="Toque de atenção antes da voz" hint="Sinos altos para chamar a atenção no salão.">
              <Segmented value={String(d.chimeRepeat)} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}×` }))} onChange={(v) => save({ chimeRepeat: Number(v) })} />
            </Field>
            <Field label="Repetir chamada" hint="Quantas vezes o toque e o anúncio por voz são feitos para cada pedido.">
              <Segmented value={String(d.callRepeat)} options={[1, 2, 3].map((n) => ({ value: String(n), label: n === 1 ? '1 vez' : `${n} vezes` }))} onChange={(v) => save({ callRepeat: Number(v) })} />
            </Field>
            <Field label="Pedidos que aparecem no telão" hint="Bebidas saem na hora no balcão; deixe só a cozinha para o telão mostrar porções e lanches.">
              <Segmented
                value={d.stations.length > 1 ? 'all' : d.stations[0] === 'bar' ? 'bar' : 'kitchen'}
                options={[{ value: 'kitchen', label: 'Só cozinha' }, { value: 'all', label: 'Cozinha e balcão' }, { value: 'bar', label: 'Só balcão' }]}
                onChange={(v) => save({ stations: v === 'all' ? ['kitchen', 'bar'] : [v as 'kitchen' | 'bar'] })}
              />
            </Field>
            <Field label="Pedido pronto some da TV depois de" hint="Contado de quando ficou pronto ou da última chamada. “Nunca” = só sai ao marcar entregue.">
              <Segmented
                value={String(d.readyMinutes)}
                options={[5, 10, 15, 30, 0].map((n) => ({ value: String(n), label: n === 0 ? 'Nunca' : `${n} min` }))}
                onChange={(v) => save({ readyMinutes: Number(v) })}
              />
            </Field>
            <div className="row wrap">
              <Button icon={<Send size={16} />} onClick={async () => { try { await api.post('/api/tv/test-call'); toast.success('Chamada de teste enviada às TVs'); } catch (e) { toast.error(e); } }}>Testar som na TV</Button>
              <span className="tiny muted">A voz pode ser ligada ou desligada em Configurações → Operação.</span>
            </div>
            <p className="tiny muted">Se a TV mostrar “Som bloqueado”, toque na tela ou aperte OK no controle uma vez: os navegadores só liberam o som após um toque.</p>
          </div>
        </Card>

        <Card title={<span className="row"><Megaphone size={18} /> Anúncios na TV</span>}>
          <div className="stack">
            <div className="tvs-seg">
              <Segmented value={d.adsMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} onChange={(v) => save({ adsMode: v })} />
            </div>
            <p className="small muted tvs-mode-text">{MODES.find((m) => m.value === d.adsMode)?.text}</p>
            {d.adsMode === 'carousel' && (
              <div className="grid-2">
                <SecondsField label="Pedidos na tela" value={d.boardSeconds} min={5} max={600} onCommit={(v) => save({ boardSeconds: v })} />
                <SecondsField label="Anúncios na tela" hint="Vídeos sempre tocam até o fim." value={d.adsSeconds} min={5} max={600} onCommit={(v) => save({ adsSeconds: v })} />
              </div>
            )}
            {d.adsMode === 'ads_first' && (
              <SecondsField label="Pedidos na tela depois de uma chamada" value={d.boardAfterCallSeconds} min={5} max={300} onCommit={(v) => save({ boardAfterCallSeconds: v })} />
            )}
            {d.adsMode !== 'off' && media.data && enabledMedia === 0 && (
              <div className="banner warning small">Nenhum anúncio ativo: envie fotos ou vídeos abaixo. Enquanto isso, a TV mostra somente os pedidos.</div>
            )}
            <div className={`tvs-sound ${d.videoSound ? 'on' : ''}`}>
              <Switch
                checked={d.videoSound}
                onChange={(v) => save({ videoSound: v })}
                label={<span className="row">{d.videoSound ? <Volume2 size={18} /> : <VolumeX size={18} />} Som dos vídeos</span>}
                description={d.videoSound ? 'Os vídeos tocam com som (pausam durante as chamadas).' : 'Desligado: os vídeos tocam sem som.'}
              />
              {d.videoSound && <VolumeSlider label="Volume dos vídeos" value={d.videoVolume} onChange={(v) => save({ videoVolume: v }, 400)} />}
            </div>
            <Switch
              checked={d.readyTicker}
              onChange={(v) => save({ readyTicker: v })}
              label="Faixa “Pronto para retirar” sobre os anúncios"
              description="Mostra os nomes dos pedidos prontos na parte de baixo enquanto os anúncios passam."
            />
            <p className="tiny muted">Em qualquer modo, uma chamada interrompe o anúncio na hora e mostra o nome do cliente em tela cheia.</p>
          </div>
        </Card>
      </div>
      <TvMediaManager list={media} videoSound={d.videoSound} onToggleSound={() => save({ videoSound: !d.videoSound })} />
    </div>
  );
}

type MediaLoad = ReturnType<typeof useLoad<MediaView[]>>;

function TvMediaManager({ list, videoSound, onToggleSound }: { list: MediaLoad; videoSound: boolean; onToggleSound: () => void }) {
  const toast = useToast();
  const { data, error, reload, setData } = list;
  const [uploads, setUploads] = useState<{ key: number; name: string; progress: number }[]>([]);
  const [drag, setDrag] = useState(false);
  const [remove, setRemove] = useState<MediaView | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const send = async (files: File[]) => {
    for (const f of files) {
      const problem = checkFile(f);
      if (problem) {
        toast.error(`${f.name}: ${problem}`);
        continue;
      }
      const key = ++seq.current;
      setUploads((u) => [...u, { key, name: f.name, progress: 0 }]);
      try {
        await uploadWithProgress('/api/tv/media', f, (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))));
        toast.success(`${f.name} enviado`);
        void reload();
      } catch (e) {
        toast.error(e instanceof Error ? `${f.name}: ${e.message}` : e);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
  };

  const patch = async (m: MediaView, body: Partial<Pick<MediaView, 'title' | 'durationSeconds' | 'enabled'>>) => {
    setData((l) => l?.map((x) => (x.id === m.id ? { ...x, ...body } : x)) ?? l);
    try {
      await api.patch(`/api/tv/media/${m.id}`, body);
    } catch (e) {
      toast.error(e);
      void reload();
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    if (!data) return;
    const ids = data.map((m) => m.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    setData(ids.map((id) => data.find((m) => m.id === id)!));
    try {
      setData(await api.put<MediaView[]>('/api/tv/media/order', { ids }));
    } catch (e) {
      toast.error(e);
      void reload();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void send([...e.dataTransfer.files]);
  };

  return (
    <Card
      title={<span className="row"><Clapperboard size={18} /> Fotos e vídeos dos anúncios</span>}
      actions={
        <>
          <Button size="small" variant="plain" icon={videoSound ? <Volume2 size={16} /> : <VolumeX size={16} />} onClick={onToggleSound}>
            {videoSound ? 'Vídeos com som' : 'Vídeos sem som'}
          </Button>
          <Button size="small" variant="primary" icon={<Upload size={16} />} onClick={() => input.current?.click()}>Enviar</Button>
        </>
      }
    >
      <div className="stack">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <div
          className={`tvs-drop ${drag ? 'is-over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <Upload size={22} aria-hidden="true" />
          <div>
            <strong>Arraste fotos e vídeos aqui</strong> ou clique para escolher
            <div className="tiny muted">Fotos JPG, PNG ou WEBP (até {MAX_IMAGE / MB} MB) · vídeos MP4 ou WEBM (até {MAX_VIDEO / MB} MB). Ficam guardados neste PC.</div>
          </div>
        </div>
        {uploads.map((u) => (
          <div key={u.key} className="tvs-upload">
            <div className="row between small"><span className="tvs-truncate">{u.name}</span><span className="muted">{Math.round(u.progress * 100)}%</span></div>
            <div className="tvs-progress"><span style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
          </div>
        ))}
        {error && <ErrorBox error={error} onRetry={reload} />}
        {!data && !error && <Loading />}
        {data && !data.length && !uploads.length && <p className="small muted">Nenhum anúncio ainda. Envie fotos de promoções, cardápio ou eventos, ou vídeos curtos.</p>}
        {data && data.length > 0 && (
          <ol className="tvs-media-list">
            {data.map((m, i) => (
              <li key={m.id} className={`tvs-media ${m.enabled ? '' : 'is-off'}`}>
                <a className="tvs-thumb" href={m.url} target="_blank" rel="noreferrer" title="Abrir em nova aba">
                  {m.missing ? (
                    <ImageOff size={26} aria-hidden="true" />
                  ) : m.kind === 'image' ? (
                    <img src={m.url} alt="" loading="lazy" />
                  ) : (
                    <video src={`${m.url}#t=1`} preload="metadata" muted playsInline />
                  )}
                  <span className="tvs-kind">{m.kind === 'video' ? <Film size={12} /> : <ImageIcon size={12} />}{m.kind === 'video' ? 'Vídeo' : 'Foto'}</span>
                </a>
                <div className="tvs-media-info">
                  <Input
                    key={`${m.id}:${m.title}`}
                    defaultValue={m.title}
                    placeholder="Título (só para identificar)"
                    maxLength={80}
                    aria-label="Título do anúncio"
                    onBlur={(e) => e.target.value.trim() !== m.title && void patch(m, { title: e.target.value.trim() })}
                    onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                  />
                  <div className="tiny muted">
                    {i + 1}º · {fmtSize(m.size)}{m.originalName ? ` · ${m.originalName}` : ''}
                    {m.missing && <> · <Badge color="red">Arquivo ausente</Badge></>}
                  </div>
                </div>
                <div className="tvs-media-duration">
                  {m.kind === 'image' ? (
                    <label className="tiny muted">
                      Tempo
                      <SecondsInput value={m.durationSeconds} min={3} max={300} onCommit={(v) => void patch(m, { durationSeconds: v })} />
                    </label>
                  ) : (
                    <span className="tiny muted">Toca até o fim</span>
                  )}
                </div>
                <div className="tvs-media-actions">
                  <Switch checked={m.enabled} onChange={(v) => void patch(m, { enabled: v })} />
                  <Button size="small" variant="plain" icon={<ArrowUp size={16} />} aria-label="Subir" title="Subir" disabled={i === 0} onClick={() => void move(i, -1)} />
                  <Button size="small" variant="plain" icon={<ArrowDown size={16} />} aria-label="Descer" title="Descer" disabled={i === data.length - 1} onClick={() => void move(i, 1)} />
                  <Button size="small" variant="plain" className="tvs-danger" icon={<Trash2 size={16} />} aria-label="Excluir" title="Excluir" onClick={() => setRemove(m)} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {remove && (
        <Confirm
          title="Excluir anúncio?"
          danger
          confirmLabel="Excluir"
          message={`${remove.kind === 'video' ? 'O vídeo' : 'A foto'} “${remove.title || remove.originalName || 'sem título'}” será apagado deste PC e sai das TVs na hora.`}
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            await api.del(`/api/tv/media/${remove.id}`);
            void reload();
          }}
        />
      )}
    </Card>
  );
}
