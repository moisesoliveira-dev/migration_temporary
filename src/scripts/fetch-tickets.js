import { createGosacClient } from '../gosac/client.js';

/**
 * Lista tickets do Gosac (primeira página ou paginação completa).
 *
 * Uso:
 *   node src/scripts/fetch-tickets.js
 *   node src/scripts/fetch-tickets.js --all
 *   node src/scripts/fetch-tickets.js --status open --search "nome"
 */
async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const statusIdx = args.indexOf('--status');
  const searchIdx = args.indexOf('--search');

  const params = {};
  if (statusIdx !== -1 && args[statusIdx + 1]) params.status = args[statusIdx + 1];
  if (searchIdx !== -1 && args[searchIdx + 1]) params.searchParam = args[searchIdx + 1];

  const gosac = createGosacClient();

  if (all) {
    const tickets = await gosac.getAllTickets(params, (page, batch) => {
      console.log(`Página ${page}: ${batch.length} ticket(s)`);
    });
    console.log(`Total: ${tickets.length} ticket(s)`);
    console.log(JSON.stringify(tickets.slice(0, 3), null, 2));
    if (tickets.length > 3) console.log(`... (+${tickets.length - 3} omitidos no log)`);
    return;
  }

  const { tickets, count, hasMore } = await gosac.getTickets(params);
  console.log(`Tickets: ${tickets.length} | count: ${count} | hasMore: ${hasMore}`);
  console.log(JSON.stringify(tickets, null, 2));
}

main().catch((error) => {
  console.error('Erro ao buscar tickets:', error.response?.data || error.message);
  process.exit(1);
});
