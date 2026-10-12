/** Erro de negócio com código estável (a interface traduz/age pelo código). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Faça login para continuar.', code = 'UNAUTHENTICATED') => new AppError(401, code, message);
export const forbidden = (message = 'Você não tem permissão para esta ação.', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (what = 'Registro') => new AppError(404, 'NOT_FOUND', `${what} não encontrado.`);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) => new AppError(409, code, message, details);
export const staleVersion = () =>
  new AppError(409, 'STALE_VERSION', 'Esta comanda foi alterada por outra pessoa. Atualize e tente novamente.');
