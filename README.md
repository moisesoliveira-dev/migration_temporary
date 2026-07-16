# Migração Gosac → CouchDB

Scripts Node.js para ler tickets/mensagens do **Gosac** e gravar no **CouchDB**.

## Conexão Gosac

Mesmo padrão do backend (`relatorios_automaticos_backend/src/gosac/gosac.service.ts`):

- Base URL + path `/api`
- Header: `Authorization: INTEGRATION <GOSAC_API_KEY>`

Rotas usadas:

| Método | Rota | Uso |
|--------|------|-----|
| GET | `/api/tickets` | listar conversas |
| GET | `/api/messages/:ticketId` | histórico do **contato** do ticket (paginado, 20 por página) |

> Importante: `/api/messages/:ticketId` devolve o histórico completo do **contato**
> (mensagens de todos os tickets dele), não só do ticket informado. Por isso a
> migração agrupa por contato e pagina até `hasMore=false`.

> Este projeto tem `.env` próprio. Não reutilize o `.env` dos outros repos.

## Setup

```bash
cd migration_councDB
cp .env.example .env
# edite GOSAC_API_KEY, COUCHDB_URL, COUCHDB_DATABASE
npm install
```

## Scripts

```bash
# listar tickets (1ª página)
npm run fetch:tickets

# todas as páginas
node src/scripts/fetch-tickets.js --all

# mensagens de um ticket (1ª página)
npm run fetch:messages -- 38902

# migrar o histórico completo do contato de um ticket
npm run migrate:ticket -- 38902

# idem, mas gravando só as mensagens daquele ticket
npm run migrate:ticket -- 38902 --only-ticket

# migrar tudo (todos os contatos, todas as mensagens)
npm run migrate

# zerar checkpoint local e recomeçar (ex.: após recriar o banco CouchDB)
npm run migrate -- --reset

# testar com poucos contatos
npm run migrate -- --max-contacts 3
```

Opções de `migrate`:

| Flag | Padrão | Descrição |
|------|--------|-----------|
| `--reset` | off | Zera o checkpoint local (`.migration-state.json`) |
| `--delay` | `500` | Pausa (ms) entre contatos |
| `--page-delay` | `300` | Pausa (ms) entre páginas (tickets e mensagens) |
| `--message-delay` | `20` | Pausa (ms) entre gravações no CouchDB |
| `--status` | — | Filtrar tickets por status |
| `--max-contacts` | todos | Limitar quantidade de contatos |

## Como a migração funciona

1. Lista tickets página a página.
2. Para cada ticket, identifica o **contato** — se já foi processado, pula.
3. Busca o histórico completo do contato (`/messages/:ticketId` paginado até `hasMore=false`).
4. Remove duplicatas, ordena por `createdAt` e grava mensagem a mensagem no CouchDB.
5. Só marca o contato como concluído no checkpoint se **nenhuma** mensagem falhou.

## Retomada segura

A **única fonte de verdade** de “já enviada” é o **CouchDB**:

- se `_id = msg:<id>` existir → `ja_no_couch` (não regrava);
- se não existir → grava e só conta `novas` após o CouchDB aceitar.

O arquivo `.migration-state.json` guarda apenas os **contatos concluídos** (para não re-baixar históricos inteiros à toa). Se a execução cair (`Ctrl+C`, timeout), rode o mesmo comando de novo.

Se recriar o banco no CouchDB, zere o checkpoint local:

```bash
npm run migrate -- --reset
```

Configurações opcionais no `.env`:

```bash
GOSAC_TIMEOUT_MS=120000
GOSAC_RETRIES=3
GOSAC_RETRY_DELAY_MS=2000
```

## Deploy no Railway

Este projeto é um **job one-shot** (roda a migração e termina). O `railway.json` já define:

- `startCommand`: `node src/scripts/migrate.js`
- `restartPolicyType`: `NEVER` (não reinicia em loop)

### 1. Subir o código

Opção A — GitHub (recomendado):

```bash
git init   # se ainda não for um repo
git add .
git commit -m "Prepare migration for Railway"
# crie o repo no GitHub e faça push
```

No [Railway](https://railway.app): **New Project → Deploy from GitHub repo** → selecione este repositório.

Opção B — CLI:

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

### 2. Variáveis de ambiente

No serviço → **Variables**, adicione (não use o `.env` local):

| Variável | Exemplo |
|----------|---------|
| `GOSAC_BASE_URL` | `https://cmmodulados.gosac.com.br` |
| `GOSAC_API_KEY` | sua chave |
| `COUCHDB_URL` | `https://admin:SENHA@couchdb.servidorcm.cloud` |
| `COUCHDB_DATABASE` | `gosac_geral` |
| `GOSAC_TIMEOUT_MS` | `120000` (opcional) |
| `GOSAC_RETRIES` | `3` (opcional) |
| `GOSAC_RETRY_DELAY_MS` | `2000` (opcional) |

Se a senha do CouchDB tiver caracteres especiais (`@`, `#`, `:`…), **URL-encode** na `COUCHDB_URL`. Ex.: `@` → `%40`.

### 3. Configuração do serviço

Em **Settings → Deploy**:

- Start Command: `node src/scripts/migrate.js` (já vem do `railway.json`)
- Restart Policy: **Never**
- **Não** gere domínio público — não é uma API web

### 4. Rodar / acompanhar

Cada deploy dispara a migração. Acompanhe em **Deployments → Logs**.

Para forçar uma nova execução: **Redeploy**.

Para testar com poucos contatos, sobrescreva o Start Command:

```bash
node src/scripts/migrate.js --max-contacts 3
```

### 5. Observações importantes

- A migração pode levar **horas**. Confira o limite de tempo do seu plano Railway.
- O disco do container é efêmero: o `.migration-state.json` some entre deploys. A retomada segura das mensagens continua via **CouchDB** (`ja_no_couch`). Se quiser preservar o checkpoint de contatos, anexe um **Volume** em `/app` (ou defina `MIGRATION_STATE_FILE=/data/.migration-state.json` e monte o volume em `/data`).
- O CouchDB precisa ser acessível da internet (ou da rede do Railway). `localhost` não funciona lá.

## Documento no CouchDB

Cada mensagem vira um doc com `_id = msg:<uuid-gosac>`, campos principais (`body`, `fromMe`, `ticketId`, `contact`, datas) e `raw` com o payload original.
