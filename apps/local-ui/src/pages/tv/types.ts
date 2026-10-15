import type { TvDisplaySettings } from '@rupbar/core/schemas';

export type { TvDisplaySettings };

/** Pedido no painel: nome curto do cliente é o destaque; o número do pedido é secundário. */
export interface TvEntry {
  number: number;
  name: string;
  displayName: string;
  /** Número do cartão/comanda que o cliente conhece (null em venda rápida). */
  comandaDisplayNumber: number | null;
}

export interface TvReadyEntry extends TvEntry {
  readyAt: string | null;
  calledAt: string | null;
}

export interface TvMediaItem {
  id: string;
  kind: 'image' | 'video';
  mime: string;
  title: string;
  durationSeconds: number;
  url: string;
}

export interface TvBoard {
  branding: { tradeName: string; initials: string; primaryColor: string; secondaryColor: string; logoUrl: string | null; coverUrl: string | null };
  preparing: TvEntry[];
  ready: TvReadyEntry[];
  voice: boolean;
  serverTts: boolean;
  serverTime?: string;
  pickupPlace?: string;
  display?: TvDisplaySettings;
  media?: TvMediaItem[];
}

export interface TvCall {
  callId: string;
  ticketId?: string | null;
  number: number;
  customerFirstName: string;
  customerDisplayName?: string;
  comandaDisplayNumber?: number | null;
  text: string;
  voice: boolean;
  /** Chamada de teste disparada em Configurações → TV. */
  test?: boolean;
}

/** Padrões usados até o painel chegar (iguais aos do servidor). */
export const DEFAULT_DISPLAY: TvDisplaySettings = {
  volume: 100,
  chimeRepeat: 2,
  callRepeat: 1,
  adsMode: 'off',
  boardSeconds: 20,
  adsSeconds: 30,
  boardAfterCallSeconds: 20,
  readyTicker: true,
  videoSound: false,
  videoVolume: 60,
  readyMinutes: 10,
};
