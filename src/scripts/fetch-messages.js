import { createGosacClient } from '../gosac/client.js';

/**
 * Busca mensagens de um ticket Gosac.
 *
 * Uso:
 *   node src/scripts/fetch-messages.js <ticketId>
 */
async function main() {
  const ticketId = process.argv[2];
  if (!ticketId) {
    console.error('Uso: node src/scripts/fetch-messages.js <ticketId>');
    process.exit(1);
  }

  const gosac = createGosacClient();
  const { count, messages } = await gosac.getMessages(ticketId);

  console.log(`Ticket #${ticketId}: ${count} mensagem(ns)`);
  for (const msg of messages) {
    const who = msg.fromMe ? 'EU' : msg.contact?.name || msg.contactId;
    console.log(`[${msg.createdAt}] (${who}) ${msg.body ?? `[${msg.mediaType || msg.kind}]`}`);
  }
}

main().catch((error) => {
  console.error('Erro ao buscar mensagens:', error.response?.data || error.message);
  process.exit(1);
});
