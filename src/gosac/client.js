import axios from 'axios';
import { config } from '../config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  const status = error.response?.status;
  return (
    error.code === 'ECONNABORTED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    status === 429 ||
    status >= 500
  );
}

async function withRetry(label, request) {
  let lastError;

  for (let attempt = 1; attempt <= config.gosac.retries; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.gosac.retries) break;

      const waitMs = config.gosac.retryDelayMs * attempt;
      console.warn(`${label}: tentativa ${attempt} falhou (${error.message}); retry em ${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

/**
 * Cliente HTTP do Gosac.
 * Auth: header Authorization: `INTEGRATION ${API_KEY}`
 * (mesmo padrão usado em relatorios_automaticos_backend/src/gosac/gosac.service.ts)
 */
export function createGosacClient() {
  const client = axios.create({
    baseURL: `${config.gosac.baseUrl}/api`,
    headers: {
      Authorization: `INTEGRATION ${config.gosac.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: config.gosac.timeoutMs,
  });

  return {
    /**
     * GET /tickets
     * @param {object} [params]
     * @returns {Promise<{ tickets: object[], hasMore?: boolean, count?: number }>}
     */
    async getTickets(params = {}) {
      const response = await withRetry(`GET /tickets page=${params.pageNumber || 1}`, () =>
        client.get('/tickets', {
          params: {
            pageNumber: 1,
            order: 'desc',
            showAll: true,
            viewGroups: true,
            ...params,
          },
        }),
      );

      const data = response.data;
      const tickets = Array.isArray(data) ? data : data?.tickets || [];

      return {
        tickets,
        hasMore: Boolean(data?.hasMore),
        count: data?.count ?? tickets.length,
        raw: data,
      };
    },

    /**
     * GET /messages/:ticketId
     * @param {number|string} ticketId
     * @param {object} [params]
     * @returns {Promise<{ count: number, messages: object[] }>}
     */
    async getMessages(ticketId, params = {}) {
      const response = await withRetry(`GET /messages/${ticketId}`, () =>
        client.get(`/messages/${ticketId}`, { params }),
      );
      const data = response.data;

      return {
        count: data?.count ?? (data?.messages?.length || 0),
        messages: data?.messages || (Array.isArray(data) ? data : []),
        raw: data,
      };
    },

    /**
     * Busca TODAS as mensagens acessíveis via um ticket, paginando até hasMore=false.
     * Atenção: a API devolve o histórico completo do CONTATO do ticket
     * (mensagens de todos os tickets desse contato), em ordem decrescente.
     * @param {number|string} ticketId
     * @param {object} [params] aceita pageDelayMs para pausa entre páginas
     * @param {(page: number, messages: object[], count: number) => void} [onPage]
     * @returns {Promise<{ messages: object[], count: number, ticket?: object }>}
     */
    async getAllMessages(ticketId, params = {}, onPage) {
      const { pageDelayMs = 0, ...queryParams } = params;
      const all = [];
      let pageNumber = Number(queryParams.pageNumber) || 1;
      let hasMore = true;
      let ticketInfo;
      let totalCount = 0;

      while (hasMore) {
        const { messages, count, raw } = await this.getMessages(ticketId, {
          ...queryParams,
          pageNumber,
        });

        ticketInfo = ticketInfo || raw?.ticket;
        totalCount = count || totalCount;
        all.push(...messages);
        if (onPage) onPage(pageNumber, messages, totalCount);

        hasMore = Boolean(raw?.hasMore) && messages.length > 0;
        pageNumber += 1;

        if (hasMore && pageDelayMs > 0) await sleep(pageDelayMs);
      }

      return { messages: all, count: totalCount, ticket: ticketInfo };
    },

    /**
     * Busca todos os tickets paginando enquanto hasMore for true.
     * @param {object} [params]
     * @param {(page: number, tickets: object[]) => void} [onPage]
     */
    async getAllTickets(params = {}, onPage) {
      const all = [];
      let pageNumber = Number(params.pageNumber) || 1;
      let hasMore = true;

      while (hasMore) {
        const { tickets, hasMore: more } = await this.getTickets({
          ...params,
          pageNumber,
        });

        all.push(...tickets);
        if (onPage) onPage(pageNumber, tickets);

        hasMore = more && tickets.length > 0;
        pageNumber += 1;

        // segurança: se a API não enviar hasMore, para após a primeira página vazia
        if (!more && tickets.length === 0) break;
        if (params.maxPages && pageNumber > params.maxPages) break;
      }

      return all;
    },
  };
}
