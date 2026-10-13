import { buildPixPayload, normalizePixKey, PIX_CITY_MAX, PIX_KEY_TYPES, PIX_NAME_MAX, sanitizePixText, type PixKeyType } from '@rupbar/core';
import { Info, QrCode } from 'lucide-react';
import { useMemo, useState, type HTMLAttributes } from 'react';
import { PixQrView } from '../../components/PixQr';
import { Button, Card, Empty, ErrorBox, Field, Input, Loading, MoneyInput, PageHeader, Switch, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';

interface PixForm {
  enabled: boolean;
  keyType: PixKeyType;
  key: string;
  merchantName: string;
  merchantCity: string;
}

interface IdentityHint {
  tradeName: string;
  legalName: string | null;
  address: { city?: string };
}

const KEY_INPUT: Record<PixKeyType, { placeholder: string; hint: string; inputMode: HTMLAttributes<HTMLInputElement>['inputMode'] }> = {
  cnpj: { placeholder: '00.000.000/0000-00', hint: 'Com ou sem pontuação.', inputMode: 'numeric' },
  cpf: { placeholder: '000.000.000-00', hint: 'Com ou sem pontuação.', inputMode: 'numeric' },
  phone: { placeholder: '(11) 98765-4321', hint: 'Celular com DDD, cadastrado como chave Pix no banco.', inputMode: 'tel' },
  email: { placeholder: 'pix@seubar.com.br', hint: 'O e-mail cadastrado como chave Pix no banco.', inputMode: 'email' },
  random: { placeholder: '123e4567-e89b-12d3-a456-426614174000', hint: 'Copie do app do banco, em “Minhas chaves Pix”.', inputMode: 'text' },
};

/** Primeira configuração: sugere nome e cidade a partir da identidade do bar. */
function initialForm(pix: PixForm, identity: IdentityHint | null): PixForm {
  if (pix.key || pix.merchantName || pix.merchantCity || !identity) return pix;
  return { ...pix, merchantName: identity.legalName || identity.tradeName || '', merchantCity: identity.address?.city ?? '' };
}

export function PixSettings() {
  const toast = useToast();
  const { data, error, reload } = useLoad(async () => {
    const [pix, identity] = await Promise.all([
      api.get<PixForm>('/api/settings/pix'),
      api.get<IdentityHint>('/api/settings/identity').catch(() => null),
    ]);
    return { pix, identity };
  });
  const [f, setF] = useState<PixForm | null>(null);
  const [testAmount, setTestAmount] = useState<number | null>(100);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  if (data && !f) setF(initialForm(data.pix, data.identity));

  // Validação ao vivo com as mesmas regras do servidor (@rupbar/core).
  const keyCheck = f && f.key.trim() ? normalizePixKey(f.keyType, f.key) : null;
  const nameOut = sanitizePixText(f?.merchantName, PIX_NAME_MAX);
  const cityOut = sanitizePixText(f?.merchantCity, PIX_CITY_MAX);
  const required = !!f?.enabled && submitted;
  const errors = {
    key: keyCheck && !keyCheck.ok ? keyCheck.error : !keyCheck && required ? 'Informe a chave Pix.' : null,
    merchantName: f?.merchantName.trim() && !nameOut ? 'Use letras e números.' : !nameOut && required ? 'Informe o nome do recebedor.' : null,
    merchantCity: f?.merchantCity.trim() && !cityOut ? 'Use letras e números.' : !cityOut && required ? 'Informe a cidade.' : null,
  };

  const preview = useMemo(() => {
    if (!f || !keyCheck?.ok || !nameOut || !cityOut) return null;
    try {
      return buildPixPayload({ key: keyCheck.key, merchantName: f.merchantName, merchantCity: f.merchantCity, amountCents: testAmount ?? 0, txid: 'RBTESTE' });
    } catch {
      return null;
    }
    // keyCheck, nameOut e cityOut derivam de `f`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, testAmount]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!f) return <Loading />;

  const set = <K extends keyof PixForm>(k: K, v: PixForm[K]) => setF({ ...f, [k]: v });
  const input = KEY_INPUT[f.keyType];

  const save = async () => {
    setSubmitted(true);
    const blocking = f.enabled ? !keyCheck?.ok || !nameOut || !cityOut : !!(keyCheck && !keyCheck.ok);
    if (blocking) return toast.error('Corrija os campos destacados antes de salvar.');
    setBusy(true);
    try {
      const saved = await api.put<PixForm>('/api/settings/pix', f);
      setF(saved);
      setSubmitted(false);
      toast.success(saved.enabled ? 'Pix ativado: o QR Code já aparece no pagamento e na conta impressa' : 'Configuração do Pix salva');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-l">
      <PageHeader
        title="Pix copia e cola"
        subtitle="QR Code Pix na tela de pagamento e na conta impressa, direto na chave do bar — sem maquininha e sem taxa."
        actions={<Button variant="primary" loading={busy} onClick={save}>Salvar</Button>}
      />
      <div className="pix-settings">
        <div className="stack">
          <Card>
            <Switch
              checked={f.enabled}
              onChange={(v) => set('enabled', v)}
              label="Gerar Pix copia e cola"
              description="Mostra o QR Code ao receber em Pix e imprime “Pague com Pix” na conferência de conta."
            />
          </Card>
          <Card title="Chave Pix">
            <div className="stack">
              <Field label="Tipo de chave">
                <div className="pix-key-types" role="radiogroup" aria-label="Tipo de chave">
                  {(Object.keys(PIX_KEY_TYPES) as PixKeyType[]).map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={f.keyType === t} className={`chip ${f.keyType === t ? 'active' : ''}`} onClick={() => set('keyType', t)}>
                      {PIX_KEY_TYPES[t]}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Chave" error={errors.key} hint={keyCheck?.ok ? <>Vai no código como <span className="mono">{keyCheck.key}</span></> : input.hint}>
                <Input
                  value={f.key}
                  onChange={(e) => set('key', e.target.value)}
                  placeholder={input.placeholder}
                  inputMode={input.inputMode}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={100}
                />
              </Field>
            </div>
          </Card>
          <Card title="Recebedor">
            <div className="stack">
              <div className="grid-2">
                <Field label="Nome do recebedor" error={errors.merchantName} hint={nameOut ? <>No código: “{nameOut}” ({nameOut.length}/{PIX_NAME_MAX})</> : 'Titular da conta que recebe o Pix.'}>
                  <Input value={f.merchantName} onChange={(e) => set('merchantName', e.target.value)} placeholder="Bar da Marina" maxLength={60} />
                </Field>
                <Field label="Cidade" error={errors.merchantCity} hint={cityOut ? <>No código: “{cityOut}” ({cityOut.length}/{PIX_CITY_MAX})</> : 'Cidade da conta.'}>
                  <Input value={f.merchantCity} onChange={(e) => set('merchantCity', e.target.value)} placeholder="São Paulo" maxLength={60} />
                </Field>
              </div>
              <p className="small muted">
                Como exige o padrão do Banco Central, acentos e símbolos são removidos e o texto é cortado em {PIX_NAME_MAX} caracteres (nome) e {PIX_CITY_MAX} (cidade).
              </p>
            </div>
          </Card>
          <div className="banner warning">
            <Info size={18} style={{ flex: 'none', marginTop: 2, color: 'var(--orange)' }} />
            <div>
              <strong>Pix estático.</strong> O cliente paga direto na conta da chave acima e o dinheiro cai na hora, mas o banco não avisa o RupBar.
              Antes de confirmar o pagamento no caixa, <strong>confira o crédito no app do banco</strong>. Cada código leva o número da comanda (ex.: RB123) para facilitar a conferência no extrato.
            </div>
          </div>
        </div>
        <Card title="Pré-visualização" className="pix-preview">
          <div className="stack">
            <Field label="Valor de teste"><MoneyInput value={testAmount} onChange={setTestAmount} /></Field>
            {preview ? (
              <PixQrView
                payload={preview}
                amountCents={testAmount ?? 0}
                merchantName={nameOut}
                size={220}
                note="Faça um teste: pague este valor com o seu celular e confira se o nome e a chave aparecem certos no app do banco."
              />
            ) : (
              <Empty icon={<QrCode size={36} />} title="Preencha a chave, o nome e a cidade">O QR Code de teste aparece aqui.</Empty>
            )}
            {preview && !f.enabled && <div className="banner small">O Pix está desligado: ative a opção e salve para usar no caixa e na conta impressa.</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}
