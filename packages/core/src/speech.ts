/** Números por extenso em português do Brasil para o anúncio de voz da TV. */

const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const TEENS = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function below1000(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(HUNDREDS[h]!);
  if (rest > 0) {
    if (rest < 10) parts.push(UNITS[rest]!);
    else if (rest < 20) parts.push(TEENS[rest - 10]!);
    else {
      const t = Math.floor(rest / 10);
      const u = rest % 10;
      parts.push(u === 0 ? TENS[t]! : `${TENS[t]} e ${UNITS[u]}`);
    }
  }
  return parts.join(' e ');
}

export function numberToWordsPtBR(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n === 0) return 'zero';
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (thousands > 0) parts.push(thousands === 1 ? 'mil' : `${below1000(thousands)} mil`);
  if (rest > 0) {
    // "mil e cem", "mil e vinte", mas "mil duzentos e trinta"
    const joiner = thousands > 0 && (rest < 100 || rest % 100 === 0) ? ' e ' : ' ';
    return parts.length ? parts[0] + joiner + below1000(rest) : below1000(rest);
  }
  return parts.join(' ');
}

/**
 * Texto falado na TV quando o pedido fica pronto.
 *  - com nome e comanda: "Carlos, comanda vinte e três. Seu pedido está pronto, retirar no balcão."
 *  - só nome (venda rápida): "Carlos, seu pedido está pronto. Retirar no balcão."
 *  - sem nome: "Pedido número quarenta e dois. Retirar no balcão."
 */
export function pickupAnnouncement(
  orderNumber: number,
  customerFirstName: string | null,
  place = 'no balcão',
  comandaNumber: number | null = null,
): string {
  const name = customerFirstName?.trim();
  if (name && comandaNumber) return `${name}, comanda ${numberToWordsPtBR(comandaNumber)}. Seu pedido está pronto, retirar ${place}.`;
  if (name) return `${name}, seu pedido está pronto. Retirar ${place}.`;
  if (comandaNumber) return `Comanda ${numberToWordsPtBR(comandaNumber)}, seu pedido está pronto. Retirar ${place}.`;
  return `Pedido número ${numberToWordsPtBR(orderNumber)}. Retirar ${place}.`;
}
